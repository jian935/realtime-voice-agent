// 零依赖 Node 服务：静态托管 public/ + 为浏览器签发 Realtime token
//  + 代理国内大模型（OpenAI 兼容）的流式对话，支持「工具调用 / RAG 知识库」
//  + 签发 MiniMax Realtime token（国内真时双向语音）
//
// 环境变量：
//   OPENAI_API_KEY       走 OpenAI Realtime 真时双向模式时需要
//   REALTIME_MODEL       OpenAI Realtime 模型名（默认 gpt-4o-realtime-preview-2025-06-03）
//   DOMESTIC_LLM_KEY     国内大模型密钥（默认走 DeepSeek）
//   DOMESTIC_LLM_BASE    国内大模型兼容端点 base（默认 https://api.deepseek.com/v1）
//   DOMESTIC_LLM_MODEL   国内大模型名（默认 deepseek-chat）
//   MINIMAX_GROUP_ID     MiniMax 组 ID（真时双向语音需要）
//   MINIMAX_API_KEY      MiniMax API Key（真时双向语音需要）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const REALTIME_MODEL = process.env.REALTIME_MODEL || 'gpt-4o-realtime-preview-2025-06-03';
const DOMESTIC_BASE = (process.env.DOMESTIC_LLM_BASE || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const DOMESTIC_MODEL = process.env.DOMESTIC_LLM_MODEL || 'deepseek-chat';

// 国内大模型服务商预设（与前端「设置 → 国内大模型服务商」下拉一一对应）。
// 前端只传 provider 名，Base URL / 模型由服务端决定，避免任意 URL 注入。
const PROVIDER_PRESETS = {
  deepseek: { base: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  zhipu:    { base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  qwen:     { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  doubao:   { base: 'https://ark.cn-beijing.volces.com/api/v3', model: 'doubao-pro-32k' }
};
const MINIMAX_GROUP_ID = process.env.MINIMAX_GROUP_ID || '';
const MINIMAX_API_KEY = process.env.MINIMAX_API_KEY || '';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// 读取请求体 JSON（失败/空返回 {}）。用于从前端接收"可选密钥"：
// 浏览器把用户在点选模式时填入的 Key 只发到本地服务，由服务端用它去调厂商，绝不直接暴露给第三方。
async function readJson(req) {
  try {
    let b = '';
    for await (const c of req) b += c;
    return b ? JSON.parse(b) : {};
  } catch { return {}; }
}

// ---------- 工具调用定义（服务端，OpenAI 兼容格式） ----------
const TOOLS = [
  { type: 'function', function: { name: 'calculator', description: '对数学表达式求值，例如 "23 * 45 + 12"。仅支持 + - * / 与括号。', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] } } },
  { type: 'function', function: { name: 'get_datetime', description: '获取当前的日期与时间（中国时区）。', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_weather', description: '查询某城市当前天气（演示为模拟数据）。', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } },
  { type: 'function', function: { name: 'web_search', description: '联网检索公开信息（演示为模拟结果，用于展示 Agent 的工具编排能力）。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }
];

function runTool(name, args) {
  try {
    if (name === 'calculator') {
      const expr = String(args?.expression || '');
      if (!/^[0-9+\-*/().\s]+$/.test(expr)) return '表达式含不支持的字符';
      const val = Function('"use strict";return (' + expr + ')')();
      return String(val);
    }
    if (name === 'get_datetime') return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    if (name === 'get_weather') return `（模拟）${args?.city || '该'}：多云转晴，22℃，东南风 3 级，湿度 58%。`;
    if (name === 'web_search') return `（模拟检索）关于「${args?.query || ''}」的公开信息：这是一段用于演示工具编排的占位结果，真实接入时可替换为搜索引擎 API。`;
    return '未知工具';
  } catch (e) { return '工具执行出错：' + e.message; }
}

// ---------- 极简 TF-IDF 检索（无依赖，用于 RAG 知识库） ----------
function tokenize(text) {
  // 中文按字符 n-gram 粗分 + 英文按词，足够做 demo 级相似度
  const en = (text.toLowerCase().match(/[a-z0-9]+/g) || []);
  const zh = (text.match(/[一-龥]/g) || []);
  return en.concat(zh);
}
function buildIndex(chunks) {
  const df = new Map();
  const docs = chunks.map((c) => {
    const t = tokenize(c);
    const tf = new Map();
    t.forEach((w) => tf.set(w, (tf.get(w) || 0) + 1));
    tf.forEach((_, w) => df.set(w, (df.get(w) || 0) + 1));
    return tf;
  });
  return { chunks, docs, df, N: chunks.length };
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  a.forEach((v, k) => { na += v * v; const vb = b.get(k) || 0; dot += v * vb; });
  b.forEach((v) => { nb += v * v; });
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
function retrieve(index, query, topK = 3) {
  const qt = tokenize(query);
  const idf = new Map();
  index.df.forEach((d, w) => idf.set(w, Math.log((index.N + 1) / (d + 0.5)) + 1));
  const qv = new Map();
  qt.forEach((w) => qv.set(w, (qv.get(w) || 0) + 1));
  qv.forEach((c, w) => qv.set(w, (c * (idf.get(w) || 1))));
  const scored = index.docs.map((tf, i) => {
    const tv = new Map();
    tf.forEach((c, w) => tv.set(w, (c * (idf.get(w) || 1))));
    return { i, s: cosine(tv, qv) };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, topK);
  return scored.map((x) => index.chunks[x.i]);
}

// ---------- SSE 信封转发：把上游 OpenAI 流式响应转成自定义信封 ----------
async function pipeEnvelope(upstream, res, onContent) {
  res.write('data: ' + JSON.stringify({ c: '' }) + '\n\n'); // 占位，便于前端立刻进入流式态
  // 注意：fetch 的 body chunk 是 Uint8Array，chunk.toString() 得到的是十进制字节串
  // （"100,97,116,97..."）而不是文本，会导致永远解析不到 data: 行 → 前端「(无返回)」。
  // 必须用 TextDecoder 解码，并用 stream:true 处理跨 chunk 的多字节字符。
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of upstream.body) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '' || d === '[DONE]') continue;
      try {
        const j = JSON.parse(d);
        const c = j.choices?.[0]?.delta?.content;
        if (c) { res.write('data: ' + JSON.stringify({ c }) + '\n\n'); if (onContent) onContent(); }
      } catch (_) { /* 不完整分片 */ }
    }
  }
}

function sseHeaders(res) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  // 配置：前端据此决定哪些模式/能力可用
  if (p === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      openai: !!process.env.OPENAI_API_KEY,
      domestic: !!process.env.DOMESTIC_LLM_KEY,
      minimax: !!(MINIMAX_GROUP_ID && MINIMAX_API_KEY),
      features: { tools: true, rag: true }
    }));
    return;
  }

  // OpenAI Realtime ephemeral token（可选：页面点击「OpenAI 实时」直接填入 Key，由本地服务签发临时令牌）
  if (p === '/api/token' && req.method === 'POST') {
    const body = await readJson(req);
    const key = (body.apiKey && String(body.apiKey).trim()) || process.env.OPENAI_API_KEY;
    if (!key) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '未提供 OpenAI API Key：可在页面点击「OpenAI 实时」直接填入，或在启动服务前 export OPENAI_API_KEY=sk-...' })); return; }
    try {
      const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: { type: 'realtime', model: REALTIME_MODEL } })
      });
      const data = await r.json();
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })); }
    return;
  }

  // MiniMax Realtime token（HMAC-SHA256 签名，详见 MiniMax 文档）
  // 可选：页面点击「MiniMax 真时」直接填入 Group ID + API Key，由本地服务签发 token
  if (p === '/api/minimax-token' && req.method === 'POST') {
    const body = await readJson(req);
    const gid = (body.groupId && String(body.groupId).trim()) || MINIMAX_GROUP_ID;
    const key = (body.apiKey && String(body.apiKey).trim()) || MINIMAX_API_KEY;
    if (!gid || !key) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '未提供 MiniMax 凭据：可在页面点击「MiniMax 真时」填入 Group ID 与 API Key，或在启动服务前 export MINIMAX_GROUP_ID / MINIMAX_API_KEY' })); return; }
    try {
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const raw = `${gid}.${exp}`;
      const sig = crypto.createHmac('sha256', key).update(raw).digest('hex');
      const token = Buffer.from(`${raw}.${sig}`).toString('base64url');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ token, groupId: gid }));
    } catch (e) { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })); }
    return;
  }

  // 国内大模型流式对话代理（含工具调用 / RAG）
  // 支持从请求体接收可选 apiKey：页面点击「国内大模型」填入的 DeepSeek Key 只发到本地服务
  if (p === '/api/chat' && req.method === 'POST') {
    const payload = await readJson(req);
    const key = (payload.apiKey && String(payload.apiKey).trim()) || process.env.DOMESTIC_LLM_KEY;
    if (!key) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: '未提供密钥：可在页面点击「国内大模型」填入对应服务商的 API Key（仅发往本地服务，不会外泄），或在启动服务前 export DOMESTIC_LLM_KEY=...' })); return; }

    // 服务商 / 自定义端点路由：前端只传 provider，Base URL 与模型由服务端预设决定
    const provider = String(payload.provider || '').trim();
    let base = DOMESTIC_BASE, model = DOMESTIC_MODEL;
    if (provider && PROVIDER_PRESETS[provider]) { base = PROVIDER_PRESETS[provider].base; model = PROVIDER_PRESETS[provider].model; }
    // 自定义：允许覆盖 Base URL（仅接受 http/https，防误用）与模型名
    if (payload.base && /^https?:\/\//i.test(String(payload.base))) base = String(payload.base).replace(/\/+$/, '');
    if (payload.model && String(payload.model).trim()) model = String(payload.model).trim();

    const useTools = !!payload.tools;
    const useRag = !!payload.useRag && payload.knowledge && String(payload.knowledge).trim().length > 0;
    let messages = Array.isArray(payload.messages) ? payload.messages.map((m) => ({ role: m.role, content: m.content })) : [];

    // RAG：在 system 之后注入检索到的知识
    if (useRag) {
      const chunks = String(payload.knowledge).split(/\n{2,}|(?<=。|！|？)/).map((s) => s.trim()).filter((s) => s.length > 4);
      if (chunks.length) {
        const idx = buildIndex(chunks);
        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const top = retrieve(idx, lastUser ? lastUser.content : '', 3);
        const ctx = top.join('\n');
        const sysIdx = messages.findIndex((m) => m.role === 'system');
        const note = `\n\n【知识库检索结果（用户上传资料，优先依据回答）】\n${ctx}`;
        if (sysIdx >= 0) messages[sysIdx].content += note; else messages.unshift({ role: 'system', content: note.trim() });
      }
    }

    try {
      const doCall = async (msgs, stream) => fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: msgs, temperature: payload.temperature ?? 0.8, stream, ...(useTools ? { tools: TOOLS, tool_choice: 'auto' } : {}) })
      });

      // 工具调用：先非流式探测 tool_calls，再执行、再流式输出最终回答
      if (useTools) {
        const probe = await doCall(messages, false);
        if (!probe.ok) { const txt = await probe.text().catch(() => probe.statusText); res.writeHead(probe.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: txt })); return; }
        const pj = await probe.json();
        const msg = pj.choices?.[0]?.message;
        const calls = msg?.tool_calls;
        if (calls && calls.length) {
          sseHeaders(res);
          messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
          for (const call of calls) {
            const fn = call.function;
            let args = {}; try { args = JSON.parse(fn.arguments || '{}'); } catch (_) {}
            const result = runTool(fn.name, args);
            res.write('data: ' + JSON.stringify({ tool: { name: fn.name, args, result } }) + '\n\n');
            messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
          }
          // 第二轮：流式输出最终答案
          const finalUp = await doCall(messages, true);
          if (!finalUp.ok) { res.write('data: ' + JSON.stringify({ c: '（工具结果已返回，但模型最终回答失败）' }) + '\n\n'); res.write('data: [DONE]\n\n'); res.end(); return; }
          await pipeEnvelope(finalUp, res);
          res.write('data: [DONE]\n\n'); res.end(); return;
        }
        // 无工具调用：直接把非流式结果当作一次性流式块返回
        sseHeaders(res);
        res.write('data: ' + JSON.stringify({ c: msg?.content || '' }) + '\n\n');
        res.write('data: [DONE]\n\n'); res.end(); return;
      }

      // 普通流式
      const up = await doCall(messages, true);
      if (!up.ok) { const txt = await up.text().catch(() => up.statusText); res.writeHead(up.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: txt })); return; }
      // 部分厂商在余额不足/参数错误时仍返回 HTTP 200 + JSON（而非 SSE），此时必须把错误透出，
      // 否则前端会一直拿到空流、表现为「(无返回)」。
      const ctype = (up.headers.get('content-type') || '').toLowerCase();
      if (ctype.includes('application/json')) {
        const txt = await up.text().catch(() => '');
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: txt || '上游返回了非流式响应（非 SSE）' }));
        return;
      }
      sseHeaders(res);
      req.on('close', () => { try { up.body?.destroy?.(); } catch (_) {} });
      await pipeEnvelope(up, res);
      res.write('data: [DONE]\n\n'); res.end();
    } catch (e) {
      if (res.headersSent) { try { res.write('data: [DONE]\n\n'); } catch (_) {} }
      else { res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e) })); }
    }
    return;
  }

  // 静态文件
  let urlPath = decodeURIComponent(url.pathname);
  if (urlPath === '/') urlPath = '/landing.html';
  const filePath = path.join(PUBLIC, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    // 开发期禁用缓存：每次请求都返回磁盘最新文件，避免浏览器/SW 缓存旧版 app.js 等
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream', 'cache-control': 'no-cache, no-store, must-revalidate' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`Voice Agent 已启动: http://localhost:${PORT}`);
  console.log(`可用模式：模拟（免密钥）/ 国内大模型（需 DOMESTIC_LLM_KEY）/ OpenAI 实时 / MiniMax 真时双向`);
});
