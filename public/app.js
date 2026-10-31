// 实时语音 Agent 前端逻辑
// 模式：
//  - sim      ：浏览器 Web Speech API（STT+TTS），无需密钥，演示完整语音闭环
//  - domestic ：浏览器端语音识别/合成 + 国内大模型（OpenAI 兼容）流式对话，可启用工具调用 / RAG / 多智能体 / 双语字幕
//  - openai   ：OpenAI Realtime API，真·双向实时语音（需后端 ephemeral token + 麦克风）
//  - minimax  ：MiniMax Realtime，国内真·双向实时语音（需后端 token + 麦克风 + 网络）
//
// 本脚本同时被 demo.html 引入。着陆页(landing.html)不含这些元素，相关绑定需 null 安全。

function bind(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

const $ = (s) => document.querySelector(s);
const MODEL = 'gpt-4o-realtime-preview-2025-06-03';

const SCENARIOS = {
  interview: {
    name: '模拟面试官',
    system: '你是一位严谨但友善的技术产品经理面试官，用中文、简短（每轮不超过 3 句）地追问候选人的项目经历、产品判断与数据分析能力。先抛一个开放问题。',
    simReplies: [
      '先聊聊你最近做过的一个项目，你当时是怎么定义用户问题的？',
      '如果这个功能上线后数据没涨，你会怎么拆解原因？',
      '你刚才提到用 AI 提效，具体是哪个环节，省下了多少时间？',
      '假如资源只够做一件事，你会优先做哪块，为什么？'
    ]
  },
  language: {
    name: '外语陪练',
    system: 'You are a friendly English speaking partner. Keep replies short (1-2 sentences), correct the user’s grammar gently, and ask a follow-up question. Speak in English.',
    simReplies: [
      { en: "Nice! Can you tell me what you did last weekend? I'll help if anything sounds off.", cn: '太棒了！能跟我说说你上周末做了什么吗？有说得不太对的地方我会帮你纠正。' },
      { en: 'Good job. Try saying it in past tense — what did you enjoy most?', cn: '做得好。试着用过去时来说——你最喜欢的是哪一部分？' },
      { en: 'Well done. Now ask me a question about my hobbies, in English.', cn: '完成得不错。现在请用英语问我一个关于我爱好的问题吧。' },
      { en: "That's a great point. How would you describe it to a beginner?", cn: '这个观点很好。你会怎么向一个初学者描述它呢？' },
      { en: 'Sure! Let’s practice. Could you repeat that sentence a bit slower?', cn: '没问题！我们来练习一下。你能把那句话慢一点再说一遍吗？' }
    ]
  },
  free: {
    name: '自由对话',
    system: '你是用户的智能语音助手，用中文自然、简洁地聊天并给出有用信息。',
    simReplies: [
      '好的，我听到了。你想接着聊点什么？',
      '这个想法挺有意思，能再多说一点你的顾虑吗？',
      '我理解你的意思了，要不要我帮你列几个下一步？'
    ]
  }
};

const settings = { temp: 0.8, voice: '', tools: false, rag: false, knowledge: '', multi: false, bilingual: false, provider: 'deepseek', customBase: '', customModel: '' };
try { const sv = localStorage.getItem('va_voice'); if (sv) settings.voice = sv; } catch (_) {}
try { const sp = localStorage.getItem('va_provider'); if (sp) settings.provider = sp; } catch (_) {}
try { settings.customBase = localStorage.getItem('va_provider_base') || ''; } catch (_) {}
try { settings.customModel = localStorage.getItem('va_provider_model') || ''; } catch (_) {}

// 国内大模型服务商预设（与 server.js 的 PROVIDER_PRESETS 保持一致）
const PROVIDERS = {
  deepseek: { label: 'DeepSeek（默认）', keyLabel: 'DeepSeek API Key' },
  zhipu:    { label: '智谱 GLM', keyLabel: '智谱 API Key' },
  qwen:     { label: '通义千问（阿里云百炼）', keyLabel: '百炼 API Key' },
  doubao:   { label: '豆包（火山方舟）', keyLabel: '方舟 API Key' },
  custom:   { label: '自定义（自填 Base URL）', keyLabel: 'API Key' }
};
function currentProvider() { return PROVIDERS[settings.provider] || PROVIDERS.deepseek; }
// 发给服务端的路由字段：provider 决定 Base/模型；自定义与豆包额外带 base/model
function providerPayload() {
  const p = settings.provider || 'deepseek';
  const out = { provider: p === 'custom' ? 'custom' : p };
  if (p === 'custom') { if (settings.customBase) out.base = settings.customBase; if (settings.customModel) out.model = settings.customModel; }
  else if (p === 'doubao' && settings.customModel) out.model = settings.customModel;
  return out;
}
// 每个服务商各自的 Key 槽位（换服务商不串 Key）
function domKeySlot(provider) { return provider === 'deepseek' ? 'va_k_domestic' : 'va_k_dom_' + provider; }

let mode = 'sim';
let scenario = 'interview';
let running = false;
let cfgCache = null;

const MODE_LABEL = { sim: '模拟', domestic: '国内', openai: '实时', minimax: 'MiniMax' };

// ---------- 主题（明暗） ----------
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const b = document.getElementById('themeToggle');
  if (b) b.textContent = t === 'dark' ? '☀ 亮色' : '🌙 暗色';
}
function initTheme() {
  let t = localStorage.getItem('va-theme');
  if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(t);
}
function toggleTheme() {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem('va-theme', t);
  applyTheme(t);
}

// ---------- 评测指标（B9）+ 转录导出（B11） ----------
const metrics = { rounds: 0, userTurns: 0, botTurns: 0, lat: [], charsIn: 0, charsOut: 0 };
let bilingualWarned = false;

function trackUserTurn(t) { metrics.rounds++; metrics.userTurns++; metrics.charsIn += (t || '').length; renderMetrics(); }
function trackBotTurn(t, lat) {
  if (t && t.length) { metrics.botTurns++; metrics.charsOut += t.length; }
  if (lat && lat > 0) metrics.lat.push(lat);
  renderMetrics();
}
function renderMetrics() {
  const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  set('mgRounds', metrics.rounds);
  set('mgUser', metrics.userTurns);
  set('mgBot', metrics.botTurns);
  set('mgLat', metrics.lat.length ? Math.round(metrics.lat.reduce((a, b) => a + b, 0) / metrics.lat.length) + ' ms' : '—');
  const inTok = Math.ceil(metrics.charsIn / 1.5), outTok = Math.ceil(metrics.charsOut / 1.5);
  set('mgTok', (inTok + outTok).toLocaleString());
  set('mgCost', '¥' + ((inTok / 1e6) * 1 + (outTok / 1e6) * 2).toFixed(4));
}
function resetMetrics() { metrics.rounds = metrics.userTurns = metrics.botTurns = metrics.charsIn = metrics.charsOut = 0; metrics.lat = []; renderMetrics(); }

function buildTranscript() {
  const box = document.getElementById('transcript');
  const lines = [];
  if (box) box.querySelectorAll('.msg').forEach((m) => {
    if (m.classList.contains('thinking')) return;
    const who = m.querySelector('.who');
    const roleTag = m.querySelector('.role-tag');
    let prefix = who ? who.textContent : (roleTag ? roleTag.textContent : (m.classList.contains('tool') ? '工具' : 'AI'));
    let text = m.textContent;
    text = text.replace(/中文：.*$/s, '').trim();
    lines.push(`**${prefix}**：${text}`);
  });
  return lines.join('\n');
}
function buildReport() {
  const out = [];
  out.push('# 实时语音 Agent · 评测报告');
  out.push('生成时间：' + new Date().toLocaleString('zh-CN'));
  out.push(`模式：${MODE_LABEL[mode]} · 场景：${SCENARIOS[scenario].name}`);
  out.push('');
  out.push('## 会话指标');
  out.push(`- 对话轮次：${metrics.rounds}`);
  out.push(`- 用户输入轮：${metrics.userTurns}`);
  out.push(`- AI 回复轮：${metrics.botTurns}`);
  out.push(`- 平均首包延迟：${metrics.lat.length ? Math.round(metrics.lat.reduce((a, b) => a + b, 0) / metrics.lat.length) + ' ms' : '—'}`);
  const inTok = Math.ceil(metrics.charsIn / 1.5), outTok = Math.ceil(metrics.charsOut / 1.5);
  out.push(`- 估算 Token（输入 ${inTok} / 输出 ${outTok}，总计 ${inTok + outTok}）`);
  out.push(`- 估算成本（DeepSeek 定价）：¥${((inTok / 1e6) * 1 + (outTok / 1e6) * 2).toFixed(4)}`);
  out.push('');
  out.push('## 对话转录');
  out.push(buildTranscript());
  return out.join('\n');
}
function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- 多智能体（B10）系统提示 ----------
function systemPrompt() {
  let base = SCENARIOS[scenario].system;
  if (settings.multi) {
    if (scenario === 'interview') {
      base = '你是模拟面试小组，包含两位角色：【HR】人力资源面试官（关注动机、沟通、团队协作）与【技术】技术/产品面试官（关注项目深度、数据分析、产品判断）。每轮请两位依次简短发言（每角色不超过 2 句），用【HR】和【技术】前缀明确区分。先由 HR 开场提问。';
    } else {
      base = '你代表一个由多位专家组成的团队作答。每轮用【角色名】前缀区分不同专家的观点（角色名不超过 6 字），每位专家发言简短。' + base;
    }
  }
  return base;
}
function roleClass(role, idx) {
  const r = String(role).toLowerCase();
  if (r.includes('hr') || r.includes('人力') || r.includes('招聘')) return 'role-hr';
  if (r.includes('技术') || r.includes('研发') || r.includes('工程')) return 'role-tech';
  return 'role-role' + (idx % 4);
}
function renderMultiAgent(textSpan, full) {
  const parent = textSpan.parentElement;
  textSpan.textContent = '';
  const re = /【([^】]{1,12})】([\s\S]*?)(?=【|$)/g;
  let m, idx = 0, any = false;
  while ((m = re.exec(full))) {
    any = true;
    const role = m[1], body = m[2].trim();
    const tag = document.createElement('span');
    tag.className = 'role-tag ' + roleClass(role, idx++);
    tag.textContent = role;
    textSpan.appendChild(tag);
    textSpan.appendChild(document.createTextNode(' ' + body + ' '));
  }
  if (!any) textSpan.textContent = full;
}

// ---------- 双语字幕（C14） ----------
async function translateCN(text) {
  try {
    const r = await fetch('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'system', content: '你是专业中英翻译，把用户内容准确翻译成中文，只输出译文，不要任何解释。' }, { role: 'user', content: text }], temperature: 0.2, ...providerPayload(), apiKey: enteredKeys.domestic || undefined })
    });
    if (!r.ok) return null;
    const reader = r.body.getReader(); const dec = new TextDecoder();
    let buf = '', out = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim(); if (d === '' || d === '[DONE]') continue;
        try { const j = JSON.parse(d); if (j.c) out += j.c; } catch (_) {}
      }
    }
    return out.trim();
  } catch (_) { return null; }
}
async function appendBilingual(botEl, text) {
  if (!(settings.bilingual && scenario === 'language')) return;
  if (!isModeConfigured('domestic')) {
    if (!bilingualWarned) { showBanner('「双语字幕」需要「国内大模型」密钥（DeepSeek 等）。请点击「国内大模型」填入密钥，或在启动服务前配置 DOMESTIC_LLM_KEY，也可关闭该开关。', 'warn'); bilingualWarned = true; }
    return;
  }
  const cn = await translateCN(text);
  if (cn) { const s = document.createElement('span'); s.className = 'sub-cn'; s.textContent = '中文：' + cn; botEl.appendChild(s); }
}

// ---------- 打断（C13） ----------
function bargeIn() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  if (mode === 'openai') { audioQueue = []; playing = false; }
  if (mode === 'minimax') {
    mxQueue = []; mxPlaying = false;
    if (mxWs && mxWs.readyState === 1) { try { mxWs.send(JSON.stringify({ type: 'stop' })); } catch (_) {} }
  }
  setStatus('已打断 · 你可以继续说');
}

// ---------- 通用 UI ----------
function showBanner(html, type = 'warn') {
  let b = document.getElementById('banner');
  if (!b) { b = document.createElement('div'); b.id = 'banner'; document.body.insertBefore(b, document.body.firstChild); }
  b.className = `banner ${type}`;
  b.innerHTML = html;
  if (b._hideTimer) clearTimeout(b._hideTimer);
  // 成功提示自动消失，避免长期占屏；警告/错误保留给用户看
  if (type === 'info') b._hideTimer = setTimeout(() => b.classList.add('hidden'), 4000);
}
function hideBanner() { const b = document.getElementById('banner'); if (b) b.classList.add('hidden'); }

// 密钥输入定义：点击未配置的模式时，弹出对应密钥框（Key 只发往服务端做代理，不落盘、不外泄第三方）
const KEY_FIELDS = {
  domestic: [{ id: 'km_domestic', label: 'DeepSeek API Key（sk-...）', type: 'password', store: 'domestic' }],
  openai:   [{ id: 'km_openai',   label: 'OpenAI API Key（sk-...）',   type: 'password', store: 'openai' }],
  minimax:  [
    { id: 'km_mx_gid', label: 'MiniMax Group ID', type: 'text',     store: 'minimaxGid' },
    { id: 'km_mx_key', label: 'MiniMax API Key',  type: 'password', store: 'minimaxKey' }
  ]
};
const KEY_TITLE = {
  domestic: '点击即可填入 DeepSeek API Key（仅发往本站服务端做代理，不落盘、不外泄第三方）',
  openai:   '点击即可填入 OpenAI API Key',
  minimax:  '点击即可填入 MiniMax Group ID 与 API Key'
};

function loadKeys() {
  try {
    // 当前服务商对应的 Key；deepseek 兼容旧键 va_k_domestic
    const dom = sessionStorage.getItem(domKeySlot(settings.provider)) || (settings.provider === 'deepseek' ? (sessionStorage.getItem('va_k_domestic') || '') : '');
    return {
      domestic: dom,
      openai: sessionStorage.getItem('va_k_openai') || '',
      minimaxGid: sessionStorage.getItem('va_k_mx_gid') || '',
      minimaxKey: sessionStorage.getItem('va_k_mx_key') || ''
    };
  } catch (_) { return { domestic: '', openai: '', minimaxGid: '', minimaxKey: '' }; }
}
let enteredKeys = loadKeys();

// 模式是否可用：服务端环境变量已配置，或用户在页面填过密钥
function isModeConfigured(m) {
  if (m === 'sim') return true;
  if (cfgCache) {
    if (m === 'domestic' && cfgCache.domestic) return true;
    if (m === 'openai' && cfgCache.openai) return true;
    if (m === 'minimax' && cfgCache.minimax) return true;
  }
  if (m === 'domestic' && enteredKeys.domestic) return true;
  if (m === 'openai' && enteredKeys.openai) return true;
  if (m === 'minimax' && enteredKeys.minimaxGid && enteredKeys.minimaxKey) return true;
  return false;
}

// 未配置的模式：保留可点状态，加 🔓「需密钥」提示；点击弹出密钥框（不再置灰锁定）
function refreshModeButtons() {
  ['domestic', 'openai', 'minimax'].forEach((m) => {
    const b = document.querySelector(`#modeSeg .seg-btn[data-mode="${m}"]`);
    if (!b) return;
    const ok = isModeConfigured(m);
    b.classList.toggle('need-key', !ok);
    b.title = ok ? '' : (KEY_TITLE[m] || '此模式需配置密钥');
    const hint = b.querySelector('.key-hint');
    if (!ok && !hint) {
      const s = document.createElement('span');
      s.className = 'key-hint';
      s.textContent = ' 🔓 需密钥';
      b.appendChild(s);
    } else if (ok && hint) { hint.remove(); }
  });
}

// 服务商下拉的附加输入（自定义 Base URL / 豆包接入点 ID）
function refreshProviderExtra() {
  const extra = document.getElementById('providerExtra');
  const baseInp = document.getElementById('setProvBase');
  const modelInp = document.getElementById('setProvModel');
  const hint = document.getElementById('providerHint');
  if (!extra) return;
  const p = settings.provider;
  const showBase = p === 'custom';
  const showModel = p === 'custom' || p === 'doubao';
  extra.hidden = !(showBase || showModel);
  if (baseInp) { baseInp.style.display = showBase ? '' : 'none'; baseInp.value = settings.customBase || ''; }
  if (modelInp) {
    modelInp.style.display = showModel ? '' : 'none';
    modelInp.value = settings.customModel || '';
    modelInp.placeholder = p === 'doubao' ? '接入点 ID（ep-...），留空用 doubao-pro-32k' : '模型名，如 qwen-plus';
  }
  if (hint) hint.textContent = p === 'doubao'
    ? '豆包需填火山方舟的接入点 ID（ep-...），Base URL 已内置。'
    : (p === 'custom' ? '自定义需填完整 Base URL（OpenAI 兼容）与模型名。' : '切换服务商后，请在模式栏点「国内大模型」重新填入该服务商的 Key。');
}

// ---------- 密钥输入弹窗 ----------
function showKeyModal(mode) {
  let ov = document.getElementById('keyModal');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'keyModal';
    ov.className = 'key-modal-overlay';
    ov.innerHTML =
      '<div class="key-modal">' +
        '<h3 id="kmTitle"></h3>' +
        '<p id="kmDesc" class="km-desc"></p>' +
        '<div id="kmFields" class="km-fields"></div>' +
        '<div class="km-actions">' +
          '<button id="kmCancel" class="ghost">取消</button>' +
          '<button id="kmSave" class="km-save">保存并使用</button>' +
        '</div>' +
        '<p class="km-note">密钥仅保存在本浏览器会话（sessionStorage），且只发往本站服务端做代理（不保存到磁盘）——不会直接发送给第三方；关闭标签页即清除。若想长期免填，可在启动服务前用环境变量设置（见 README）。</p>' +
      '</div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', (e) => { if (e.target === ov) closeKeyModal(); });
    bind(document.getElementById('kmCancel'), 'click', closeKeyModal);
    bind(document.getElementById('kmSave'), 'click', submitKeyModal);
  }
  const pv = currentProvider();
  const titles = {
    domestic: '填入 ' + pv.keyLabel,
    openai: '填入 OpenAI API Key',
    minimax: '填入 MiniMax 凭据'
  };
  const descs = {
    domestic: '当前服务商：' + pv.label + '。填入后仅本次会话可用，刷新页面需重新填入（或改用环境变量持久化）。换服务商请到「⚙ 设置 → 国内大模型服务商」切换，并重填对应 Key。',
    openai: 'OpenAI Realtime 真时双向语音。填入的 Key 仅用于本站服务端向 OpenAI 申请临时令牌，不会直连暴露。',
    minimax: 'MiniMax 真时双向语音，需要 Group ID 与 API Key 两项。'
  };
  document.getElementById('kmTitle').textContent = titles[mode] || '填入密钥';
  document.getElementById('kmDesc').textContent = descs[mode] || '';
  const fields = document.getElementById('kmFields');
  fields.innerHTML = '';
  (KEY_FIELDS[mode] || []).forEach((f) => {
    let label = f.label;
    if (mode === 'domestic' && f.store === 'domestic') label = pv.keyLabel + '（sk-...）';
    const wrap = document.createElement('label');
    wrap.className = 'km-field';
    wrap.innerHTML = '<span>' + escapeHtml(label) + '</span>';
    const inp = document.createElement('input');
    inp.type = f.type; inp.id = f.id; inp.value = enteredKeys[f.store] || '';
    inp.placeholder = label;
    wrap.appendChild(inp);
    fields.appendChild(wrap);
  });
  document.getElementById('kmSave').dataset.mode = mode;
  ov.classList.add('open');
  const first = fields.querySelector('input');
  if (first) first.focus();
}
function closeKeyModal() { const ov = document.getElementById('keyModal'); if (ov) ov.classList.remove('open'); }
function submitKeyModal() {
  const mode = document.getElementById('kmSave').dataset.mode;
  (KEY_FIELDS[mode] || []).forEach((f) => {
    const inp = document.getElementById(f.id);
    if (inp) enteredKeys[f.store] = inp.value.trim();
  });
  try {
    sessionStorage.setItem(domKeySlot(settings.provider), enteredKeys.domestic);
    sessionStorage.setItem('va_k_openai', enteredKeys.openai);
    sessionStorage.setItem('va_k_mx_gid', enteredKeys.minimaxGid);
    sessionStorage.setItem('va_k_mx_key', enteredKeys.minimaxKey);
  } catch (_) {}
  closeKeyModal();
  refreshModeButtons();
  if (isModeConfigured(mode)) { selectMode(mode); showBanner(`已启用「${MODE_LABEL[mode]}」模式，点麦克风或直接输入文字即可开始。`, 'info'); }
  else { showBanner('密钥不能为空，请重新填入。', 'warn'); }
}

async function initConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error('status ' + r.status);
    cfgCache = await r.json();
  } catch (_) {
    showBanner('无法连接服务端（<code>/api/config</code> 请求失败）。线上版本请稍后重试；本地运行请确认已 <code>npm start</code> 并用 <code>http://localhost:3000</code> 打开，<b>不要直接双击 HTML 文件</b>。模拟模式可正常使用。', 'warn');
  }
  refreshModeButtons();
}

function selectMode(m) {
  mode = m;
  document.querySelectorAll('#modeSeg .seg-btn').forEach((x) => x.classList.toggle('active', x.dataset.mode === m));
  const lbl = $('#mMode'); if (lbl) lbl.textContent = MODE_LABEL[m];
  if (running) stop();
  setStatus(`就绪 · ${MODE_LABEL[m]}模式`);
}

function setStatus(t) { const s = $('#status'); if (s) s.textContent = t; }
function now() { return performance.now(); }

function addMsg(role, text, cls = '') {
  const box = $('#transcript');
  if (!box) return null;
  const el = document.createElement('div');
  el.className = `msg ${role} ${cls}`;
  const who = role === 'user' ? '你' : (mode === 'sim' ? '模拟 Agent' : (mode === 'domestic' ? '国内大模型' : 'AI Agent'));
  el.innerHTML = `<span class="who">${who}</span>`;
  const span = document.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
  span.__msgEl = el; // 记住整条消息框，便于整条移除（否则只删内层 span 会留下空气泡）
  return span;
}

// 删除整条消息：addMsg 返回的是内层文字 span，这里回到消息框再移除
function removeMsg(span) {
  const el = span && (span.__msgEl || span.parentElement);
  if (el && el.parentElement) el.remove();
}

function addToolMsg(info) {
  const box = $('#transcript');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'msg tool';
  const args = info.args && Object.keys(info.args).length ? JSON.stringify(info.args) : '';
  el.innerHTML = `<span class="who">🔧 工具调用</span><span>调用 <b>${info.name}</b>${args ? '(' + escapeHtml(args) + ')' : ''} → ${escapeHtml(String(info.result))}</span>`;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

let timer = null, startTs = 0;
function startTimer() {
  startTs = now();
  timer = setInterval(() => {
    const s = Math.floor((now() - startTs) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    const m = $('#mTime'); if (m) m.textContent = `${mm}:${ss}`;
  }, 500);
}
function stopTimer() { clearInterval(timer); timer = null; }

function onFinalTranscript(text) {
  if ('speechSynthesis' in window && window.speechSynthesis.speaking) window.speechSynthesis.cancel(); // 自动打断正在播报的 TTS
  if (mode === 'sim') simRespond(text);
  else if (mode === 'domestic') domesticRespond(text);
  else addMsg('user', text);
}

// ================= 模拟模式 =================
let recog = null, simBusy = false, simIdx = 0;

function startMicCapture() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return false;
  recog = new SR();
  recog.lang = scenario === 'language' ? 'en-US' : 'zh-CN';
  recog.continuous = true;
  recog.interimResults = true;
  recog.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) { const t = r[0].transcript.trim(); if (t) onFinalTranscript(t); }
      else interim += r[0].transcript;
    }
    if (interim) setStatus(`识别中：${interim}`);
  };
  recog.onerror = (e) => setStatus(`识别出错：${e.error}（可改用文字输入）`);
  recog.onend = () => { if (running && (mode === 'sim' || mode === 'domestic')) { try { recog.start(); } catch (_) {} } };
  try { recog.start(); } catch (_) { return false; }
  return true;
}
function stopMicCapture() { if (recog) { try { recog.stop(); } catch (_) {} recog = null; } }

function simRespond(text) {
  if (simBusy) return;
  simBusy = true;
  trackUserTurn(text);
  addMsg('user', text);
  const think = addMsg('bot', '思考中…', 'thinking');
  const delay = 500 + Math.random() * 700;
  setTimeout(() => {
    const item = SCENARIOS[scenario].simReplies[simIdx % SCENARIOS[scenario].simReplies.length];
    simIdx++;
    const reply = (item && typeof item === 'object') ? item.en : item;
    removeMsg(think);
    const botSpan = addMsg('bot', reply);
    trackBotTurn(reply, null);
    speak(reply, scenario === 'language' ? 'en-US' : 'zh-CN');
    // 双语字幕：外语陪练场景开启双语时，直接显示内置中文译文（模拟模式无需密钥）
    if (settings.bilingual && scenario === 'language' && item && item.cn) {
      const s = document.createElement('span');
      s.className = 'sub-cn';
      s.textContent = '中文：' + item.cn;
      if (botSpan && botSpan.parentElement) botSpan.parentElement.appendChild(s);
    }
    simBusy = false;
  }, delay);
}

function speak(text, lang) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 1.02;
  if (settings.voice) {
    const v = window.speechSynthesis.getVoices().find((x) => x.name === settings.voice);
    if (v) u.voice = v;
  }
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

// ================= 国内大模型模式（流式 + 工具 + RAG + 多智能体 + 双语） =================
let domBuf = '';

async function domesticRespond(text) {
  if (!isModeConfigured('domestic')) {
    addMsg('user', text);
    addMsg('bot', '「国内大模型」当前不可用：未填入密钥且服务端也未配置。请在上方模式栏点击「国内大模型」填入 DeepSeek API Key；本地运行也可配置 DOMESTIC_LLM_KEY。也可切到「模拟」模式。');
    return;
  }
  trackUserTurn(text);
  addMsg('user', text);
  const think = addMsg('bot', '思考中…', 'thinking');
  const t0 = now();
  let first = true, botSpan = null, full = '', firstLatency = 0;
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: text }],
        temperature: settings.temp,
        tools: settings.tools,
        useRag: settings.rag,
        knowledge: settings.knowledge,
        ...providerPayload(),
        apiKey: enteredKeys.domestic || undefined
      })
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({ error: r.statusText }));
      removeMsg(think);
      addMsg('bot', '模型接口错误：' + (e.error || r.status));
      return;
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      domBuf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = domBuf.indexOf('\n')) >= 0) {
        const line = domBuf.slice(0, idx).trim();
        domBuf = domBuf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (d === '' || d === '[DONE]') continue;
        try {
          const j = JSON.parse(d);
          if (j.tool) { removeMsg(think); addToolMsg(j.tool); continue; }
          const c = j.c;
          if (c) {
            if (first) {
              first = false;
              firstLatency = Math.round(now() - t0);
              const lat = $('#mLatency'); if (lat) lat.textContent = firstLatency + ' ms';
              removeMsg(think);
              botSpan = addMsg('bot', '');
            }
            full += c;
            if (botSpan) botSpan.textContent = full;
          }
        } catch (_) { /* 不完整分片 */ }
      }
    }
    removeMsg(think);
    const emptyHint = '模型没有返回内容。常见原因：DeepSeek 账户余额不足、模型名不匹配，或上游返回为空。请检查 deepseek.com 控制台余额与模型名（默认 deepseek-chat）。';
    const botEl = botSpan ? botSpan.parentElement : (addMsg('bot', full || emptyHint).parentElement);
    if (settings.multi && botSpan) renderMultiAgent(botSpan, full);
    trackBotTurn(full, firstLatency);
    speak(full, scenario === 'language' ? 'en-US' : 'zh-CN');
    appendBilingual(botEl, full);
  } catch (e) {
    removeMsg(think);
    const net = e && /failed to fetch|networkerror|load failed|network/i.test(e.message || '');
    addMsg('bot', net
      ? '请求失败：无法连接服务端。线上版本请稍后重试；本地运行请确认 npm start 并用 http://localhost:3000 打开（不要直接双击 HTML 文件）。'
      : ('请求失败：' + (e.message || e)));
  }
}

// ================= OpenAI 实时双向模式 =================
let ws = null, audioCtx = null, micStream = null, scriptNode = null, silentGain = null;
let audioQueue = [], playing = false, respStart = 0, firstAudio = 0, gotFirst = false, botSpanRT = null;

async function startRealtime() {
  setStatus('正在申请临时密钥…');
  let data;
  try { const r = await fetch('/api/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: enteredKeys.openai || undefined }) }); data = await r.json(); }
  catch (e) { setStatus('无法连接服务端，请稍后重试（本地运行请先 npm start）'); return; }
  if (data.error) { setStatus(data.error); return; }
  const key = data.value || data.client_secret?.value;
  if (!key) { setStatus('服务端未返回可用 token，请检查 OPENAI_API_KEY'); return; }

  ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${MODEL}`, ['realtime', key]);
  ws.onopen = () => {
    running = true;
    const mic = $('#micBtn'); if (mic) mic.classList.add('live');
    const lbl = $('#micLabel'); if (lbl) lbl.textContent = '通话中';
    sendSessionUpdate();
    setStatus('已连接 · 等待你开口');
    startTimer();
    startRealtimeMic();
  };
  ws.onmessage = (ev) => onRealtimeMessage(JSON.parse(ev.data));
  ws.onerror = () => setStatus('WebSocket 错误（网络 / 密钥 / 区域可达性）');
  ws.onclose = () => { if (running) setStatus('连接已关闭'); };
}

function sendSessionUpdate() {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify({
    type: 'session.update',
    session: {
      modalities: ['text', 'audio'],
      instructions: systemPrompt(),
      voice: 'alloy',
      input_audio_transcription: { model: 'whisper-1' },
      turn_detection: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 700 }
    }
  }));
}

async function startRealtimeMic() {
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const src = audioCtx.createMediaStreamSource(micStream);
    scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== 1) return;
      const pcm = floatTo16(e.inputBuffer.getChannelData(0));
      ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: bytesToBase64(pcm) }));
    };
    silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    src.connect(scriptNode); scriptNode.connect(silentGain); silentGain.connect(audioCtx.destination);
  } catch (e) { setStatus('无法访问麦克风：' + e.message); }
}

function onRealtimeMessage(msg) {
  switch (msg.type) {
    case 'session.created': ws.send(JSON.stringify({ type: 'response.create' })); break;
    case 'response.created': respStart = now(); gotFirst = false; break;
    case 'response.audio.delta':
      if (!gotFirst) { firstAudio = now(); gotFirst = true; const lat = $('#mLatency'); if (lat) lat.textContent = Math.round(firstAudio - respStart) + ' ms'; }
      queueAudio(msg.delta); break;
    case 'response.audio_transcript.delta': appendStreamingBot(msg.delta); break;
    case 'conversation.item.input_audio_transcription.completed': trackUserTurn(msg.transcript); addMsg('user', msg.transcript); break;
    case 'response.done': { const txt = botSpanRT ? botSpanRT.textContent : ''; trackBotTurn(txt, firstAudio - respStart); finalizeBot(); break; }
    case 'error': console.error(msg.error); setStatus('模型错误：' + (msg.error?.message || '未知')); break;
  }
}

function queueAudio(b64) {
  const pcm = base64ToBytes(b64);
  const f32 = new Float32Array(pcm.length / 2);
  for (let i = 0; i < f32.length; i++) f32[i] = pcm.getInt16(i * 2, true) / 32768;
  audioQueue.push(f32);
  if (!playing) playNext();
}
function playNext() {
  if (!audioQueue.length || !audioCtx) { playing = false; return; }
  playing = true;
  const f32 = audioQueue.shift();
  const buf = audioCtx.createBuffer(1, f32.length, 24000);
  buf.copyToChannel(f32, 0);
  const src = audioCtx.createBufferSource();
  src.buffer = buf; src.connect(audioCtx.destination); src.onended = playNext; src.start();
}

function appendStreamingBot(delta) {
  if (!botSpanRT) {
    const el = document.createElement('div');
    el.className = 'msg bot';
    el.innerHTML = '<span class="who">AI Agent</span>';
    botSpanRT = document.createElement('span');
    el.appendChild(botSpanRT);
    $('#transcript').appendChild(el);
  }
  botSpanRT.textContent += delta;
  $('#transcript').scrollTop = $('#transcript').scrollHeight;
}
function finalizeBot() { botSpanRT = null; }

function stopRealtime() {
  running = false;
  if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (audioCtx) { try { audioCtx.close(); } catch (_) {} audioCtx = null; }
  scriptNode = null; silentGain = null;
  audioQueue = []; playing = false;
  const mic = $('#micBtn'); if (mic) mic.classList.remove('live');
  const lbl = $('#micLabel'); if (lbl) lbl.textContent = '点击开始';
  stopTimer();
  setStatus('已停止');
}

// ================= MiniMax 真时双向语音（需密钥 + 网络） =================
let mxWs = null, mxAudioCtx = null, mxStream = null, mxNode = null, mxGain = null, mxQueue = [], mxPlaying = false, mxFirst = false, mxT0 = 0, mxBotSpan = null, mxBotText = '';

async function startMiniMax() {
  setStatus('正在申请 MiniMax token…');
  let data;
  try { const r = await fetch('/api/minimax-token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ groupId: enteredKeys.minimaxGid || undefined, apiKey: enteredKeys.minimaxKey || undefined }) }); data = await r.json(); }
  catch (e) { setStatus('无法连接服务端，请稍后重试（本地运行请先 npm start）'); return; }
  if (data.error) { setStatus('MiniMax 不可用：' + data.error); return; }

  const url = `wss://api.minimax.chat/v1/realtime?authorization=${encodeURIComponent(data.token)}`;
  try { mxWs = new WebSocket(url); } catch (e) { setStatus('无法建立连接：' + e.message); return; }
  mxWs.onopen = () => {
    running = true;
    const mic = $('#micBtn'); if (mic) mic.classList.add('live');
    const lbl = $('#micLabel'); if (lbl) lbl.textContent = '通话中';
    setStatus('MiniMax 已连接 · 等待你开口');
    startTimer();
    startMiniMaxMic();
  };
  mxWs.onmessage = (ev) => onMiniMaxMessage(ev.data);
  mxWs.onerror = () => setStatus('MiniMax WebSocket 错误（请检查密钥 / 网络 / 端点）');
  mxWs.onclose = () => { if (running) setStatus('MiniMax 连接已关闭'); };
}

function onMiniMaxMessage(raw) {
  let msg; try { msg = JSON.parse(raw); } catch (_) { return; }
  // 注意：MiniMax 真实事件字段以其官方文档为准，此处做通用兜底
  if (msg.type === 'audio' || msg.type === 'audio_delta' || msg.event === 'audio') {
    const b64 = msg.data || msg.audio || msg.delta;
    if (b64 && !mxFirst) { mxFirst = true; const lat = $('#mLatency'); if (lat) lat.textContent = Math.round(now() - mxT0) + ' ms'; }
    if (b64) mxQueueAudio(b64);
  } else if ((msg.type === 'recognize' || msg.event === 'recognize') && msg.text) {
    trackUserTurn(msg.text); addMsg('user', msg.text);
  } else if ((msg.type === 'reply' || msg.event === 'reply' || msg.type === 'message') && msg.text) {
    if (!mxBotSpan) mxBotSpan = addMsg('bot', '');
    mxBotSpan.textContent += msg.text; mxBotText += msg.text;
  }
}
function mxQueueAudio(b64) {
  const bin = atob(b64);
  const pcm = new Int16Array(bin.length / 2);
  for (let i = 0; i < pcm.length; i++) pcm[i] = (bin.charCodeAt(i * 2 + 1) << 8) | bin.charCodeAt(i * 2);
  const f32 = new Float32Array(pcm.length);
  for (let i = 0; i < f32.length; i++) f32[i] = pcm[i] / 32768;
  mxQueue.push(f32); if (!mxPlaying) mxPlayNext();
}
function mxPlayNext() {
  if (!mxQueue.length || !mxAudioCtx) { mxPlaying = false; return; }
  mxPlaying = true;
  const f32 = mxQueue.shift();
  const buf = mxAudioCtx.createBuffer(1, f32.length, 24000);
  buf.copyToChannel(f32, 0);
  const src = mxAudioCtx.createBufferSource();
  src.buffer = buf; src.connect(mxAudioCtx.destination); src.onended = mxPlayNext; src.start();
}
async function startMiniMaxMic() {
  try {
    mxAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    mxStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const src = mxAudioCtx.createMediaStreamSource(mxStream);
    mxNode = mxAudioCtx.createScriptProcessor(4096, 1, 1);
    mxT0 = now(); mxFirst = false; mxBotText = '';
    mxNode.onaudioprocess = (e) => {
      if (!mxWs || mxWs.readyState !== 1) return;
      const pcm = floatTo16(e.inputBuffer.getChannelData(0));
      mxWs.send(JSON.stringify({ type: 'audio', data: bytesToBase64(pcm) }));
    };
    mxGain = mxAudioCtx.createGain(); mxGain.gain.value = 0;
    src.connect(mxNode); mxNode.connect(mxGain); mxGain.connect(mxAudioCtx.destination);
  } catch (e) { setStatus('无法访问麦克风：' + e.message); }
}
function stopMiniMax() {
  running = false;
  if (mxBotText) { trackBotTurn(mxBotText, mxFirst ? Math.round(now() - mxT0) : 0); mxBotText = ''; }
  if (mxWs) { try { mxWs.close(); } catch (_) {} mxWs = null; }
  if (mxStream) { mxStream.getTracks().forEach((t) => t.stop()); mxStream = null; }
  if (mxAudioCtx) { try { mxAudioCtx.close(); } catch (_) {} mxAudioCtx = null; }
  mxNode = null; mxGain = null; mxQueue = []; mxPlaying = false; mxBotSpan = null;
  const mic = $('#micBtn'); if (mic) mic.classList.remove('live');
  const lbl = $('#micLabel'); if (lbl) lbl.textContent = '点击开始';
  stopTimer();
  setStatus('已停止');
}

// ---------- 音频编码 ----------
function floatTo16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
  return out;
}
function bytesToBase64(int16) {
  let bin = '';
  for (let i = 0; i < int16.length; i++) bin += String.fromCharCode((int16[i] >> 8) & 0xff, int16[i] & 0xff);
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new DataView(arr.buffer);
}

// ---------- 启动 / 停止（统一调度） ----------
function start() {
  if (mode === 'openai') { startRealtime(); return; }
  if (mode === 'minimax') { startMiniMax(); return; }
  running = true;
  const mic = $('#micBtn'); if (mic) mic.classList.add('live');
  const lbl = $('#micLabel'); if (lbl) lbl.textContent = mode === 'domestic' ? '通话中' : '正在聆听';
  startTimer();
  if (!startMicCapture()) setStatus('语音识别不可用，可直接用下方文字输入');
  else setStatus(mode === 'domestic' ? '国内大模型 · 说点什么试试' : '模拟模式 · 说点什么试试');
  const bw = $('#bargeWrap'); if (bw) bw.classList.add('show');
}
function stop() {
  if (mode === 'openai') { stopRealtime(); return; }
  if (mode === 'minimax') { stopMiniMax(); return; }
  running = false;
  stopMicCapture();
  const mic = $('#micBtn'); if (mic) mic.classList.remove('live');
  const lbl = $('#micLabel'); if (lbl) lbl.textContent = '点击开始';
  stopTimer();
  const bw = $('#bargeWrap'); if (bw) bw.classList.remove('show');
  setStatus('已停止');
}

// ---------- 音色画廊（B12） ----------
// 官方中文音色目录（Microsoft Azure Neural TTS 中文音色，按角色/风格命名，便于一眼识别）
const VOICE_CATALOG = [
  { re: /xiaoxiao/i,    name: '晓晓', gender: '♀', style: '女声 · 多风格通用',   order: 1 },
  { re: /yunyang/i,     name: '云扬', gender: '♂', style: '男声 · 新闻播报',     order: 2 },
  { re: /yunxi/i,       name: '云希', gender: '♂', style: '男声 · 阳光活力',     order: 3 },
  { re: /xiaorui/i,     name: '晓睿', gender: '♀', style: '女声 · 专业知性',     order: 4 },
  { re: /xiaochen/i,    name: '晓辰', gender: '♂', style: '男声 · 专业沉稳',     order: 5 },
  { re: /yunjian/i,     name: '云健', gender: '♂', style: '男声 · 沉稳',         order: 6 },
  { re: /xiaohan/i,     name: '晓涵', gender: '♀', style: '女声 · 温柔',         order: 7 },
  { re: /xiaoxuan/i,    name: '晓萱', gender: '♀', style: '女声 · 温柔',         order: 8 },
  { re: /xiaoyan/i,     name: '晓颜', gender: '♀', style: '女声 · 清新',         order: 9 },
  { re: /yunxia/i,      name: '云霞', gender: '♀', style: '女声 · 温柔',         order: 10 },
  { re: /xiaoqiu/i,     name: '晓秋', gender: '♀', style: '女声 · 活泼',         order: 11 },
  { re: /xiaoshuang/i,  name: '晓双', gender: '♀', style: '女声 · 清脆',         order: 12 },
  { re: /xiaoyi/i,      name: '晓伊', gender: '♀', style: '女声 · 亲切',         order: 13 },
  { re: /xiaomeng/i,    name: '晓梦', gender: '♀', style: '女声 · 卡通童声',     order: 14 },
  { re: /xiaomo/i,      name: '晓墨', gender: '♂', style: '男声 · 沉稳',         order: 15 },
  { re: /yunfeng/i,     name: '云枫', gender: '♂', style: '男声 · 磁性',         order: 16 },
  { re: /yunye/i,       name: '云野', gender: '♂', style: '男声 · 磁性',         order: 17 },
  { re: /yunze/i,       name: '云泽', gender: '♂', style: '男声 · 沉稳',         order: 18 },
  { re: /yunhao/i,      name: '云皓', gender: '♂', style: '男声 · 阳光',         order: 19 },
  { re: /yunjie/i,      name: '云杰', gender: '♂', style: '男声 · 专业',         order: 20 },
  { re: /xiaobei/i,     name: '晓贝', gender: '♀', style: '女声 · 东北方言',     order: 21 },
  { re: /xiaoni/i,      name: '小妮', gender: '♀', style: '女声 · 陕西方言',     order: 22 },
  { re: /huihui/i,      name: '慧慧', gender: '♀', style: '女声 · 经典系统音',   order: 30 },
  { re: /kangkang/i,    name: '康康', gender: '♂', style: '男声 · 经典系统音',   order: 31 },
  { re: /yaoyao/i,      name: '瑶瑶', gender: '♀', style: '女声 · 经典童声',     order: 32 },
];

function describeVoice(v) {
  const n = v.name || '';
  const e = VOICE_CATALOG.find((x) => x.re.test(n));
  if (e) return { official: e.name, gender: e.gender, style: e.style, order: e.order, isZh: true };
  const clean = n.replace(/^Microsoft\s+/i, '').replace(/\s*Online\s*\(Natural\)/i, '').replace(/\s*-\s*.*$/, '').trim();
  return { official: clean || n, gender: '🌐', style: v.lang || '其他语言', order: 100, isZh: false };
}

function initVoiceGallery() {
  const g = document.getElementById('voiceGallery');
  if (!g) return;
  const zhOnlyBox = document.getElementById('zhOnly');
  const fill = () => {
    if (!('speechSynthesis' in window)) { g.innerHTML = '<span class="voice-empty">当前浏览器不支持语音合成</span>'; return; }
    const vs = window.speechSynthesis.getVoices();
    if (!vs.length) { g.innerHTML = '<span class="voice-empty">正在加载音色…（部分浏览器需先触发一次朗读）</span>'; return; }
    const zhOnly = zhOnlyBox && zhOnlyBox.checked;
    const items = vs
      .map((v) => ({ v, d: describeVoice(v) }))
      .filter((it) => !(zhOnly && !it.d.isZh))
      .sort((a, b) => (a.d.isZh === b.d.isZh ? a.d.order - b.d.order || a.v.name.localeCompare(b.v.name) : a.d.isZh ? -1 : 1));
    g.innerHTML = '';
    items.forEach(({ v, d }) => {
      const card = document.createElement('div');
      card.className = 'voice-card' + (settings.voice === v.name ? ' active' : '');
      const badgeCls = d.gender === '♀' ? 'vc-f' : d.gender === '♂' ? 'vc-m' : 'vc-o';
      card.innerHTML =
        `<span class="vc-badge ${badgeCls}">${d.gender}</span>` +
        `<span class="vc-main"><span class="vc-name">${escapeHtml(d.official)}</span>` +
        `<span class="vc-style">${escapeHtml(d.style)}</span></span>` +
        `<span class="vc-try">试听</span>`;
      card.addEventListener('click', () => {
        settings.voice = v.name;
        document.querySelectorAll('.voice-card').forEach((c) => c.classList.remove('active'));
        card.classList.add('active');
        try { localStorage.setItem('va_voice', v.name); } catch (_) {}
      });
      const tryBtn = card.querySelector('.vc-try');
      bind(tryBtn, 'click', (e) => {
        e.stopPropagation();
        const u = new SpeechSynthesisUtterance('这是一段音色试听示例，用于预览语音播报效果。');
        u.voice = v; u.lang = v.lang;
        window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
      });
      g.appendChild(card);
    });
    if (!items.length) g.innerHTML = '<span class="voice-empty">未检测到中文音色</span>';
  };
  if (zhOnlyBox) bind(zhOnlyBox, 'change', fill);
  if ('speechSynthesis' in window) { fill(); window.speechSynthesis.onvoiceschanged = fill; }
}

// ---------- 绑定（仅 demo 页） ----------
function initDemo() {
  bind($('#modeSeg'), 'click', (e) => {
    const b = e.target.closest('.seg-btn');
    if (!b) return;
    const m = b.dataset.mode;
    if (m === 'sim') { selectMode('sim'); return; }
    if (isModeConfigured(m)) { selectMode(m); return; }
    if (location.protocol === 'file:') {
      showBanner('你正在直接打开 HTML 文件（<code>file://</code>）。远程模式需要本地服务支撑，请先运行 <code>npm start</code>，再用 <code>http://localhost:3000</code> 打开本页。模拟模式仍可使用。', 'warn');
      return;
    }
    showKeyModal(m); // 未配置：直接弹出密钥输入框
  });
  bind($('#sceneSeg'), 'click', (e) => {
    const b = e.target.closest('.seg-btn'); if (!b) return;
    scenario = b.dataset.scene;
    document.querySelectorAll('#sceneSeg .seg-btn').forEach((x) => x.classList.toggle('active', x === b));
    if (mode === 'openai' && running) sendSessionUpdate();
  });
  bind($('#micBtn'), 'click', () => (running ? stop() : start()));
  bind($('#bargeBtn'), 'click', bargeIn);
  bind($('#clearBtn'), 'click', () => { const t = $('#transcript'); if (t) t.innerHTML = ''; resetMetrics(); });
  bind($('#sendBtn'), 'click', handleSend);
  bind($('#textInput'), 'keydown', (e) => { if (e.key === 'Enter') handleSend(); });
  bind($('#themeToggle'), 'click', toggleTheme);
  bind($('#metricsToggle'), 'click', () => { const p = $('#metricsPanel'); if (p) p.classList.toggle('open'); });
  bind($('#metricsReset'), 'click', resetMetrics);
  bind($('#metricsExport'), 'click', () => downloadText('评测报告.md', buildReport()));
  bind($('#exportBtn'), 'click', () => downloadText('对话转录.md', '# 对话转录\n\n' + (buildTranscript() || '（暂无内容）')));

  // 设置：温度
  const temp = $('#setTemp'), tempVal = $('#setTempVal');
  bind(temp, 'input', () => { settings.temp = parseFloat(temp.value); if (tempVal) tempVal.textContent = temp.value; });

  // 设置：国内大模型服务商（决定 Base URL / 模型）
  const prov = $('#setProvider');
  if (prov) {
    if (!PROVIDERS[settings.provider]) settings.provider = 'deepseek'; // 兼容旧/异常值
    try { enteredKeys.domestic = sessionStorage.getItem(domKeySlot(settings.provider)) || ''; } catch (_) {}
    prov.value = settings.provider;
    bind(prov, 'change', () => {
      settings.provider = prov.value;
      try { localStorage.setItem('va_provider', settings.provider); } catch (_) {}
      // 切服务商：载入该服务商自己已存的 Key（没有则为空，需重填）
      try { enteredKeys.domestic = sessionStorage.getItem(domKeySlot(settings.provider)) || ''; } catch (_) { enteredKeys.domestic = ''; }
      refreshProviderExtra();
      refreshModeButtons();
    });
  }
  bind($('#setProvBase'), 'input', (e) => { settings.customBase = e.target.value.trim(); try { localStorage.setItem('va_provider_base', settings.customBase); } catch (_) {} });
  bind($('#setProvModel'), 'input', (e) => { settings.customModel = e.target.value.trim(); try { localStorage.setItem('va_provider_model', settings.customModel); } catch (_) {} });
  refreshProviderExtra();
  // 设置：工具 / 多智能体 / 双语 / RAG + 知识库
  bind($('#setTools'), 'change', (e) => { settings.tools = e.target.checked; });
  bind($('#setMulti'), 'change', (e) => { settings.multi = e.target.checked; });
  bind($('#setBilingual'), 'change', (e) => { settings.bilingual = e.target.checked; bilingualWarned = false; });
  bind($('#setRag'), 'change', (e) => { settings.rag = e.target.checked; });
  const know = $('#setKnowledge');
  bind(know, 'input', () => { settings.knowledge = know.value; });

  initVoiceGallery();
  initConfig();

  // PWA 安装提示
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e;
    const ib = document.getElementById('installBtn'); if (ib) ib.style.display = 'inline-block';
  });
  bind($('#installBtn'), 'click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
  });
}

function handleSend() {
  const t = $('#textInput');
  const val = t ? t.value.trim() : '';
  if (!val) return;
  if (t) t.value = '';
  onFinalTranscript(val);
}

if (location.protocol === 'file:') {
  showBanner('你正在直接打开 HTML 文件（<code>file://</code>）。「国内大模型 / 实时 / MiniMax」需要本地服务支撑。请先运行 <code>npm start</code>，再用 <code>http://localhost:3000</code> 打开本页。模拟模式仍可使用。', 'warn');
}

if (document.getElementById('micBtn')) initDemo();

// ---------- 全局主题初始化（着陆页 / 演示页通用，避免首屏闪烁） ----------
(function globalTheme() {
  let t = localStorage.getItem('va-theme');
  if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(t);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.addEventListener('click', toggleTheme);
})();

// PWA Service Worker 注册（仅正式协议下）
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
