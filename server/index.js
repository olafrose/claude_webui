import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { getSessionMessages, getSessionInfo, listSubagents, getSubagentMessages } from '@anthropic-ai/claude-agent-sdk';
import { config, ROOT } from './config.js';
import { loginHandler, logoutHandler, requireAuth, requireSameOrigin, authorizeUpgrade, isAuthenticated } from './auth.js';
import { listProjects, createProject, resolveProjectPath, listExternalLive } from './projects.js';
import { SessionManager } from './sessions.js';
import { normalizeMessages } from './normalize.js';

const manager = new SessionManager();
const app = express();
app.set('trust proxy', config.trustProxy === 'true' ? true : config.trustProxy === 'false' ? false : config.trustProxy);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  next();
});

app.use(express.json({ limit: '30mb' }));

// ---- public ----
app.post('/api/login', requireSameOrigin, loginHandler);
app.post('/api/logout', requireSameOrigin, logoutHandler);
app.get('/api/me', (req, res) => res.json({ authenticated: isAuthenticated(req), totp: !!config.totpSecret }));

app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: 0 }));
app.get('/vendor/marked.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/marked/lib/marked.umd.js')));
app.get('/vendor/purify.js', (req, res) => res.sendFile(path.join(ROOT, 'node_modules/dompurify/dist/purify.min.js')));

// ---- authenticated API ----
const api = express.Router();
api.use(requireAuth, requireSameOrigin);

const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    console.error('[api]', req.method, req.path, e);
    res.status(e.status || 500).json({ error: e.message });
  });

api.get('/config', (req, res) =>
  res.json({ baseDir: config.baseDir, permissionModes: config.permissionModes, defaultPermissionMode: config.defaultPermissionMode }),
);

api.get('/projects', wrap(async (req, res) => res.json({ baseDir: config.baseDir, projects: await listProjects(manager.liveMap()) })));

api.post('/projects', wrap(async (req, res) => res.json({ path: await createProject(String(req.body?.name || '')) })));

api.get('/live', wrap(async (req, res) => {
  const appLive = [...manager.sessions.values()].map((s) => s.summary());
  const ids = new Set(appLive.map((s) => s.sessionId));
  const external = (await listExternalLive()).filter((x) => !ids.has(x.sessionId));
  res.json({ app: appLive, external });
}));

api.post('/sessions', wrap(async (req, res) => {
  const { cwd, resume, fork, permissionMode, model, prompt, images } = req.body || {};
  const dir = resolveProjectPath(String(cwd || ''));
  if (resume && !fork) {
    const ext = (await listExternalLive()).find((x) => x.sessionId === resume);
    if (ext && !manager.get(resume)) {
      return res.status(409).json({ error: `This session is currently running elsewhere (${ext.entrypoint || 'pid ' + ext.pid}). Fork it instead.` });
    }
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
  res.json({ sessionId: s.sessionId });
}));

api.post('/sessions/:id/close', wrap(async (req, res) => {
  const s = manager.get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not live' });
  s.close();
  res.json({ ok: true });
}));

/** Transcript of a session that is not driven by this server (stored or running elsewhere). */
api.get('/sessions/:id/history', wrap(async (req, res) => {
  const dir = req.query.cwd ? resolveProjectPath(String(req.query.cwd)) : undefined;
  const offset = Number(req.query.offset || 0);
  const [msgs, info, external] = await Promise.all([
    getSessionMessages(req.params.id, { dir }),
    offset ? null : getSessionInfo(req.params.id, { dir }),
    listExternalLive(),
  ]);
  if (!msgs.length && !offset && !info) return res.status(404).json({ error: 'Session not found' });
  const start = offset > 0 && offset <= msgs.length ? offset : Math.max(0, msgs.length - 600);
  res.json({
    total: msgs.length,
    entries: normalizeMessages(msgs.slice(start)),
    reset: offset > msgs.length,
    external: external.find((x) => x.sessionId === req.params.id) || null,
    cwd: info?.cwd,
    title: info?.customTitle || info?.summary,
  });
}));

api.get('/sessions/:id/agents', wrap(async (req, res) => {
  const dir = req.query.cwd ? resolveProjectPath(String(req.query.cwd)) : undefined;
  const ids = (await listSubagents(req.params.id, { dir })).slice(-50);
  const agents = await Promise.all(
    ids.map(async (agentId) => {
      const msgs = await getSubagentMessages(req.params.id, agentId, { dir });
      const first = normalizeMessages(msgs.slice(0, 1))[0];
      const last = msgs[msgs.length - 1];
      return { agentId, prompt: first?.text?.slice(0, 300) || '', messages: msgs.length, lastTs: last?.timestamp ? Date.parse(last.timestamp) : null };
    }),
  );
  res.json({ agents });
}));

api.get('/sessions/:id/agents/:agentId', wrap(async (req, res) => {
  const dir = req.query.cwd ? resolveProjectPath(String(req.query.cwd)) : undefined;
  const msgs = await getSubagentMessages(req.params.id, req.params.agentId, { dir });
  res.json({ entries: normalizeMessages(msgs.slice(-400)).map((e) => ({ ...e, parent: null })) });
}));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// ---- WebSocket ----
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 30 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !authorizeUpgrade(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  for (const ws of wss.clients) send(ws, msg);
}

const liveSummary = () => [...manager.sessions.values()].map((s) => s.summary());
let liveTimer;
manager.on('changed', () => {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => broadcast({ t: 'live', sessions: liveSummary() }), 150);
});
manager.on('attention', (s, req) => broadcast({ t: 'attention', kind: 'permission', sessionId: s.sessionId, title: s.title, text: req.title || `${req.toolName} needs approval` }));

// Announce finished turns so a phone on the dashboard learns Claude is waiting for input.
const lastStatus = new Map();
manager.on('changed', () => {
  for (const s of manager.sessions.values()) {
    const prev = lastStatus.get(s.sessionId);
    if (prev === 'running' && s.status === 'idle') broadcast({ t: 'attention', kind: 'done', sessionId: s.sessionId, title: s.title, text: 'Claude finished and is waiting for you' });
    lastStatus.set(s.sessionId, s.status);
  }
});

wss.on('connection', (ws) => {
  let sub = null; // { session, listener }
  const unsubscribe = () => {
    if (sub) sub.session.off('event', sub.listener);
    sub = null;
  };

  send(ws, { t: 'live', sessions: liveSummary() });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const s = msg.sessionId ? manager.get(msg.sessionId) : null;
    const reply = (extra) => send(ws, { t: 'ack', ref: msg.ref, ...extra });
    try {
      switch (msg.t) {
        case 'subscribe':
          unsubscribe();
          if (!s) return send(ws, { t: 'not_live', sessionId: msg.sessionId });
          sub = { session: s, listener: (ev) => send(ws, { ...ev, sessionId: s.sessionId }) };
          s.on('event', sub.listener);
          send(ws, { t: 'snapshot', sessionId: s.sessionId, ...s.snapshot() });
          break;
        case 'unsubscribe':
          unsubscribe();
          break;
        case 'send':
          if (!s) throw new Error('Session is not live');
          s.send(String(msg.text || ''), Array.isArray(msg.images) ? msg.images : []);
          break;
        case 'permission':
          if (!s) throw new Error('Session is not live');
          if (!s.resolvePermission(msg.id, msg)) throw new Error('This request was already answered');
          break;
        case 'interrupt':
          await s?.interrupt();
          break;
        case 'mode':
          await s?.setPermissionMode(msg.mode);
          break;
        case 'model':
          await s?.setModel(msg.model);
          break;
        case 'stop_task':
          await s?.stopTask(msg.taskId);
          break;
        case 'ping':
          break;
        default:
          throw new Error(`unknown message ${msg.t}`);
      }
      if (msg.ref) reply({ ok: true });
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
  });

  ws.on('close', unsubscribe);
});

// Keep connections alive through proxies that drop idle sockets.
setInterval(() => {
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.ping();
}, 25_000).unref();

server.listen(config.port, config.host, () => {
  console.log(`Claude Remote listening on http://${config.host}:${config.port}`);
  console.log(`  base directory: ${config.baseDir}`);
  console.log(`  TOTP: ${config.totpSecret ? 'enabled' : 'disabled'}`);
});

function shutdown() {
  console.log('Shutting down, closing live sessions…');
  manager.closeAll();
  setTimeout(() => process.exit(0), 1500).unref();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
