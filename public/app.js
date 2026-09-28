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

const globalState = { machines: [], live: {}, viewingSession: null, config: null };

const machineById = (id) => globalState.machines.find((m) => m.id === id);
/** Machine name for labels; empty when only one machine exists (unless `always`). */
function machineLabel(id, always = false) {
  if (!always && globalState.machines.length <= 1) return '';
  return machineById(id)?.name || id;
}
const sessionUrl = (machineId, sessionId, cwd) => `#/m/${machineId}/s/${sessionId}?cwd=${encodeURIComponent(cwd || '')}`;

ws.on((msg) => {
  if (msg.t === 'machines') globalState.machines = msg.machines;
  if (msg.t === 'live') globalState.live[msg.machineId] = msg.sessions;
  if (msg.t === 'attention') {
    const viewing = globalState.viewingSession === `${msg.machineId}/${msg.sessionId}` && !document.hidden;
    if (viewing) return;
    const hash = sessionUrl(msg.machineId, msg.sessionId, '');
    const title = msg.kind === 'permission' ? 'Claude needs approval' : 'Claude is waiting';
    const where = globalState.machines.length > 1 && msg.machineName ? ` (${msg.machineName})` : '';
    toast(`${title}${where}: ${msg.title || msg.text}`, { onclick: () => (location.hash = hash), timeout: 8000 });
    if (document.hidden) notify(title + where, `${msg.title ? msg.title + ' — ' : ''}${msg.text}`, `/${hash}`);
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
  const m = path.match(/^\/m\/([\w-]+)\/s\/([\w-]+)/);
  if (m) cleanup = sessionView(m[1], m[2], params.get('cwd'));
  else if (path === '/machines') cleanup = machinesView();
  else cleanup = dashboardView();
}
window.addEventListener('hashchange', () => authed && route());

let authed = false;
async function boot() {
  const me = await fetch('/api/me').then((r) => r.json());
  if (!me.authenticated) return showLogin(me.totp);
  authed = true;
  const [config, { machines }] = await Promise.all([api('/api/config'), api('/api/machines')]);
  globalState.config = config;
  globalState.machines = machines;
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

function statusDot(status) {
  return h('span', { class: `dot ${status || ''}`, title: STATUS_TEXT[status] || status || '' });
}

function dashboardView() {
  document.title = 'Claude Remote';
  const openProjects = new Set(store.get('openProjects', []));
  const projectsByMachine = new Map(); // machineId -> { projects } | { error }
  let live = [];
  let filter = '';
  const showAll = new Set();

  const activeBox = h('div');
  const machinesBox = h('div', {}, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));

  const notifBtn = 'Notification' in window && Notification.permission === 'default'
    ? h('button', { class: 'icon-btn', title: 'Enable notifications', html: icons.bell, onclick: async () => { await Notification.requestPermission(); notifBtn.remove(); } })
    : null;

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filter projects…', oninput: () => { filter = search.value.toLowerCase(); render(); } });

  app.replaceChildren(
    h('div', { class: 'topbar' },
      h('div', { class: 'title brand' }, h('img', { src: '/icon.svg', alt: '' }), h('h1', {}, 'Claude Remote')),
      notifBtn,
      h('a', { class: 'icon-btn', title: 'Machines', href: '#/machines', html: icons.computer }),
      h('button', { class: 'icon-btn', title: 'Refresh', html: icons.refresh, onclick: () => load() }),
      h('button', { class: 'icon-btn', title: 'Sign out', html: icons.logout, onclick: async () => { await api('/api/logout', { method: 'POST' }); location.reload(); } })),
    h('div', { class: 'page' }, activeBox, h('div', { class: 'search' }, search), machinesBox));

  function renderActive() {
    if (!live.length) return activeBox.replaceChildren();
    activeBox.replaceChildren(
      h('div', { class: 'section-title' }, 'Active now'),
      h('div', { class: 'card list' }, live.map((s) =>
        h('a', { class: 'row', href: sessionUrl(s.machineId, s.sessionId, s.cwd) },
          statusDot(s.pending ? 'requires_action' : s.status),
          h('div', { class: 'main' },
            h('div', { class: 'name' }, s.title || 'New session'),
            h('div', { class: 'meta' },
              machineLabel(s.machineId) && h('span', { class: 'badge' }, machineLabel(s.machineId)),
              h('span', {}, basename(s.cwd)), '·', h('span', {}, s.pending ? 'Needs approval' : STATUS_TEXT[s.status] || s.status),
              s.where !== 'here' ? h('span', { class: 'badge warn' }, s.where) : null,
              s.runningAgents ? h('span', { class: 'badge accent' }, `${s.runningAgents} agent${s.runningAgents > 1 ? 's' : ''}`) : null)),
          h('span', { class: 'chev', html: icons.chev })))));
  }

  function sessionRow(machine, s) {
    return h('a', { class: 'row', href: sessionUrl(machine.id, s.sessionId, s.cwd) },
      s.live ? statusDot(s.status) : null,
      h('div', { class: 'main' },
        h('div', { class: 'name' }, s.title),
        h('div', { class: 'meta' }, relTime(s.lastModified), s.gitBranch && s.gitBranch !== 'HEAD' ? h('span', { class: 'badge' }, s.gitBranch) : null,
          s.live === 'external' ? h('span', { class: 'badge warn' }, `open in ${s.external?.entrypoint?.replace(/^claude-/, '') || 'terminal'}`) : null,
          s.live === 'app' ? h('span', { class: 'badge accent' }, 'live') : null)),
      h('span', { class: 'chev', html: icons.chev }));
  }

  function projectCard(machine, p) {
    const key = `${machine.id}:${p.path}`;
    const open = openProjects.has(key);
    const toggle = () => {
      open ? openProjects.delete(key) : openProjects.add(key);
      store.set('openProjects', [...openProjects]);
      render();
    };
    const limit = showAll.has(key) ? Infinity : 6;
    return h('div', { class: `project${open ? ' open' : ''}` },
      h('div', { class: 'row', onclick: toggle },
        h('div', { class: 'main' },
          h('div', { class: 'name' }, p.name),
          h('div', { class: 'meta' },
            p.sessionCount ? `${p.sessionCount} session${p.sessionCount > 1 ? 's' : ''} · ${relTime(p.lastActivity)}` : 'No sessions yet',
            p.liveCount ? h('span', { class: 'badge accent' }, h('span', { class: 'dot running' }), `${p.liveCount} live`) : null)),
        h('span', { class: 'chev', html: icons.chev })),
      open && h('div', { class: 'sessions' },
        h('div', { class: 'actions' }, h('button', { class: 'btn primary small', onclick: () => newSession(machine, p) }, iconEl('plus'), 'New session')),
        h('div', { class: 'list' }, p.sessions.slice(0, limit).map((s) => sessionRow(machine, s))),
        p.sessions.length > limit && h('div', { class: 'actions' }, h('button', { class: 'btn small ghost', onclick: () => { showAll.add(key); render(); } }, `Show ${p.sessions.length - limit} more`))));
  }

  function render() {
    renderActive();
    const machines = globalState.machines;
    if (!machines.length) {
      return machinesBox.replaceChildren(h('div', { class: 'card', style: 'margin-top:16px' },
        h('div', { class: 'empty' }, h('p', { style: 'margin-top:0' }, 'No machines connected yet.'), h('a', { class: 'btn primary', href: '#/machines' }, iconEl('plus'), 'Add a machine'))));
    }
    machinesBox.replaceChildren(...machines.map((m) => {
      const data = projectsByMachine.get(m.id);
      const header = h('div', { class: 'section-title' },
        h('span', { class: `dot ${m.online ? 'idle' : ''}` }),
        h('span', { style: 'text-transform:none;font-size:14px;color:var(--text)' }, m.name),
        m.online && m.baseDir ? h('span', { style: 'text-transform:none;font-weight:400', title: m.baseDir }, basename(m.baseDir)) : null,
        h('span', { class: 'spacer' }),
        m.online && h('button', { class: 'btn small ghost', onclick: () => newFolder(m) }, iconEl('plus'), 'Folder'));
      let body;
      if (!m.online) body = h('div', { class: 'card' }, h('div', { class: 'empty' }, `Offline${m.lastSeen ? ` · last seen ${relTime(m.lastSeen)}` : ' · never connected'}`));
      else if (!data) body = h('div', { class: 'card' }, h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
      else if (data.error) body = h('div', { class: 'card' }, h('div', { class: 'empty' }, `Failed to load: ${data.error}`));
      else {
        const projects = data.projects.filter((p) => !filter || p.name.toLowerCase().includes(filter));
        body = h('div', { class: 'card list' }, projects.length
          ? projects.map((p) => projectCard(m, p))
          : h('div', { class: 'empty' }, filter ? 'No matching folders' : 'No folders in the base directory yet'));
      }
      return h('div', {}, header, body);
    }));
  }

  let loading = false;
  async function load() {
    if (loading) return;
    loading = true;
    try {
      const [liveNow] = await Promise.all([
        api('/api/live').catch(() => ({ sessions: [] })),
        ...globalState.machines.filter((m) => m.online).map((m) =>
          api(`/api/m/${m.id}/projects`).then((r) => projectsByMachine.set(m.id, r), (e) => projectsByMachine.set(m.id, { error: e.message }))),
      ]);
      live = liveNow.sessions;
      render();
    } finally {
      loading = false;
    }
  }

  function newFolder(machine) {
    const name = h('input', { class: 'input', placeholder: 'my-new-project', autocapitalize: 'off', autocorrect: 'off' });
    const s = sheet(`New folder on ${machine.name}`, h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { path } = await api(`/api/m/${machine.id}/projects`, { method: 'POST', body: { name: name.value.trim() } });
          openProjects.add(`${machine.id}:${path}`);
          store.set('openProjects', [...openProjects]);
          s.close();
          load();
        } catch (ex) {
          toast(ex.message, { error: true });
        }
      },
    }, h('div', { class: 'field' }, h('label', {}, `Created inside ${machine.baseDir}`), name), h('div', { class: 'btns' }, h('button', { class: 'btn primary', type: 'submit' }, 'Create'))));
    name.focus();
  }

  let reloadTimer;
  const unsub = ws.on((msg) => {
    if (msg.t === 'machines' || msg.t === 'live') {
      render();
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(load, 300);
    }
  });
  render();
  load();
  const timer = setInterval(() => !document.hidden && load(), 10_000);
  return () => { clearInterval(timer); clearTimeout(reloadTimer); unsub(); };
}

// ---------------------------------------------------------------- machines

function machinesView() {
  document.title = 'Machines · Claude Remote';
  const listBox = h('div', { class: 'card list' });
  const confirming = new Set();

  app.replaceChildren(
    h('div', { class: 'topbar' },
      h('button', { class: 'icon-btn', title: 'Back', html: icons.back, onclick: () => (location.hash = '#/') }),
      h('div', { class: 'title' }, h('h1', {}, 'Machines')),
      h('button', { class: 'btn primary small', onclick: addMachine }, iconEl('plus'), 'Add')),
    h('div', { class: 'page' },
      h('p', { style: 'color:var(--muted);font-size:14px' }, 'Each PC runs a small agent that connects out to this hub, so the PCs need no open ports. Add a machine to get its token.'),
      listBox));

  function render() {
    const machines = globalState.machines;
    if (!machines.length) return listBox.replaceChildren(h('div', { class: 'empty' }, 'No machines yet.'));
    listBox.replaceChildren(...machines.map((m) => h('div', { class: 'row', style: 'cursor:default;align-items:flex-start' },
      h('span', { class: `dot ${m.online ? 'idle' : ''}`, style: 'margin-top:8px' }),
      h('div', { class: 'main' },
        h('div', { class: 'name' }, m.name, m.embedded ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'this server') : null),
        h('div', { class: 'meta', style: 'white-space:normal;flex-wrap:wrap' },
          m.online ? 'Online' : m.lastSeen ? `Offline · last seen ${relTime(m.lastSeen)}` : 'Never connected',
          m.hostname && h('span', {}, `· ${m.hostname}`),
          m.platform && h('span', {}, `· ${m.platform}`),
          m.liveCount ? h('span', { class: 'badge accent' }, `${m.liveCount} live`) : null),
        m.baseDir && h('div', { class: 'meta' }, m.baseDir)),
      !m.embedded && h('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end' },
        h('button', { class: 'btn small', onclick: () => rename(m) }, 'Rename'),
        h('button', { class: 'btn small danger', onclick: () => revoke(m) }, confirming.has(m.id) ? 'Confirm revoke' : 'Revoke')))));
  }

  async function refresh() {
    try {
      globalState.machines = (await api('/api/machines')).machines;
    } catch (e) {
      toast(e.message, { error: true });
    }
    render();
  }

  async function revoke(m) {
    if (!confirming.has(m.id)) {
      confirming.add(m.id);
      render();
      setTimeout(() => { confirming.delete(m.id); render(); }, 5000);
      return;
    }
    try {
      await api(`/api/machines/${m.id}`, { method: 'DELETE' });
      toast(`${m.name} revoked`);
      refresh();
    } catch (e) {
      toast(e.message, { error: true });
    }
  }

  function rename(m) {
    const name = h('input', { class: 'input', value: m.name });
    const s = sheet('Rename machine', h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          await api(`/api/machines/${m.id}`, { method: 'PATCH', body: { name: name.value } });
          s.close();
          refresh();
        } catch (ex) {
          toast(ex.message, { error: true });
        }
      },
    }, h('div', { class: 'field' }, name), h('div', { class: 'btns' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'))));
    name.focus();
  }

  function addMachine() {
    const name = h('input', { class: 'input', placeholder: 'e.g. Desktop, Work laptop' });
    const body = h('div');
    const s = sheet('Add machine', body);
    body.replaceChildren(h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { token } = await api('/api/machines', { method: 'POST', body: { name: name.value } });
          showSetup(token);
          refresh();
        } catch (ex) {
          toast(ex.message, { error: true });
        }
      },
    }, h('div', { class: 'field' }, h('label', {}, 'Name'), name), h('div', { class: 'btns' }, h('button', { class: 'btn primary', type: 'submit' }, 'Create token'))));
    name.focus();

    function showSetup(token) {
      const hub = globalState.config?.publicUrl || location.origin;
      const envText = `HUB_URL=${hub}\nAGENT_TOKEN=${token}\nBASE_DIR=C:\\Users\\<you>\\source\\repos`;
      const pre = h('pre', { class: 'code-block' }, envText);
      body.replaceChildren(
        h('div', { class: 'banner warn', style: 'margin:0 0 12px' }, 'Copy the token now. It is shown only once.'),
        h('ol', { class: 'steps' },
          h('li', {}, 'On the PC: install Node.js 22+ and Claude Code, and sign in to Claude once (', h('code', {}, 'claude'), ').'),
          h('li', {}, 'Copy this project to the PC and run ', h('code', {}, 'npm install'), '.'),
          h('li', {}, 'Create a ', h('code', {}, '.env'), ' file next to ', h('code', {}, 'package.json'), ':', pre),
          h('li', {}, 'Start the agent: ', h('code', {}, 'npm run agent'))),
        h('div', { class: 'btns' },
          h('button', { class: 'btn', onclick: () => copyText(envText, pre) }, 'Copy .env'),
          h('button', { class: 'btn primary', onclick: () => s.close() }, 'Done')));
    }
  }

  const unsub = ws.on((msg) => msg.t === 'machines' && render());
  render();
  refresh();
  return unsub;
}

function copyText(text, fallbackEl) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast('Copied'), () => selectEl(fallbackEl));
  } else {
    selectEl(fallbackEl);
    toast('Selected: copy it manually');
  }
}
function selectEl(el) {
  const r = document.createRange();
  r.selectNodeContents(el);
  const sel = getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

function modeSelect(machine, value, onchange) {
  const modes = machine?.permissionModes || ['default'];
  const labels = { default: 'Ask', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto', dontAsk: "Don't ask", bypassPermissions: 'Bypass ⚠' };
  const sel = h('select', { class: 'input', title: 'Permission mode', onchange: () => onchange?.(sel.value) }, modes.map((m) => h('option', { value: m, selected: m === value }, labels[m] || m)));
  return sel;
}

function modelSelect(value = '') {
  const models = [['', 'Default model'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']];
  return h('select', { class: 'input' }, models.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
}

function newSession(machine, project) {
  const prompt = h('textarea', { class: 'input', rows: 4, placeholder: 'What should Claude work on? (optional)' });
  const mode = modeSelect(machine, store.get('lastMode', machine.defaultPermissionMode || 'default'));
  const model = modelSelect(store.get('lastModel', ''));
  const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Start session');
  const title = machineLabel(machine.id) ? `New session · ${machine.name} / ${project.name}` : `New session · ${project.name}`;
  const s = sheet(title, h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      store.set('lastMode', mode.value);
      store.set('lastModel', model.value);
      try {
        const { sessionId } = await api(`/api/m/${machine.id}/sessions`, { method: 'POST', body: { cwd: project.path, prompt: prompt.value.trim(), permissionMode: mode.value, model: model.value } });
        s.close();
        location.hash = sessionUrl(machine.id, sessionId, project.path);
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

function sessionView(mid, id, cwdParam) {
  globalState.viewingSession = `${mid}/${id}`;
  const base = `/api/m/${mid}`;
  const wsSend = (m) => ws.send({ ...m, machineId: mid });
  const sessionHash = (sid, cwd) => `#/m/${mid}/s/${sid}?cwd=${encodeURIComponent(cwd || "")}`;
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
    subEl.replaceChildren(h('span', { class: `dot ${S.mode === 'stored' ? '' : status || ''}` }), machineLabel(mid) && h('span', {}, machineLabel(mid)), machineLabel(mid) && '·', h('span', {}, basename(S.cwd || S.meta?.cwd)), '·', h('span', {}, S.mode === 'offline' ? 'machine offline' : where));

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
    const m = machineById(mid);
    const current = S.meta?.permissionMode || store.get('lastMode', m?.defaultPermissionMode || 'default');
    const sel = modeSelect(m, current, async (mode) => {
      store.set('lastMode', mode);
      if (isLive()) {
        try { await wsSend({ t: 'mode', sessionId: id, mode }); } catch (e) { toast(e.message, { error: true }); }
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
        const { agents } = await api(`${base}/sessions/${id}/agents?cwd=${encodeURIComponent(S.cwd)}`);
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
        const { entries } = await api(`${base}/sessions/${id}/agents/${agentId}?cwd=${encodeURIComponent(S.cwd)}`);
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
            a.status === 'running' && a.task && h('button', { class: 'btn small danger', onclick: () => wsSend({ t: 'stop_task', sessionId: id, taskId: a.task.taskId }).catch((e) => toast(e.message, { error: true })) }, 'Stop')));
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
    return wsSend({ t: 'permission', sessionId: id, id: req.id, decision, ...extra }).catch((e) => toast(e.message, { error: true }));
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
      isLive() && item('Interrupt Claude', () => wsSend({ t: 'interrupt', sessionId: id })),
      isLive() && item('Change model…', changeModel),
      item('Fork into new session…', () => forkSession()),
      item('Copy session ID', () => navigator.clipboard?.writeText(id).then(() => toast('Copied'))),
      isLive() && h('hr'),
      isLive() && item('Close session', async () => {
        await api(`${base}/sessions/${id}/close`, { method: 'POST' }).catch((e) => toast(e.message, { error: true }));
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
        try { await wsSend({ t: 'model', sessionId: id, model: sel.value }); s.close(); } catch (e) { toast(e.message, { error: true }); }
      } }, 'Switch'))));
  }

  function forkSession(prefill = '') {
    const prompt = h('textarea', { class: 'input', rows: 3, placeholder: 'First message in the fork' }, prefill);
    const s = sheet('Fork session', h('form', {
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const { sessionId } = await api(`${base}/sessions`, { method: 'POST', body: { cwd: S.cwd, resume: id, fork: true, prompt: prompt.value.trim(), permissionMode: S.modeSel?.value } });
          s.close();
          location.hash = sessionHash(sessionId, S.cwd);
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
    if (sendBtn.classList.contains('stop')) return wsSend({ t: 'interrupt', sessionId: id }).catch((e) => toast(e.message, { error: true }));
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
        await wsSend({ t: 'send', sessionId: id, text, images });
      } else {
        // Resume the stored session in this server, then subscribe to it.
        await api(`${base}/sessions`, { method: 'POST', body: { cwd: S.cwd, resume: id, prompt: text, images, permissionMode: S.modeSel?.value } });
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
    if (ws.open) ws.sock.send(JSON.stringify({ t: 'subscribe', machineId: mid, sessionId: id }));
  }

  async function loadStored() {
    try {
      const res = await api(`${base}/sessions/${id}/history?cwd=${encodeURIComponent(S.cwd)}`);
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
      const res = await api(`${base}/sessions/${id}/history?cwd=${encodeURIComponent(S.cwd)}&offset=${S.historyTotal}`);
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
      if (msg.machineId === mid && S.mode !== 'live' && msg.sessions.some((s) => s.sessionId === id)) subscribe();
      return;
    }
    if (msg.sessionId !== id || msg.machineId !== mid) return;
    switch (msg.t) {
      case 'machine_offline':
        // The hub re-sends a snapshot (or not_live) once the machine reconnects.
        clearTimeout(pollTimer);
        S.mode = 'offline';
        bannerWrap.replaceChildren(h('div', { class: 'banner warn' }, `${machineLabel(mid, true)} is offline. Sessions keep running there; this view reconnects automatically.`));
        renderHeader();
        break;
      case 'not_live':
        if (S.mode === 'live' || S.mode === 'loading' || S.mode === 'offline') {
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
        if (document.hidden) notify('Claude needs approval', msg.request.title || msg.request.toolName, `/${sessionHash(id, S.cwd)}`);
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
