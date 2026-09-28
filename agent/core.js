// Transport-independent agent logic: answers hub RPCs and pushes session events.
// Used by the standalone agent (over WebSocket) and the hub's embedded agent (in-process).
import os from 'node:os';
import { getSessionMessages, getSessionInfo, listSubagents, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';
import { SessionManager } from './sessions.js';
import { listProjects, createProject, resolveProjectPath, listExternalLive } from './projects.js';
import { normalizeMessages } from './normalize.js';

export const PROTOCOL_VERSION = 1;

/**
 * @param {(msg: object) => void} send  delivers a message to the hub (dropped while disconnected)
 */
export function createAgentCore(send) {
  const manager = new SessionManager();
  const liveSummary = () => [...manager.sessions.values()].map((s) => s.summary());

  let liveTimer;
  manager.on('changed', () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => send({ t: 'live', sessions: liveSummary() }), 150);
  });
  manager.on('session_event', (s, event) => send({ t: 'event', sessionId: s.sessionId, event }));
  manager.on('attention', (s, req) =>
    send({ t: 'attention', kind: 'permission', sessionId: s.sessionId, title: s.title, text: req.title || `${req.toolName} needs approval` }),
  );
  manager.on('done', (s) => send({ t: 'attention', kind: 'done', sessionId: s.sessionId, title: s.title, text: 'Claude finished and is waiting for you' }));

  const session = (id) => {
    const s = manager.get(id);
    if (!s) throw Object.assign(new Error('Session is not live'), { status: 404 });
    return s;
  };
  const dirParam = (cwd) => (cwd ? resolveProjectPath(String(cwd)) : undefined);

  const methods = {
    projects: async () => ({ baseDir: config.baseDir, projects: await listProjects(manager.liveMap()) }),

    createProject: async ({ name }) => ({ path: await createProject(String(name || '')) }),

    live: async () => {
      const app = liveSummary();
      const ids = new Set(app.map((s) => s.sessionId));
      return { app, external: (await listExternalLive()).filter((x) => !ids.has(x.sessionId)) };
    },

    startSession: async ({ cwd, resume, fork, permissionMode, model, prompt, images }) => {
      const dir = resolveProjectPath(String(cwd || ''));
      if (resume && !fork && !manager.get(resume)) {
        const ext = (await listExternalLive()).find((x) => x.sessionId === resume);
        if (ext) throw Object.assign(new Error(`This session is currently running elsewhere (${ext.entrypoint || 'pid ' + ext.pid}). Fork it instead.`), { status: 409 });
      }
      const s = await manager.start({
        cwd: dir,
        resume: resume || undefined,
        fork: !!fork,
        permissionMode: config.permissionModes.includes(permissionMode) ? permissionMode : undefined,
        model: model || undefined,
        title: prompt ? String(prompt).slice(0, 80) : undefined,
      });
      if (prompt || images?.length) s.send(String(prompt || ''), Array.isArray(images) ? images : []);
      return { sessionId: s.sessionId };
    },

    closeSession: async ({ sessionId }) => {
      session(sessionId).close();
      return { ok: true };
    },

    snapshot: async ({ sessionId }) => manager.get(sessionId)?.snapshot() || null,

    history: async ({ sessionId, cwd, offset = 0 }) => {
      const dir = dirParam(cwd);
      offset = Number(offset) || 0;
      const [msgs, info, external] = await Promise.all([
        getSessionMessages(sessionId, { dir }),
        offset ? null : getSessionInfo(sessionId, { dir }),
        listExternalLive(),
      ]);
      if (!msgs.length && !offset && !info) throw Object.assign(new Error('Session not found'), { status: 404 });
      const start = offset > 0 && offset <= msgs.length ? offset : Math.max(0, msgs.length - 600);
      return {
        total: msgs.length,
        entries: normalizeMessages(msgs.slice(start)),
        reset: offset > msgs.length,
        external: external.find((x) => x.sessionId === sessionId) || null,
        cwd: info?.cwd,
        title: info?.customTitle || info?.summary,
      };
    },

    subagents: async ({ sessionId, cwd }) => {
      const dir = dirParam(cwd);
      const ids = (await listSubagents(sessionId, { dir })).slice(-50);
      const agents = await Promise.all(
        ids.map(async (agentId) => {
          const msgs = await getSubagentMessages(sessionId, agentId, { dir });
          const first = normalizeMessages(msgs.slice(0, 1))[0];
          const last = msgs[msgs.length - 1];
          return { agentId, prompt: first?.text?.slice(0, 300) || '', messages: msgs.length, lastTs: last?.timestamp ? Date.parse(last.timestamp) : null };
        }),
      );
      return { agents };
    },

    subagentMessages: async ({ sessionId, cwd, agentId }) => {
      const msgs = await getSubagentMessages(sessionId, String(agentId), { dir: dirParam(cwd) });
      return { entries: normalizeMessages(msgs.slice(-400)).map((e) => ({ ...e, parent: null })) };
    },

    send: async ({ sessionId, text, images }) => {
      session(sessionId).send(String(text || ''), Array.isArray(images) ? images : []);
      return { ok: true };
    },

    permission: async ({ sessionId, id, decision, message, answers, mode }) => {
      if (!session(sessionId).resolvePermission(id, { decision, message, answers, mode })) throw new Error('This request was already answered');
      return { ok: true };
    },

    interrupt: async ({ sessionId }) => {
      await session(sessionId).interrupt();
      return { ok: true };
    },

    mode: async ({ sessionId, mode }) => {
      await session(sessionId).setPermissionMode(mode);
      return { ok: true };
    },

    model: async ({ sessionId, model }) => {
      await session(sessionId).setModel(model);
      return { ok: true };
    },

    stopTask: async ({ sessionId, taskId }) => {
      await session(sessionId).stopTask(taskId);
      return { ok: true };
    },
  };

  return {
    /** Sent on every (re)connect so the hub knows who we are and what is running. */
    hello() {
      send({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        machine: {
          hostname: os.hostname(),
          platform: process.platform,
          baseDir: config.baseDir,
          permissionModes: config.permissionModes,
          defaultPermissionMode: config.defaultPermissionMode,
        },
        sessions: liveSummary(),
      });
    },

    async handle(msg) {
      if (msg?.t !== 'rpc') return;
      const fn = Object.hasOwn(methods, msg.method) ? methods[msg.method] : null;
      try {
        if (!fn) throw new Error(`Unknown method ${msg.method}`);
        send({ t: 'rpc_result', id: msg.id, result: await fn(msg.params || {}) });
      } catch (e) {
        if (!e.status) console.error(`[agent] ${msg.method} failed:`, e);
        send({ t: 'rpc_result', id: msg.id, error: { message: e.message, status: e.status || 500 } });
      }
    },

    close() {
      manager.closeAll();
    },
  };
}
