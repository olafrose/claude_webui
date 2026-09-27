import { h, icons, iconEl, md, relTime, duration, Feed, AGENT_TOOLS, toolInputView } from './render.js';

const app = document.getElementById('app');
const touch = matchMedia('(pointer: coarse)').matches;
const store = {
  get(k, d) {
    try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ }
  },
};
const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p || '';

const STATUS_TEXT = {
  starting: 'Starting…',
  running: 'Working…',
  busy: 'Working…',
  requires_action: 'Needs your input',
  waiting: 'Waiting',
  idle: 'Ready',
  closed: 'Closed',
  error: 'Error',
};

// ---------------------------------------------------------------- api / toasts / notifications

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'claude-remote' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Please sign in');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(text, { error = false, onclick, timeout = 4500 } = {}) {
  const el = h('div', { class: `toast${error ? ' error' : ''}`, onclick: () => { el.remove(); onclick?.(); } }, text);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), timeout);
}

let swReg = null;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').then((r) => (swReg = r)).catch(() => {});

function notify(title, body, url) {
  navigator.vibrate?.([80, 60, 80]);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, tag: url, data: { url }, icon: '/icon.svg' };
  if (swReg?.showNotification) swReg.showNotification(title, opts).catch(() => {});
  else new Notification(title, opts);
}

function sheet(title, content, { onclose } = {}) {
  const close = () => { backdrop.remove(); onclose?.(); };
  const backdrop = h('div', { class: 'backdrop', onclick: (e) => e.target === backdrop && close() },
    h('div', { class: 'sheet' }, h('h2', {}, title, h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '✕')), content));
  document.body.append(backdrop);
  return { close, el: backdrop };
}

// ---------------------------------------------------------------- websocket

const ws = {
  sock: null,
  handlers: new Set(),
  pendingRefs: new Map(),
  n: 0,
  backoff: 500,
  open: false,
  started: false,
  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
  },
  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/ws`);
    this.sock = sock;
    sock.onopen = () => {
      this.open = true;
      this.backoff = 500;
      this.emit({ t: '_open' });
    };
    sock.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.t === 'ack') {
        const p = this.pendingRefs.get(msg.ref);
        this.pendingRefs.delete(msg.ref);
        if (p) msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
        return;
      }
      this.emit(msg);
    };
    sock.onclose = async () => {
      this.open = false;
      this.emit({ t: '_close' });
      for (const p of this.pendingRefs.values()) p.reject(new Error('Connection lost'));
      this.pendingRefs.clear();
      const me = await fetch('/api/me').then((r) => r.json()).catch(() => null);
      if (me && !me.authenticated) {
        this.started = false;
        return showLogin();
      }
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 10_000);
    };
  },
  emit(msg) {
    for (const fn of this.handlers) fn(msg);
  },
  on(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  },
  send(msg) {
    if (!this.open) return Promise.reject(new Error('Not connected — retrying…'));
    const ref = ++this.n;
    this.sock.send(JSON.stringify({ ...msg, ref }));
    return new Promise((resolve, reject) => this.pendingRefs.set(ref, { resolve, reject }));
  },
};

// Reconnect immediately when a phone brings the tab back to the foreground.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ws.started && !ws.open && ws.sock?.readyState === WebSocket.CLOSED) ws.connect();
});

const globalState = { live: [], viewingSession: null, config: null };

ws.on((msg) => {
  if (msg.t === 'live') globalState.live = msg.sessions;
  if (msg.t === 'attention') {
    const viewing = globalState.viewingSession === msg.sessionId && !document.hidden;
    if (viewing) return;
    const url = `/#/s/${msg.sessionId}`;
    const title = msg.kind === 'permission' ? 'Claude needs approval' : 'Claude is waiting';
    toast(`${title}: ${msg.title || msg.text}`, { onclick: () => (location.hash = `#/s/${msg.sessionId}`), timeout: 8000 });
    if (document.hidden) notify(title, `${msg.title ? msg.title + ' — ' : ''}${msg.text}`, url);
  }
});

// ---------------------------------------------------------------- router

let cleanup = null;
function route() {
  cleanup?.();
  cleanup = null;
  globalState.viewingSession = null;
  const hash = location.hash.slice(1) || '/';
  const [path, qs] = hash.split('?');
  const params = new URLSearchParams(qs || '');
  const m = path.match(/^\/s\/([\w-]+)/);
  cleanup = m ? sessionView(m[1], params.get('cwd')) : dashboardView();
}
window.addEventListener('hashchange', () => authed && route());

let authed = false;
async function boot() {
  const me = await fetch('/api/me').then((r) => r.json());
  if (!me.authenticated) return showLogin(me.totp);
  authed = true;
  globalState.config = await api('/api/config');
  ws.start();
  route();
}

// ---------------------------------------------------------------- login

function showLogin(totp) {
  authed = false;
  cleanup?.();
  cleanup = null;
  if (totp === undefined) return fetch('/api/me').then((r) => r.json()).then((me) => showLogin(me.totp));
  const err = h('div', { class: 'error' });
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', required: true, autofocus: true });
  const code = totp ? h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '6', required: true }) : null;
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      err.textContent = '';
      try {
        await api('/api/login', { method: 'POST', body: { password: pw.value, totp: code?.value } });
        boot();
      } catch (ex) {
        err.textContent = ex.message;
        btn.disabled = false;
      }
    },
  },
  h('h1', {}, h('img', { src: '/icon.svg', width: 30, height: 30, alt: '' }), 'Claude Remote'),
  h('p', {}, 'Sign in to control Claude Code on your machine.'),
  h('div', { class: 'field' }, h('label', {}, 'Password'), pw),
  code && h('div', { class: 'field' }, h('label', {}, 'Authenticator code'), code),
  err, btn);
  app.replaceChildren(h('div', { class: 'login' }, form));
  pw.focus();
}

// ---------------------------------------------------------------- dashboard

function dashboardView() {
  document.title = 'Claude Remote';
  const openProjects = new Set(store.get('openProjects', []));
  let data = null;
  let live = { app: [], external: [] };
  let filter = '';
  const showAll = new Set();

  const activeBox = h('div');
  const listBox = h('div', { class: 'card list' }, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));

  const notifBtn = 'Notification' in window && Notification.permission === 'default'
    ? h('button', { class: 'icon-btn', title: 'Enable notifications', html: icons.bell, onclick: async () => { await Notification.requestPermission(); notifBtn.remove(); } })
    : null;

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter projects…', oninput: () => { filter = search.value.toLowerCase(); renderList(); } });

  app.replaceChildren(
    h('div', { class: 'topbar' },
      h('div', { class: 'title brand' }, h('img', { src: '/icon.svg', alt: '' }), h('h1', {}, 'Claude Remote')),
      notifBtn,
      h('button', { class: 'icon-btn', title: 'Refresh', html: icons.refresh, onclick: () => load() }),
      h('button', { class: 'icon-btn', title: 'Sign out', html: icons.logout, onclick: async () => { await api('/api/logout', { method: 'POST' }); location.reload(); } })),
    h('div', { class: 'page' },
      activeBox,
      h('div', { class: 'section-title' }, 'Projects', h('span', { class: 'spacer' }), h('span', { style: 'text-transform:none;font-weight:400', title: globalState.config?.baseDir }, basename(globalState.config?.baseDir))),
      h('div', { class: 'search' }, search, h('button', { class: 'btn', onclick: newFolder }, iconEl('plus'), 'Folder')),
      h('div', { style: 'height:10px' }),
      listBox));

  function statusDot(status) {
    return h('span', { class: `dot ${status || ''}`, title: STATUS_TEXT[status] || status || '' });
  }

  function renderActive() {
    const items = [
      ...live.app.map((s) => ({ ...s, where: 'here' })),
      ...live.external.map((s) => ({ ...s, title: s.name, where: s.entrypoint?.replace(/^claude-/, '') || 'terminal' })),
    ];
    if (!items.length) return activeBox.replaceChildren();
    activeBox.replaceChildren(
      h('div', { class: 'section-title' }, 'Active now'),
      h('div', { class: 'card list' }, items.map((s) =>
        h('a', { class: 'row', href: `#/s/${s.sessionId}?cwd=${encodeURIComponent(s.cwd || '')}` },
          statusDot(s.pending ? 'requires_action' : s.status),
          h('div', { class: 'main' },
            h('div', { class: 'name' }, s.title || 'New session'),
            h('div', { class: 'meta' }, h('span', {}, basename(s.cwd)), '·', h('span', {}, s.pending ? 'Needs approval' : STATUS_TEXT[s.status] || s.status),
              s.where !== 'here' ? h('span', { class: 'badge' }, s.where) : null,
              s.runningAgents ? h('span', { class: 'badge accent' }, `${s.runningAgents} agent${s.runningAgents > 1 ? 's' : ''}`) : null)),
          h('span', { class: 'chev', html: icons.chev })))));
  }

  function sessionRow(s) {
    return h('a', { class: 'row', href: `#/s/${s.sessionId}?cwd=${encodeURIComponent(s.cwd || '')}` },
      s.live ? statusDot(s.status) : null,
      h('div', { class: 'main' },
        h('div', { class: 'name' }, s.title),
        h('div', { class: 'meta' }, relTime(s.lastModified), s.gitBranch && s.gitBranch !== 'HEAD' ? h('span', { class: 'badge' }, s.gitBranch) : null,
          s.live === 'external' ? h('span', { class: 'badge warn' }, `open in ${s.external?.entrypoint?.replace(/^claude-/, '') || 'terminal'}`) : null,
          s.live === 'app' ? h('span', { class: 'badge accent' }, 'live') : null)),
      h('span', { class: 'chev', html: icons.chev }));
  }

  function renderList() {
    if (!data) return;
    const projects = data.projects.filter((p) => !filter || p.name.toLowerCase().includes(filter));
    if (!projects.length) return listBox.replaceChildren(h('div', { class: 'empty' }, filter ? 'No matching folders' : 'No folders in the base directory yet'));
    listBox.replaceChildren(...projects.map((p) => {
      const open = openProjects.has(p.path);
      const toggle = () => {
        open ? openProjects.delete(p.path) : openProjects.add(p.path);
        store.set('openProjects', [...openProjects]);
        renderList();
      };
      const limit = showAll.has(p.path) ? Infinity : 6;
      return h('div', { class: `project${open ? ' open' : ''}` },
        h('div', { class: 'row', onclick: toggle },
          h('div', { class: 'main' },
            h('div', { class: 'name' }, p.name),
            h('div', { class: 'meta' },
              p.sessionCount ? `${p.sessionCount} session${p.sessionCount > 1 ? 's' : ''} · ${relTime(p.lastActivity)}` : 'No sessions yet',
              p.liveCount ? h('span', { class: 'badge accent' }, h('span', { class: 'dot running' }), `${p.liveCount} live`) : null)),
          h('span', { class: 'chev', html: icons.chev })),
        open && h('div', { class: 'sessions' },
          h('div', { class: 'actions' }, h('button', { class: 'btn primary small', onclick: () => newSession(p) }, iconEl('plus'), 'New session')),
          h('div', { class: 'list' }, p.sessions.slice(0, limit).map(sessionRow)),
          p.sessions.length > limit && h('div', { class: 'actions' }, h('button', { class: 'btn small ghost', onclick: () => { showAll.add(p.path); renderList(); } }, `Show ${p.sessions.length - limit} more`))));
    }));
  }

  async function load() {
    try {
      const [projects, liveNow] = await Promise.all([api('/api/projects'), api('/api/live')]);
      data = projects;
      live = liveNow;
      renderActive();
      renderList();
    } catch (e) {
      listBox.replaceChildren(h('div', { class: 'empty' }, `Failed to load: ${e.message}`));
    }
  }

  function newFolder() {
    const name = h('input', { class: 'input', placeholder: 'my-new-project', autocapitalize: 'off', autocorrect: 'off' });
    const s = sheet('New folder', h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { path } = await api('/api/projects', { method: 'POST', body: { name: name.value.trim() } });
          openProjects.add(path);
          store.set('openProjects', [...openProjects]);
          s.close();
          load();
        } catch (ex) {
          toast(ex.message, { error: true });
        }
      },
    }, h('div', { class: 'field' }, h('label', {}, `Created inside ${globalState.config.baseDir}`), name), h('div', { class: 'btns' }, h('button', { class: 'btn primary', type: 'submit' }, 'Create'))));
    name.focus();
  }

  const unsub = ws.on((msg) => { if (msg.t === 'live') load(); });
  load();
  const timer = setInterval(() => !document.hidden && load(), 10_000);
  return () => { clearInterval(timer); unsub(); };
}

function modeSelect(value, onchange) {
  const modes = globalState.config?.permissionModes || ['default'];
  const labels = { default: 'Ask', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto', dontAsk: "Don't ask", bypassPermissions: 'Bypass ⚠' };
  const sel = h('select', { class: 'input', title: 'Permission mode', onchange: () => onchange?.(sel.value) }, modes.map((m) => h('option', { value: m, selected: m === value }, labels[m] || m)));
  return sel;
}

function modelSelect(value = '') {
  const models = [['', 'Default model'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
  return h('select', { class: 'input' }, models.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

function newSession(project) {
  const prompt = h('textarea', { class: 'input', rows: 4, placeholder: 'What should Claude work on? (optional)' });
  const mode = modeSelect(store.get('lastMode', globalState.config.defaultPermissionMode));
  const model = modelSelect(store.get('lastModel', ''));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Start session');
  const s = sheet(`New session · ${project.name}`, h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      store.set('lastMode', mode.value);
      store.set('lastModel', model.value);
      try {
        const { sessionId } = await api('/api/sessions', { method: 'POST', body: { cwd: project.path, prompt: prompt.value.trim(), permissionMode: mode.value, model: model.value } });
        s.close();
        location.hash = `#/s/${sessionId}?cwd=${encodeURIComponent(project.path)}`;
      } catch (ex) {
        toast(ex.message, { error: true });
        btn.disabled = false;
      }
    },
  },
  h('div', { class: 'field' }, h('label', {}, 'First message'), prompt),
  h('div', { style: 'display:flex;gap:10px' },
    h('div', { class: 'field', style: 'flex:1' }, h('label', {}, 'Permissions'), mode),
    h('div', { class: 'field', style: 'flex:1' }, h('label', {}, 'Model'), model)),
  h('div', { class: 'btns' }, btn)));
  prompt.focus();
}

// ---------------------------------------------------------------- session view

function sessionView(id, cwdParam) {
  globalState.viewingSession = id;
  const S = {
    mode: 'loading', // live | stored | external
    meta: null,
    status: null,
    cwd: cwdParam || '',
    title: '',
    entries: [],
    results: new Map(), // toolUseId -> tool_result entry
    tasks: new Map(),
    pending: new Map(),
    historyTotal: 0,
    external: null,
    attachments: [],
    agentView: null, // { refresh() } of the open agents sheet
  };
  let pollTimer = null;
  let disposed = false;

  // --- DOM
  const titleEl = h('h1', {}, 'Loading…');
  const subEl = h('div', { class: 'sub' });
  const agentsCount = h('span', { class: 'count', hidden: true });
  const agentsBtn = h('button', { class: 'icon-btn agents-btn', title: 'Agents & tasks', onclick: () => openAgents() }, h('span', { html: icons.agents, style: 'display:inline-grid' }), agentsCount);
  const moreBtn = h('button', { class: 'icon-btn', title: 'More', html: icons.more, onclick: (e) => { e.stopPropagation(); toggleMenu(); } });
  const bannerWrap = h('div', { class: 'banner-wrap' });
  const inner = h('div', { class: 'transcript-inner' });
  const transcript = h('div', { class: 'transcript' }, inner);
  const jumpBtn = h('button', { class: 'btn small jump', hidden: true, onclick: () => scrollToBottom(true) }, '↓ Latest');
  const pendingBox = h('div', { class: 'pending' });
  const statusDot = h('span', { class: 'dot' });
  const statusText = h('span', {});
  const costEl = h('span', {});
  const modeBox = h('span', {});
  const attBox = h('div', { class: 'attachments', hidden: true });
  const cmdBox = h('div', { class: 'cmd-suggest', hidden: true });
  const textarea = h('textarea', { rows: 1, placeholder: 'Message Claude…', enterkeyhint: touch ? 'enter' : 'send' });
  const fileInput = h('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true, onchange: () => addFiles(fileInput.files) });
  const sendBtn = h('button', { class: 'send', title: 'Send', html: icons.send, onclick: () => onSendClick() });

  app.replaceChildren(h('div', { class: 'session' },
    h('div', { class: 'topbar' },
      h('button', { class: 'icon-btn', title: 'Back', html: icons.back, onclick: () => (location.hash = '#/') }),
      h('div', { class: 'title' }, titleEl, subEl),
      agentsBtn, moreBtn),
    bannerWrap,
    h('div', { class: 'transcript-box' }, transcript, jumpBtn),
    pendingBox,
    h('div', { class: 'composer-wrap' },
      h('div', { class: 'statusline' }, statusDot, statusText, costEl, h('span', { class: 'spacer' }), modeBox),
      attBox, cmdBox,
      h('div', { class: 'composer' },
        h('button', { class: 'icon-btn', title: 'Attach image', html: icons.image, onclick: () => fileInput.click() }),
        textarea, fileInput, sendBtn))));

  const feed = new Feed(inner, { filter: (e) => !e.parent, onAgentClick: (entry, result) => openAgents(entry.toolUseId, result) });

  // --- scrolling
  const nearBottom = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 150;
  function scrollToBottom(force) {
    if (force || nearBottom()) {
      transcript.scrollTop = transcript.scrollHeight;
      jumpBtn.hidden = true;
    } else {
      jumpBtn.hidden = false;
    }
  }
  transcript.addEventListener('scroll', () => nearBottom() && (jumpBtn.hidden = true));
  const withScroll = (fn) => {
    const stick = nearBottom();
    fn();
    if (stick) requestAnimationFrame(() => (transcript.scrollTop = transcript.scrollHeight));
    else jumpBtn.hidden = false;
  };

  // --- header / status
  function renderHeader() {
    const title = S.meta?.title || S.title || 'Session';
    titleEl.textContent = title;
    document.title = `${title} · Claude Remote`;
    const status = S.pending.size ? 'requires_action' : S.status;
    const where = S.mode === 'external' ? `open in ${S.external?.entrypoint?.replace(/^claude-/, '') || 'terminal'}` : S.mode === 'stored' ? 'not running' : STATUS_TEXT[status] || status || '';
    subEl.replaceChildren(h('span', { class: `dot ${S.mode === 'stored' ? '' : status || ''}` }), h('span', {}, basename(S.cwd || S.meta?.cwd)), '·', h('span', {}, where));

    statusDot.className = `dot ${S.mode === 'stored' ? '' : status || ''}`;
    statusText.textContent = S.mode === 'live' ? STATUS_TEXT[status] || status || '' : S.mode === 'external' ? `Running in ${S.external?.entrypoint || 'another process'} (${S.external?.status || '?'}) — watching` : S.mode === 'stored' ? 'Not running — sending resumes it' : '';
    costEl.textContent = S.meta?.costUsd ? `· $${S.meta.costUsd.toFixed(2)}` : '';

    const working = S.mode === 'live' && ['running', 'requires_action', 'starting'].includes(S.status);
    sendBtn.classList.toggle('stop', working && !textarea.value.trim() && !S.attachments.length);
    sendBtn.innerHTML = sendBtn.classList.contains('stop') ? icons.stop : icons.send;
    sendBtn.title = sendBtn.classList.contains('stop') ? 'Interrupt' : 'Send';
    if (S.mode !== 'loading' && !modeBox.firstChild) renderModeSelect();
    renderAgentsBadge();
  }

  function renderModeSelect() {
    const current = S.meta?.permissionMode || store.get('lastMode', globalState.config.defaultPermissionMode);
    const sel = modeSelect(current, async (mode) => {
      store.set('lastMode', mode);
      if (isLive()) {
        try { await ws.send({ t: 'mode', sessionId: id, mode }); } catch (e) { toast(e.message, { error: true }); }
      }
    });
    sel.className = '';
    modeBox.replaceChildren(sel);
    S.modeSel = sel;
  }

  const isLive = () => S.mode === 'live' && !['closed', 'error'].includes(S.status);

  // --- agents
  function deriveAgents() {
    const agents = [];
    const byToolUse = new Map();
    for (const e of S.entries) {
      if (e.kind !== 'tool_use' || !AGENT_TOOLS.has(e.name)) continue;
      const a = { key: e.toolUseId, toolUseId: e.toolUseId, description: e.input?.description || 'Agent', subagentType: e.input?.subagent_type, prompt: e.input?.prompt, parent: e.parent, history: e.history };
      agents.push(a);
      byToolUse.set(e.toolUseId, a);
    }
    for (const t of S.tasks.values()) {
      const a = t.toolUseId && byToolUse.get(t.toolUseId);
      if (a) a.task = t;
      else agents.push({ key: t.taskId, description: t.description, subagentType: t.subagentType || t.taskType, prompt: t.prompt, task: t });
    }
    for (const a of agents) {
      const r = a.toolUseId && S.results.get(a.toolUseId);
      a.result = r;
      a.status = a.task?.status || (r ? (r.isError ? 'failed' : 'completed') : isLive() && !a.history ? 'running' : 'unknown');
    }
    return agents.reverse();
  }

  function renderAgentsBadge() {
    const running = S.mode === 'live' ? deriveAgents().filter((a) => a.status === 'running').length : 0;
    agentsCount.hidden = !running;
    agentsCount.textContent = running;
  }

  function agentMeta(a) {
    const u = a.task?.usage;
    return [a.subagentType, u && `${u.tool_uses} tools`, u && `${Math.round(u.total_tokens / 1000)}k tok`, u && duration(u.duration_ms), a.task?.background && 'background'].filter(Boolean).join(' · ');
  }

  function openAgents(focusToolUseId, resultEntry) {
    const body = h('div');
    let detail = focusToolUseId || null;
    const s = sheet('Agents & tasks', body, { onclose: () => (S.agentView = null) });

    async function renderStoredList() {
      body.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
      const derived = deriveAgents();
      try {
        const { agents } = await api(`/api/sessions/${id}/agents?cwd=${encodeURIComponent(S.cwd)}`);
        if (!agents.length && !derived.length) return body.replaceChildren(h('div', { class: 'empty' }, 'This session has not spawned any agents.'));
        body.replaceChildren(
          ...derived.map((a) => h('div', { class: 'agent-item', onclick: () => openStoredAgent(agentIdFromResult(a.result), a) },
            h('span', { class: `dot ${a.status === 'completed' ? 'idle' : a.status === 'failed' ? 'error' : ''}` }),
            h('div', { class: 'main' }, h('div', { class: 'name' }, a.description, h('span', { class: 'badge' }, a.status)), h('div', { class: 'meta' }, agentMeta(a))))),
          derived.length && agents.length ? h('div', { class: 'section-title' }, 'Agent transcripts') : null,
          ...agents.map((ag) => h('div', { class: 'agent-item', onclick: () => openStoredAgent(ag.agentId) },
            h('div', { class: 'main' }, h('div', { class: 'name' }, ag.prompt?.split('\n')[0]?.slice(0, 90) || ag.agentId), h('div', { class: 'meta' }, `${ag.messages} messages · ${relTime(ag.lastTs)}`)))));
      } catch (e) {
        body.replaceChildren(h('div', { class: 'empty' }, e.message));
      }
    }

    async function openStoredAgent(agentId, a) {
      if (!agentId) {
        if (a) {
          body.replaceChildren(backLink(renderStoredList), h('div', { class: 'agent-feed' }, h('div', { class: 'prompt' }, a.prompt || ''), a.result ? md(a.result.text || '') : h('div', { class: 'empty' }, 'No transcript found for this agent.')));
        }
        return;
      }
      body.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
      try {
        const { entries } = await api(`/api/sessions/${id}/agents/${agentId}?cwd=${encodeURIComponent(S.cwd)}`);
        const box = h('div', { class: 'agent-feed' });
        const f = new Feed(box, { filter: () => true });
        f.add(entries.map((e) => (e.kind === 'user' ? { ...e, kind: 'prompt' } : e)));
        f.settleOpenTools();
        body.replaceChildren(backLink(renderStoredList), box);
      } catch (e) {
        body.replaceChildren(backLink(renderStoredList), h('div', { class: 'empty' }, e.message));
      }
    }

    function backLink(fn) {
      return h('button', { class: 'btn small ghost', style: 'margin-bottom:8px', onclick: fn }, '← All agents');
    }

    // Detail view is updated incrementally so scroll position and expanded cards survive new events.
    let detailView = null; // { key, feed, box, header, footer }
    function renderLive() {
      const agents = deriveAgents();
      if (detail) {
        const a = agents.find((x) => x.toolUseId === detail || x.key === detail);
        if (!a) { detail = null; return renderLive(); }
        if (detailView?.key !== a.key) {
          const box = h('div', { class: 'agent-feed' });
          const f = new Feed(box, { filter: (e) => e.parent === a.toolUseId, onAgentClick: (entry) => { detail = entry.toolUseId; renderLive(); } });
          detailView = { key: a.key, feed: f, box, header: h('div'), footer: h('div') };
          body.replaceChildren(
            backLink(() => { detail = null; detailView = null; renderLive(); }),
            detailView.header,
            a.prompt ? h('details', {}, h('summary', { style: 'cursor:pointer;font-size:13px;color:var(--muted)' }, 'Prompt'), h('div', { class: 'prompt' }, a.prompt)) : '',
            box,
            detailView.footer);
        }
        const { feed: f, box } = detailView;
        f.running = a.status === 'running';
        const scroller = s.el.querySelector('.sheet');
        const stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
        f.add(S.entries.filter((e) => e.parent === a.toolUseId || e.kind === 'tool_result'));
        if (!f.running) f.settleOpenTools();
        if (stick) scroller.scrollTop = scroller.scrollHeight;
        detailView.header.replaceChildren(
          h('div', { class: 'agent-item', style: 'cursor:default' },
            h('span', { class: `dot ${a.status === 'running' ? 'running' : a.status === 'completed' ? 'idle' : a.status === 'failed' || a.status === 'killed' ? 'error' : ''}` }),
            h('div', { class: 'main' },
              h('div', { class: 'name' }, a.description, h('span', { class: 'badge' }, a.status)),
              h('div', { class: 'meta' }, agentMeta(a)),
              a.task?.summary && h('div', { class: 'summary' }, a.task.summary)),
            a.status === 'running' && a.task && h('button', { class: 'btn small danger', onclick: () => ws.send({ t: 'stop_task', sessionId: id, taskId: a.task.taskId }).catch((e) => toast(e.message, { error: true })) }, 'Stop')));
        detailView.footer.replaceChildren(
          box.childElementCount ? '' : h('div', { class: 'empty' }, a.status === 'running' ? 'Waiting for activity…' : 'No activity recorded in this view.'),
          // The final report is already in the feed when subagent text was forwarded.
          (a.task?.result || (a.result && a.status !== 'running')) && !box.querySelector('.msg-text') ? h('div', {}, h('div', { class: 'section-title' }, 'Result'), md(a.task?.result || a.result?.text || '')) : '');
        return;
      }
      detailView = null;
      if (!agents.length) return body.replaceChildren(h('div', { class: 'empty' }, 'No agents or background tasks in this session yet.'));
      body.replaceChildren(...agents.map((a) => h('div', { class: 'agent-item', onclick: () => { detail = a.key; renderLive(); } },
        h('span', { class: `dot ${a.status === 'running' ? 'running' : a.status === 'completed' ? 'idle' : a.status === 'failed' || a.status === 'killed' ? 'error' : ''}` }),
        h('div', { class: 'main' },
          h('div', { class: 'name' }, a.description, h('span', { class: 'badge' }, a.status)),
          h('div', { class: 'meta' }, agentMeta(a) || (a.task?.lastTool ? `last: ${a.task.lastTool}` : '')),
          a.task?.summary && h('div', { class: 'summary' }, a.task.summary)),
        h('span', { class: 'chev', html: icons.chev }))));
    }

    if (S.mode === 'live') {
      S.agentView = { refresh: renderLive };
      renderLive();
    } else if (focusToolUseId) {
      const a = deriveAgents().find((x) => x.toolUseId === focusToolUseId);
      openStoredAgent(agentIdFromResult(resultEntry || a?.result), a);
    } else {
      renderStoredList();
    }
    return s;
  }

  const agentIdFromResult = (r) => r?.text?.match(/agentId:\s*([\w-]+)/)?.[1] || null;

  // --- permissions
  function renderPending() {
    pendingBox.replaceChildren(...[...S.pending.values()].map(permissionCard));
    renderHeader();
    if (S.pending.size) requestAnimationFrame(() => scrollToBottom(true));
  }

  function decide(req, decision, extra = {}) {
    return ws.send({ t: 'permission', sessionId: id, id: req.id, decision, ...extra }).catch((e) => toast(e.message, { error: true }));
  }

  function permissionCard(req) {
    const from = req.agentId ? h('span', { class: 'badge accent', style: 'margin-left:6px' }, 'subagent') : null;
    if (req.toolName === 'AskUserQuestion') return questionCard(req, from);
    if (req.toolName === 'ExitPlanMode') {
      const feedback = h('textarea', { class: 'input', rows: 2, placeholder: 'What should change? (optional)' });
      return h('div', { class: 'perm' },
        h('div', { class: 'ptitle' }, 'Claude has a plan. Ready to start?', from),
        h('div', { class: 'plan' }, md(String(req.input?.plan || '(no plan text)'))),
        h('div', { class: 'btns' },
          h('button', { class: 'btn primary', onclick: () => decide(req, 'allow', { mode: 'acceptEdits' }) }, 'Approve + auto-accept edits'),
          h('button', { class: 'btn', onclick: () => decide(req, 'allow', { mode: 'default' }) }, 'Approve')),
        h('div', { style: 'margin-top:10px' }, feedback),
        h('div', { class: 'btns', style: 'margin-top:8px' }, h('button', { class: 'btn', onclick: () => decide(req, 'deny', { message: feedback.value || 'Keep planning.' }) }, 'Keep planning')));
    }
    const denyMsg = h('textarea', { class: 'input', rows: 2, placeholder: 'Tell Claude what to do instead (optional)', hidden: true });
    const denyBtn = h('button', { class: 'btn danger', onclick: () => {
      if (denyMsg.hidden && touch) { denyMsg.hidden = false; denyBtn.textContent = 'Confirm deny'; return; }
      decide(req, 'deny', { message: denyMsg.value });
    } }, 'Deny');
    return h('div', { class: 'perm' },
      h('div', { class: 'ptitle' }, req.title || `Allow ${req.displayName || req.toolName}?`, from),
      (req.description || req.decisionReason) && h('div', { class: 'pdesc' }, req.description || req.decisionReason),
      h('div', {}, toolInputView(req.toolName, req.input)),
      denyMsg,
      h('div', { class: 'btns', style: 'margin-top:10px' },
        req.defaultToNo ? denyBtn : null,
        h('button', { class: 'btn primary', onclick: () => decide(req, 'allow') }, 'Allow'),
        req.canAlwaysAllow && h('button', { class: 'btn', onclick: () => decide(req, 'always') }, 'Always allow'),
        req.defaultToNo ? null : denyBtn));
  }

  function questionCard(req, from) {
    const qs = req.input?.questions || [];
    const inputs = qs.map((q, qi) => {
      const type = q.multiSelect ? 'checkbox' : 'radio';
      const other = h('input', { class: 'input', placeholder: 'Other…', style: 'margin-top:4px' });
      const opts = q.options.map((o) => h('label', { class: 'opt' }, h('input', { type, name: `q${req.id}${qi}`, value: o.label }), h('div', {}, o.label, o.description && h('small', {}, o.description))));
      return { q, other, el: h('div', { class: 'question' }, h('div', { class: 'q' }, q.header ? h('span', { class: 'badge', style: 'margin-right:6px' }, q.header) : null, q.question), opts, other) };
    });
    const submit = () => {
      const answers = {};
      for (const { q, other, el } of inputs) {
        const picked = [...el.querySelectorAll('input:checked')].map((i) => i.value);
        if (other.value.trim()) picked.push(other.value.trim());
        if (!picked.length) return toast(`Please answer: ${q.question}`, { error: true });
        answers[q.question] = picked.join(', ');
      }
      decide(req, 'allow', { answers });
    };
    return h('div', { class: 'perm' },
      h('div', { class: 'ptitle' }, 'Claude has a question', from),
      inputs.map((i) => i.el),
      h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: submit }, 'Submit answers'), h('button', { class: 'btn', onclick: () => decide(req, 'deny', { message: 'The user skipped the question.' }) }, 'Skip')));
  }

  // --- menu
  let menuEl = null;
  function toggleMenu() {
    if (menuEl) return closeMenu();
    const item = (label, fn) => h('button', { onclick: () => { closeMenu(); fn(); } }, label);
    menuEl = h('div', { class: 'menu' },
      isLive() && item('Interrupt Claude', () => ws.send({ t: 'interrupt', sessionId: id })),
      isLive() && item('Change model…', changeModel),
      item('Fork into new session…', () => forkSession()),
      item('Copy session ID', () => navigator.clipboard?.writeText(id).then(() => toast('Copied'))),
      isLive() && h('hr'),
      isLive() && item('Close session', async () => {
        await api(`/api/sessions/${id}/close`, { method: 'POST' }).catch((e) => toast(e.message, { error: true }));
      }));
    app.querySelector('.session').append(menuEl);
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }));
  }
  function closeMenu() {
    menuEl?.remove();
    menuEl = null;
  }

  function changeModel() {
    const sel = modelSelect('');
    const s = sheet('Change model', h('div', {}, h('div', { class: 'field' }, h('label', {}, `Current: ${S.meta?.model || 'default'}`), sel),
      h('div', { class: 'btns' }, h('button', { class: 'btn primary', onclick: async () => {
        try { await ws.send({ t: 'model', sessionId: id, model: sel.value }); s.close(); } catch (e) { toast(e.message, { error: true }); }
      } }, 'Switch'))));
  }

  function forkSession(prefill = '') {
    const prompt = h('textarea', { class: 'input', rows: 3, placeholder: 'First message in the fork' }, prefill);
    const s = sheet('Fork session', h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { sessionId } = await api('/api/sessions', { method: 'POST', body: { cwd: S.cwd, resume: id, fork: true, prompt: prompt.value.trim(), permissionMode: S.modeSel?.value } });
          s.close();
          location.hash = `#/s/${sessionId}?cwd=${encodeURIComponent(S.cwd)}`;
        } catch (ex) {
          toast(ex.message, { error: true });
        }
      },
    }, h('p', { style: 'margin-top:0;color:var(--muted);font-size:14px' }, 'Creates a new session that starts with this conversation\'s history. The original stays untouched.'),
    h('div', { class: 'field' }, prompt), h('div', { class: 'btns' }, h('button', { class: 'btn primary', type: 'submit' }, 'Fork & send'))));
  }

  // --- composer
  const draftKey = `draft:${id}`;
  textarea.value = store.get(draftKey, '');
  const autosize = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, window.innerHeight * 0.4)}px`;
  };
  textarea.addEventListener('input', () => {
    autosize();
    store.set(draftKey, textarea.value);
    renderCmdSuggest();
    renderHeader();
  });
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !touch && !e.isComposing) {
      e.preventDefault();
      doSend();
    }
  });
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  requestAnimationFrame(autosize);

  function renderCmdSuggest() {
    const v = textarea.value;
    const cmds = S.meta?.slashCommands || [];
    if (!v.startsWith('/') || v.includes(' ') || !cmds.length) return (cmdBox.hidden = true);
    const matches = cmds.filter((c) => `/${c}`.startsWith(v)).slice(0, 15);
    cmdBox.hidden = !matches.length;
    cmdBox.replaceChildren(...matches.map((c) => h('button', { onclick: () => { textarea.value = `/${c} `; textarea.focus(); cmdBox.hidden = true; } }, `/${c}`)));
  }

  async function addFiles(files) {
    for (const f of [...files].slice(0, 6 - S.attachments.length)) {
      try {
        S.attachments.push(await downscale(f));
      } catch {
        toast(`Could not read ${f.name}`, { error: true });
      }
    }
    fileInput.value = '';
    renderAttachments();
  }
  function renderAttachments() {
    attBox.hidden = !S.attachments.length;
    attBox.replaceChildren(...S.attachments.map((src, i) => h('div', { class: 'att' }, h('img', { src, alt: '' }), h('button', { onclick: () => { S.attachments.splice(i, 1); renderAttachments(); } }, '×'))));
    renderHeader();
  }

  function onSendClick() {
    if (sendBtn.classList.contains('stop')) return ws.send({ t: 'interrupt', sessionId: id }).catch((e) => toast(e.message, { error: true }));
    doSend();
  }

  async function doSend() {
    const text = textarea.value.trim();
    const images = S.attachments.slice();
    if (!text && !images.length) return;
    if (S.mode === 'external') return forkSession(text);
    sendBtn.disabled = true;
    try {
      if (isLive()) {
        await ws.send({ t: 'send', sessionId: id, text, images });
      } else {
        // Resume the stored session in this server, then subscribe to it.
        await api('/api/sessions', { method: 'POST', body: { cwd: S.cwd, resume: id, prompt: text, images, permissionMode: S.modeSel?.value } });
        subscribe();
      }
      textarea.value = '';
      store.set(draftKey, '');
      S.attachments = [];
      renderAttachments();
      autosize();
      cmdBox.hidden = true;
      requestAnimationFrame(() => scrollToBottom(true));
    } catch (e) {
      toast(e.message, { error: true });
    } finally {
      sendBtn.disabled = false;
      renderHeader();
    }
  }

  // --- data flow
  function addEntries(entries) {
    withScroll(() => {
      for (const e of entries) {
        S.entries.push(e);
        if (e.kind === 'tool_result') S.results.set(e.toolUseId, e);
      }
      feed.add(entries);
    });
    S.agentView?.refresh();
    renderAgentsBadge();
  }

  function subscribe() {
    if (ws.open) ws.sock.send(JSON.stringify({ t: 'subscribe', sessionId: id }));
  }

  async function loadStored() {
    try {
      const res = await api(`/api/sessions/${id}/history?cwd=${encodeURIComponent(S.cwd)}`);
      if (disposed || S.mode === 'live') return;
      S.cwd = S.cwd || res.cwd || '';
      S.title = res.title || S.title;
      S.historyTotal = res.total;
      S.entries = [];
      S.results.clear();
      feed.clear();
      feed.running = false;
      addEntries(res.entries);
      // In a session running elsewhere the last open tool is genuinely still in progress.
      if (res.external) {
        const open = [...feed.tools.values()].filter((t) => !t.result);
        feed.settleOpenTools();
        const last = open.pop();
        if (last) feed.setToolState(last.entry.toolUseId, 'pending');
      } else {
        feed.settleOpenTools();
      }
      setExternal(res.external);
      requestAnimationFrame(() => scrollToBottom(true));
    } catch (e) {
      titleEl.textContent = 'Session not found';
      inner.replaceChildren(h('div', { class: 'empty' }, e.message));
    }
  }

  function setExternal(ext) {
    S.external = ext;
    S.mode = ext ? 'external' : 'stored';
    S.status = ext?.status || null;
    bannerWrap.replaceChildren(ext
      ? h('div', { class: 'banner warn' }, `This session is open in ${ext.entrypoint || 'another process'} (${ext.status}). You're watching it live. Sending a message creates a fork.`)
      : []);
    clearTimeout(pollTimer);
    if (ext) {
      feed.running = true;
      pollTimer = setTimeout(pollExternal, 2500);
    }
    renderHeader();
  }

  async function pollExternal() {
    if (disposed || S.mode !== 'external') return;
    if (document.hidden) { pollTimer = setTimeout(pollExternal, 5000); return; }
    try {
      const res = await api(`/api/sessions/${id}/history?cwd=${encodeURIComponent(S.cwd)}&offset=${S.historyTotal}`);
      if (disposed || S.mode !== 'external') return;
      if (res.reset) return loadStored();
      S.historyTotal = res.total;
      addEntries(res.entries);
      if (!res.external) feed.settleOpenTools();
      setExternal(res.external);
    } catch {
      pollTimer = setTimeout(pollExternal, 5000);
    }
  }

  const unsub = ws.on((msg) => {
    if (msg.t === '_open') return subscribe();
    if (msg.t === 'live') {
      // Someone (maybe another tab) started this session while we were viewing it read-only.
      if (S.mode !== 'live' && msg.sessions.some((s) => s.sessionId === id)) subscribe();
      return;
    }
    if (msg.sessionId !== id) return;
    switch (msg.t) {
      case 'not_live':
        if (S.mode === 'live' || S.mode === 'loading') {
          S.mode = 'loading';
          loadStored();
        }
        break;
      case 'snapshot':
        clearTimeout(pollTimer);
        bannerWrap.replaceChildren();
        S.mode = 'live';
        S.meta = msg.meta;
        S.cwd = msg.meta.cwd;
        S.status = msg.meta.status;
        S.entries = [];
        S.results.clear();
        S.tasks = new Map(msg.tasks.map((t) => [t.taskId, t]));
        S.pending = new Map(msg.pending.map((p) => [p.id, p]));
        feed.clear();
        feed.running = true;
        addEntries(msg.entries);
        for (const t of S.tasks.values()) if (t.toolUseId) feed.setToolState(t.toolUseId, taskState(t.status));
        renderModeSelect();
        renderPending();
        requestAnimationFrame(() => scrollToBottom(true));
        break;
      case 'entries':
        addEntries(msg.entries);
        break;
      case 'delta':
        withScroll(() => feed.delta(msg.text));
        break;
      case 'status':
        S.status = msg.status;
        if (msg.status === 'closed' || msg.status === 'error') {
          feed.clearDraft();
          feed.settleOpenTools();
        }
        renderHeader();
        break;
      case 'meta':
        S.meta = msg.meta;
        if (S.modeSel && S.modeSel.value !== msg.meta.permissionMode) S.modeSel.value = msg.meta.permissionMode;
        renderHeader();
        break;
      case 'result':
        feed.clearDraft();
        S.meta = { ...S.meta, costUsd: msg.costUsd };
        withScroll(() => inner.append(h('div', { class: 'msg-result' }, `✓ ${duration(msg.durationMs)}${msg.costUsd ? ` · $${msg.costUsd.toFixed(2)} total` : ''}`)));
        renderHeader();
        break;
      case 'task':
        S.tasks.set(msg.task.taskId, msg.task);
        if (msg.task.toolUseId) feed.setToolState(msg.task.toolUseId, taskState(msg.task.status));
        S.agentView?.refresh();
        renderAgentsBadge();
        break;
      case 'permission':
        S.pending.set(msg.request.id, msg.request);
        renderPending();
        if (document.hidden) notify('Claude needs approval', msg.request.title || msg.request.toolName, `/#/s/${id}`);
        break;
      case 'permission_resolved':
        S.pending.delete(msg.id);
        renderPending();
        break;
      default:
        break;
    }
  });

  const taskState = (s) => (s === 'running' || s === 'pending' ? 'pending' : s === 'completed' ? 'ok' : s === 'failed' || s === 'killed' ? 'err' : 'unknown');

  renderHeader();
  if (ws.open) subscribe();

  return () => {
    disposed = true;
    clearTimeout(pollTimer);
    unsub();
    closeMenu();
    if (ws.open) ws.sock.send(JSON.stringify({ t: 'unsubscribe' }));
  };
}

// Downscale images so phone photos don't blow up the request/context.
function downscale(file, max = 1600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL(file.type === 'image/png' && scale === 1 ? 'image/png' : 'image/jpeg', 0.85));
    };
    img.onerror = reject;
    img.src = url;
  });
}

boot().catch((e) => {
  app.replaceChildren(h('div', { class: 'login' }, h('div', {}, `Failed to start: ${e.message}`)));
});
