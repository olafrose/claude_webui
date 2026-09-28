// DOM helpers and transcript rendering.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const svg = (d, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
export const icons = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  chev: svg('<path d="M9 18l6-6-6-6"/>', 'width="18" height="18"'),
  send: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  stop: svg('<rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/>'),
  more: svg('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/>'),
  agents: svg('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4M9 14h.01M15 14h.01"/><circle cx="12" cy="3" r="1"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  refresh: svg('<path d="M21 12a9 9 0 11-3-6.7L21 8M21 3v5h-5"/>'),
  computer: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
  bell: svg('<path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"/>'),
};
export const iconEl = (name) => h('span', { html: icons[name], style: 'display:inline-grid' });

let purifyHooked = false;
export function md(text) {
  if (!window.marked || !window.DOMPurify) return h('div', { class: 'msg-text', style: 'white-space:pre-wrap' }, text);
  if (!purifyHooked) {
    window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    purifyHooked = true;
  }
  const html = window.DOMPurify.sanitize(window.marked.parse(text, { gfm: true, breaks: false }));
  return h('div', { class: 'msg-text', html });
}

export function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function duration(ms) {
  if (!ms && ms !== 0) return '';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const basename = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
export const AGENT_TOOLS = new Set(['Agent', 'Task']);

export function toolSummary(name, input = {}) {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return input.description || input.command;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return basename(input.file_path);
    case 'NotebookEdit':
      return basename(input.notebook_path);
    case 'Grep':
      return `${input.pattern}${input.path ? ` in ${basename(input.path)}` : ''}`;
    case 'Glob':
      return input.pattern;
    case 'WebFetch':
      return input.url;
    case 'WebSearch':
      return input.query;
    case 'Agent':
    case 'Task':
      return `${input.description || ''}${input.subagent_type ? ` · ${input.subagent_type}` : ''}`;
    case 'TodoWrite':
      return `${input.todos?.length || 0} todos`;
    case 'Skill':
      return input.skill;
    case 'AskUserQuestion':
      return input.questions?.[0]?.question;
    default: {
      const v = Object.values(input).find((x) => typeof x === 'string');
      return v ? v.slice(0, 120) : '';
    }
  }
}

function diffView(oldStr = '', newStr = '') {
  return h(
    'div',
    { class: 'diff' },
    String(oldStr).split('\n').map((l) => h('div', { class: 'del' }, `- ${l}`)),
    String(newStr).split('\n').map((l) => h('div', { class: 'add' }, `+ ${l}`)),
  );
}

export function todoList(todos = []) {
  const mark = { completed: '✓', in_progress: '▸', pending: '○' };
  return h('ul', { class: 'todos' }, todos.map((t) => h('li', { class: t.status }, h('span', {}, mark[t.status] || '○'), h('span', {}, t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content))));
}

export function toolInputView(name, input = {}) {
  const label = (t) => h('div', { class: 'label' }, t);
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return [label('Command'), h('pre', {}, input.command || '')];
    case 'Edit':
      return [label(input.file_path || ''), diffView(input.old_string, input.new_string)];
    case 'MultiEdit':
      return [label(input.file_path || ''), ...(input.edits || []).map((e) => diffView(e.old_string, e.new_string))];
    case 'Write':
      return [label(input.file_path || ''), h('pre', {}, input.content || '')];
    case 'TodoWrite':
      return [todoList(input.todos)];
    case 'Agent':
    case 'Task':
      return [label('Prompt'), h('pre', {}, input.prompt || '')];
    default:
      return [label('Input'), h('pre', {}, JSON.stringify(input, null, 2))];
  }
}

/**
 * Renders a list of entries into a container, linking tool results to their tool_use cards.
 * `filter(entry)` decides which non-result entries belong to this feed.
 */
export class Feed {
  constructor(container, { filter = (e) => !e.parent, onAgentClick } = {}) {
    this.container = container;
    this.filter = filter;
    this.onAgentClick = onAgentClick;
    this.tools = new Map(); // toolUseId -> { entry, result, el, stateEl, body }
    this.seen = new Set();
    this.draft = null;
    this.running = false;
  }

  clear() {
    this.container.replaceChildren();
    this.tools.clear();
    this.seen.clear();
    this.draft = null;
  }

  add(entries) {
    for (const e of entries) {
      if (this.seen.has(e.id)) continue;
      this.seen.add(e.id);
      if (e.kind === 'tool_result') {
        this.#attachResult(e);
        continue;
      }
      if (!this.filter(e)) continue;
      if (e.kind === 'text' || e.kind === 'user') this.clearDraft();
      const el = this.#render(e);
      if (el) this.container.append(el);
    }
  }

  delta(text) {
    if (!this.draft) {
      this.draft = h('div', { class: 'msg-text draft', style: 'white-space:pre-wrap' });
      this.container.append(this.draft);
    }
    this.draft.textContent += text;
  }

  clearDraft() {
    this.draft?.remove();
    this.draft = null;
  }

  /** Marks tool cards without a result as interrupted/finished (for stored transcripts). */
  settleOpenTools(state = 'unknown') {
    for (const t of this.tools.values()) if (!t.result && t.stateEl.classList.contains('pending')) this.#setState(t, state);
  }

  #setState(t, state) {
    t.stateEl.className = `tstate ${state}`;
    t.stateEl.replaceChildren(state === 'pending' ? h('span', { class: 'spinner' }) : state === 'ok' ? '✓' : state === 'err' ? '✗' : '·');
  }

  #attachResult(e) {
    const t = this.tools.get(e.toolUseId);
    if (!t) return;
    t.result = e;
    // Background agents return immediately; their real status comes from task events.
    if (!(AGENT_TOOLS.has(t.entry.name) && /async|background|launched/i.test(e.text || '') && !e.isError)) this.#setState(t, e.isError ? 'err' : 'ok');
    if (t.el.open) this.#fillBody(t);
  }

  setToolState(toolUseId, state) {
    const t = this.tools.get(toolUseId);
    if (t) this.#setState(t, state);
  }

  #fillBody(t) {
    const body = h('div', { class: 'tbody' }, toolInputView(t.entry.name, t.entry.input));
    if (AGENT_TOOLS.has(t.entry.name) && this.onAgentClick) {
      body.append(h('button', { class: 'btn small', onclick: (ev) => { ev.preventDefault(); this.onAgentClick(t.entry, t.result); } }, 'Open agent activity'));
    }
    if (t.result) body.append(h('div', { class: 'label' }, t.result.isError ? 'Error' : 'Result'), h('pre', { style: t.result.isError ? 'color:var(--err)' : '' }, t.result.text || '(no output)'));
    t.body?.remove();
    t.body = body;
    t.el.append(body);
  }

  #render(e) {
    switch (e.kind) {
      case 'user':
        return h('div', { class: 'msg-user' }, e.images?.length ? h('div', { class: 'imgs' }, e.images.map((src) => h('img', { src, alt: '' }))) : null, e.text);
      case 'prompt':
        return h('div', { class: 'prompt' }, e.text);
      case 'text':
        return md(e.text);
      case 'thinking':
        return h('details', { class: 'thinking' }, h('summary', {}, 'Thinking…'), h('div', {}, e.text));
      case 'system':
        return h('div', { class: `msg-system ${e.level || ''}` }, e.text);
      case 'tool_use': {
        const isAgent = AGENT_TOOLS.has(e.name);
        const stateEl = h('span', { class: 'tstate pending' }, h('span', { class: 'spinner' }));
        const summary = h('summary', {}, stateEl, h('span', { class: 'tname' }, isAgent ? `Agent` : e.name), h('span', { class: 'tsum' }, toolSummary(e.name, e.input) || ''));
        const el = h('details', { class: `tool${isAgent ? ' agent' : ''}` }, summary);
        const t = { entry: e, result: null, el, stateEl, body: null };
        if (!this.running || e.history) this.#setState(t, 'unknown');
        el.addEventListener('toggle', () => el.open && this.#fillBody(t));
        this.tools.set(e.toolUseId, t);
        if (e.name === 'TodoWrite') {
          // Show the todo list inline: it's the most useful progress signal on a phone.
          return h('div', {}, el, h('div', { style: 'padding:4px 12px;font-size:13.5px' }, todoList(e.input?.todos)));
        }
        return el;
      }
      default:
        return null;
    }
  }
}
