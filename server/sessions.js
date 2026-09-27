import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { query, getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { normalizeMessage, normalizeMessages } from './normalize.js';
import { invalidateSessionCache } from './projects.js';

const MAX_ENTRIES = 3000;
const HISTORY_MESSAGES = 600;
const AGENT_TOOLS = new Set(['Agent', 'Task']);

/** Minimal async queue used as the streaming prompt input for query(). */
class InputQueue {
  #items = [];
  #waiters = [];
  #closed = false;
  push(item) {
    if (this.#closed) return;
    const w = this.#waiters.shift();
    if (w) w({ value: item, done: false });
    else this.#items.push(item);
  }
  close() {
    this.#closed = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }
  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.#items.length) return Promise.resolve({ value: this.#items.shift(), done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((r) => this.#waiters.push(r));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export class LiveSession extends EventEmitter {
  constructor({ cwd, resume, fork, permissionMode, model, title }) {
    super();
    this.cwd = cwd;
    this.sessionId = resume && !fork ? resume : crypto.randomUUID();
    this.resumedFrom = resume || null;
    this.forked = !!(resume && fork);
    this.permissionMode = permissionMode || config.defaultPermissionMode;
    this.model = model || null;
    this.title = title || null;
    this.status = 'starting'; // starting | running | idle | requires_action | closed | error
    this.entries = [];
    this.tasks = new Map(); // task_id -> task info
    this.pending = new Map(); // request id -> { req, input, suggestions, resolve }
    this.sentUuids = new Set();
    this.lastActivity = Date.now();
    this.costUsd = 0;
    this.slashCommands = [];
    this.error = null;
    this.input = new InputQueue();
  }

  async start() {
    if (this.resumedFrom) {
      try {
        const msgs = await getSessionMessages(this.resumedFrom, { dir: this.cwd });
        this.entries = normalizeMessages(msgs.slice(-HISTORY_MESSAGES)).map((e) => ({ ...e, history: true }));
      } catch (e) {
        this.#system(`Could not load previous messages: ${e.message}`, 'warning');
      }
    }

    const options = {
      cwd: this.cwd,
      permissionMode: this.permissionMode,
      allowDangerouslySkipPermissions: config.allowBypassPermissions,
      systemPrompt: { type: 'preset', preset: 'claude_code' },
      settingSources: ['user', 'project', 'local'],
      includePartialMessages: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
      canUseTool: (toolName, input, opts) => this.#askPermission(toolName, input, opts),
      stderr: (d) => {
        if (/error/i.test(d)) console.error(`[claude ${this.sessionId.slice(0, 8)}] ${d.trim()}`);
      },
    };
    if (this.model) options.model = this.model;
    if (this.resumedFrom) {
      options.resume = this.resumedFrom;
      if (this.forked) {
        options.forkSession = true;
        options.sessionId = this.sessionId;
      }
    } else {
      options.sessionId = this.sessionId;
      if (this.title) options.title = this.title;
    }

    this.query = query({ prompt: this.input, options });
    this.#setStatus('idle');
    this.#consume();
  }

  async #consume() {
    try {
      for await (const m of this.query) this.#handle(m);
      this.#setStatus('closed');
    } catch (e) {
      this.error = e.message;
      this.#system(`Session ended with error: ${e.message}`, 'error');
      this.#setStatus('error');
    } finally {
      for (const p of this.pending.values()) p.resolve({ behavior: 'deny', message: 'Session closed' });
      this.pending.clear();
      invalidateSessionCache();
      this.emit('ended');
    }
  }

  // ---- outbound events ----

  #emit(event) {
    this.lastActivity = Date.now();
    this.emit('event', event);
  }

  #push(entries) {
    if (!entries.length) return;
    this.entries.push(...entries);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.#emit({ t: 'entries', entries });
  }

  #system(text, level = 'info') {
    this.#push([{ id: crypto.randomUUID(), kind: 'system', level, text, parent: null, ts: Date.now() }]);
  }

  #setStatus(status) {
    if (this.status === status) return;
    if (this.status === 'closed' || this.status === 'error') return;
    this.status = status;
    this.#emit({ t: 'status', status });
    this.emit('status', status);
  }

  #upsertTask(id, patch) {
    const task = { ...(this.tasks.get(id) || { taskId: id, startedAt: Date.now() }), ...patch, updatedAt: Date.now() };
    this.tasks.set(id, task);
    this.#emit({ t: 'task', task });
  }

  // ---- stream handling ----

  #handle(m) {
    switch (m.type) {
      case 'assistant':
        this.#push(normalizeMessage(m));
        for (const b of m.message?.content || []) {
          if (b.type === 'tool_use' && AGENT_TOOLS.has(b.name)) {
            // Seed an agent record keyed by tool_use id until task_started gives us the task id.
            this.#emit({ t: 'agent_spawned', toolUseId: b.id, parent: m.parent_tool_use_id || null });
          }
        }
        break;
      case 'user':
        if (m.uuid && this.sentUuids.has(m.uuid)) break;
        this.#push(normalizeMessage(m));
        break;
      case 'stream_event': {
        const ev = m.event;
        if (m.parent_tool_use_id) break;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') this.#emit({ t: 'delta', text: ev.delta.text });
        break;
      }
      case 'result':
        this.costUsd = m.total_cost_usd ?? this.costUsd;
        if (m.subtype !== 'success' || m.is_error) {
          this.#system(m.errors?.join('\n') || m.result || `Turn ended: ${m.subtype}`, 'error');
        }
        this.#emit({
          t: 'result',
          durationMs: m.duration_ms,
          costUsd: this.costUsd,
          turns: m.num_turns,
          denials: m.permission_denials?.length || 0,
        });
        if (!m.queued_turn_count) this.#setStatus('idle');
        invalidateSessionCache();
        break;
      case 'system':
        this.#handleSystem(m);
        break;
      default:
        break;
    }
  }

  #handleSystem(m) {
    switch (m.subtype) {
      case 'init':
        this.model = m.model;
        this.permissionMode = m.permissionMode;
        this.slashCommands = m.slash_commands || [];
        this.#emit({ t: 'meta', meta: this.meta() });
        break;
      case 'status':
        if (m.permissionMode && m.permissionMode !== this.permissionMode) {
          this.permissionMode = m.permissionMode;
          this.#emit({ t: 'meta', meta: this.meta() });
        }
        if (m.status === 'compacting') this.#system('Compacting conversation…');
        if (m.compact_result === 'failed') this.#system(`Compaction failed: ${m.compact_error || ''}`, 'error');
        break;
      case 'session_state_changed':
        this.#setStatus(m.state);
        break;
      case 'compact_boundary':
        this.#system(`Context compacted (${m.compact_metadata?.trigger}, ${m.compact_metadata?.pre_tokens} tokens before)`);
        break;
      case 'api_retry':
        this.#system(`API error (${m.error_status ?? m.error}), retrying ${m.attempt}/${m.max_retries}…`, 'warning');
        break;
      case 'local_command_output':
      case 'informational':
        this.#system(m.content, m.level === 'warning' ? 'warning' : 'info');
        break;
      case 'notification':
        if (m.priority !== 'low') this.#system(m.text, 'info');
        break;
      case 'permission_denied':
        this.#system(`Denied ${m.tool_name}: ${m.message}`, 'warning');
        break;
      case 'task_started':
        if (m.skip_transcript || m.ambient) break;
        this.#upsertTask(m.task_id, {
          toolUseId: m.tool_use_id,
          description: m.description,
          subagentType: m.subagent_type,
          taskType: m.task_type,
          background: !!m.is_backgrounded,
          depth: m.spawn_depth,
          prompt: m.prompt?.slice(0, 4000),
          status: 'running',
        });
        break;
      case 'task_progress':
        if (!this.tasks.has(m.task_id)) break;
        this.#upsertTask(m.task_id, { usage: m.usage, lastTool: m.last_tool_name, summary: m.summary || this.tasks.get(m.task_id)?.summary });
        break;
      case 'task_updated':
        if (!this.tasks.has(m.task_id)) break;
        this.#upsertTask(m.task_id, {
          ...(m.patch.status && { status: m.patch.status }),
          ...(m.patch.is_backgrounded !== undefined && { background: m.patch.is_backgrounded }),
          ...(m.patch.error && { error: m.patch.error }),
          ...(m.patch.end_time && { endedAt: m.patch.end_time }),
        });
        break;
      case 'task_notification':
        if (!this.tasks.has(m.task_id)) break;
        this.#upsertTask(m.task_id, { status: m.status, result: m.summary?.slice(0, 4000), usage: m.usage || this.tasks.get(m.task_id)?.usage, endedAt: Date.now() });
        break;
      default:
        break;
    }
  }

  // ---- permissions ----

  #askPermission(toolName, input, opts) {
    const id = crypto.randomUUID();
    const req = {
      id,
      toolName,
      input,
      title: opts.title,
      displayName: opts.displayName,
      description: opts.description,
      decisionReason: opts.decisionReason,
      blockedPath: opts.blockedPath,
      canAlwaysAllow: !!opts.suggestions?.length && !opts.suppressAlwaysAllowRule,
      defaultToNo: !!opts.defaultToNo,
      agentId: opts.agentID || null,
      toolUseId: opts.toolUseID,
      ts: Date.now(),
    };
    return new Promise((resolve) => {
      this.pending.set(id, { req, input, suggestions: opts.suggestions, resolve });
      opts.signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        this.#emit({ t: 'permission_resolved', id });
        resolve({ behavior: 'deny', message: 'Request aborted' });
      });
      this.#setStatus('requires_action');
      this.#emit({ t: 'permission', request: req });
      this.emit('attention', req);
    });
  }

  /** @param {{decision:'allow'|'always'|'deny', message?:string, answers?:Record<string,string>, mode?:string}} d */
  resolvePermission(id, d) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    let result;
    if (d.decision === 'deny') {
      result = { behavior: 'deny', message: d.message?.trim() || 'The user denied this action.', decisionClassification: 'user_reject' };
    } else {
      const updatedInput = d.answers ? { ...p.input, answers: d.answers } : p.input;
      result = { behavior: 'allow', updatedInput, decisionClassification: d.decision === 'always' ? 'user_permanent' : 'user_temporary' };
      if (d.decision === 'always' && p.suggestions?.length) result.updatedPermissions = p.suggestions;
    }
    p.resolve(result);
    this.#emit({ t: 'permission_resolved', id });
    if (!this.pending.size) this.#setStatus('running');
    if (d.mode && d.decision !== 'deny') this.setPermissionMode(d.mode).catch(() => {});
    return true;
  }

  // ---- inbound actions ----

  send(text, images = []) {
    if (this.status === 'closed' || this.status === 'error') throw new Error('Session is not running');
    const uuid = crypto.randomUUID();
    this.sentUuids.add(uuid);
    const content = [];
    for (const img of images.slice(0, 6)) {
      const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(img);
      if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    }
    if (text) content.push({ type: 'text', text });
    if (!content.length) return;
    if (!this.title && text) this.title = text.slice(0, 80);
    this.#push([{ id: uuid, kind: 'user', text, images: images.slice(0, 6), parent: null, ts: Date.now() }]);
    this.input.push({ type: 'user', uuid, session_id: this.sessionId, parent_tool_use_id: null, message: { role: 'user', content } });
    this.#setStatus('running');
  }

  async interrupt() {
    await this.query?.interrupt();
  }

  async setPermissionMode(mode) {
    if (!config.permissionModes.includes(mode)) throw new Error('Permission mode not allowed');
    await this.query.setPermissionMode(mode);
    this.permissionMode = mode;
    this.#emit({ t: 'meta', meta: this.meta() });
  }

  async setModel(model) {
    await this.query.setModel(model || undefined);
    this.model = model || this.model;
    this.#emit({ t: 'meta', meta: this.meta() });
  }

  async stopTask(taskId) {
    await this.query.stopTask(taskId);
  }

  close() {
    this.input.close();
    try {
      this.query?.close();
    } catch {
      /* already closed */
    }
    this.#setStatus('closed');
  }

  meta() {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      title: this.title,
      status: this.status,
      permissionMode: this.permissionMode,
      model: this.model,
      costUsd: this.costUsd,
      forkedFrom: this.forked ? this.resumedFrom : null,
      slashCommands: this.slashCommands,
      permissionModes: config.permissionModes,
    };
  }

  summary() {
    return { sessionId: this.sessionId, cwd: this.cwd, title: this.title, status: this.status, lastActivity: this.lastActivity, pending: this.pending.size, runningAgents: [...this.tasks.values()].filter((t) => t.status === 'running').length };
  }

  snapshot() {
    return {
      meta: this.meta(),
      entries: this.entries,
      tasks: [...this.tasks.values()],
      pending: [...this.pending.values()].map((p) => p.req),
    };
  }
}

export class SessionManager extends EventEmitter {
  sessions = new Map();

  constructor() {
    super();
    if (config.idleCloseMs > 0) {
      setInterval(() => {
        for (const s of this.sessions.values()) {
          if (s.status === 'idle' && !s.pending.size && Date.now() - s.lastActivity > config.idleCloseMs) {
            console.log(`[sessions] closing idle session ${s.sessionId}`);
            s.close();
          }
        }
      }, 60_000).unref();
    }
  }

  get(id) {
    return this.sessions.get(id);
  }

  liveMap() {
    return new Map([...this.sessions.values()].map((s) => [s.sessionId, s.summary()]));
  }

  async start(opts) {
    const existing = opts.resume && !opts.fork && this.sessions.get(opts.resume);
    if (existing && !['closed', 'error'].includes(existing.status)) return existing;
    if (existing) this.sessions.delete(opts.resume);
    const s = new LiveSession(opts);
    this.sessions.set(s.sessionId, s);
    s.on('status', () => this.emit('changed'));
    s.on('attention', (req) => this.emit('attention', s, req));
    s.on('ended', () => {
      // Keep the object briefly so late viewers see the final state, then drop it.
      setTimeout(() => {
        if (this.sessions.get(s.sessionId) === s) this.sessions.delete(s.sessionId);
        this.emit('changed');
      }, 5000);
      this.emit('changed');
    });
    try {
      await s.start();
    } catch (e) {
      this.sessions.delete(s.sessionId);
      throw e;
    }
    this.emit('changed');
    return s;
  }

  closeAll() {
    for (const s of this.sessions.values()) s.close();
  }
}
