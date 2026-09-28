import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { config, ROOT } from './config.js';
import { loginHandler, logoutHandler, requireAuth, requireSameOrigin, authorizeUpgrade, isAuthenticated } from './auth.js';
import { MachineRegistry } from './machines.js';

const machines = new MachineRegistry();
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
  Promise.resolve()
    .then(() => fn(req, res))
    .then((result) => result !== undefined && !res.headersSent && res.json(result))
    .catch((e) => {
      if (!e.status || e.status >= 500) console.error('[api]', req.method, req.path, e.message);
      res.status(e.status || 500).json({ error: e.message });
    });

api.get('/config', (req, res) => res.json({ publicUrl: config.publicUrl }));

// Machines
api.get('/machines', (req, res) => res.json({ machines: machines.list() }));
api.post('/machines', wrap((req) => machines.create(req.body?.name)));
api.patch('/machines/:mid', wrap((req) => (machines.rename(req.params.mid, req.body?.name), { ok: true })));
api.delete('/machines/:mid', wrap((req) => (machines.revoke(req.params.mid), { ok: true })));

// Sessions running anywhere, for the dashboard's "Active now".
api.get('/live', wrap(async () => {
  const online = machines.list().filter((m) => m.online);
  const results = await Promise.all(online.map((m) => machines.require(m.id).rpc('live', {}, 8000).then((r) => ({ m, r }), () => null)));
  const sessions = [];
  for (const x of results.filter(Boolean)) {
    for (const s of x.r.app) sessions.push({ ...s, machineId: x.m.id, machineName: x.m.name, where: 'here' });
    for (const s of x.r.external) sessions.push({ ...s, title: s.name, machineId: x.m.id, machineName: x.m.name, where: s.entrypoint?.replace(/^claude-/, '') || 'terminal' });
  }
  return { sessions };
}));

// Per-machine calls are forwarded to that machine's agent.
const rpc = (method, params, timeout) => (req) => machines.require(req.params.mid).rpc(method, params(req), timeout);
api.get('/m/:mid/projects', wrap(rpc('projects', () => ({}))));
api.post('/m/:mid/projects', wrap(rpc('createProject', (req) => ({ name: req.body?.name }))));
api.post('/m/:mid/sessions', wrap(rpc('startSession', (req) => req.body || {}, 120_000)));
api.post('/m/:mid/sessions/:sid/close', wrap(rpc('closeSession', (req) => ({ sessionId: req.params.sid }))));
api.get('/m/:mid/sessions/:sid/history', wrap(rpc('history', (req) => ({ sessionId: req.params.sid, cwd: req.query.cwd, offset: req.query.offset }))));
api.get('/m/:mid/sessions/:sid/agents', wrap(rpc('subagents', (req) => ({ sessionId: req.params.sid, cwd: req.query.cwd }))));
api.get('/m/:mid/sessions/:sid/agents/:agentId', wrap(rpc('subagentMessages', (req) => ({ sessionId: req.params.sid, cwd: req.query.cwd, agentId: req.params.agentId }))));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// ---- WebSockets: browsers on /ws, agents on /agent ----
const server = http.createServer(app);
const browserWss = new WebSocketServer({ noServer: true, maxPayload: 30 * 1024 * 1024 });
const agentWss = new WebSocketServer({ noServer: true, maxPayload: 30 * 1024 * 1024 });

const agentFailures = new Map(); // ip -> { count, until }

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, 'http://x').pathname;
  const reject = (code = 401) => {
    socket.write(`HTTP/1.1 ${code} ${code === 429 ? 'Too Many Requests' : 'Unauthorized'}\r\n\r\n`);
    socket.destroy();
  };
  if (pathname === '/ws') {
    if (!authorizeUpgrade(req)) return reject();
    return browserWss.handleUpgrade(req, socket, head, (ws) => browserWss.emit('connection', ws, req));
  }
  if (pathname === '/agent') {
    const ip = (app.get('trust proxy') && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
    const f = agentFailures.get(ip);
    if (f && f.count >= 10 && f.until > Date.now()) return reject(429);
    const token = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    const record = machines.authenticate(token);
    if (!record) {
      agentFailures.set(ip, { count: (f?.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 15 * 60_000 });
      console.warn(`[agents] rejected agent connection from ${ip}`);
      return reject();
    }
    agentFailures.delete(ip);
    return agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit('connection', ws, record, ip));
  }
  reject();
});

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  for (const ws of browserWss.clients) send(ws, msg);
}
const broadcastMachines = () => broadcast({ t: 'machines', machines: machines.list() });

// Send a snapshot (or not_live) to a browser that is viewing a session.
async function sendSnapshot(ws) {
  const sub = ws.sub;
  if (!sub) return;
  try {
    const snap = await machines.require(sub.machineId).rpc('snapshot', { sessionId: sub.sessionId }, 30_000);
    if (ws.sub !== sub) return; // user navigated away meanwhile
    if (snap) send(ws, { t: 'snapshot', machineId: sub.machineId, sessionId: sub.sessionId, ...snap });
    else send(ws, { t: 'not_live', machineId: sub.machineId, sessionId: sub.sessionId });
  } catch (e) {
    if (ws.sub === sub) send(ws, { t: 'machine_offline', machineId: sub.machineId, sessionId: sub.sessionId, error: e.message });
  }
}

// ---- agent side ----
machines.on('online', (conn) => {
  broadcastMachines();
  broadcast({ t: 'live', machineId: conn.record.id, sessions: conn.live });
  // A reconnecting agent may have state the viewers missed: refresh their snapshots.
  for (const ws of browserWss.clients) if (ws.sub?.machineId === conn.record.id) sendSnapshot(ws);
});

machines.on('offline', (conn) => {
  console.log(`[agents] ${conn.record.name} disconnected`);
  broadcastMachines();
  broadcast({ t: 'live', machineId: conn.record.id, sessions: [] });
  for (const ws of browserWss.clients) if (ws.sub?.machineId === conn.record.id) send(ws, { t: 'machine_offline', machineId: conn.record.id, sessionId: ws.sub.sessionId });
});

machines.on('changed', broadcastMachines);

machines.on('agent_message', (conn, msg) => {
  const machineId = conn.record.id;
  switch (msg.t) {
    case 'event':
      for (const ws of browserWss.clients) {
        if (ws.sub?.machineId === machineId && ws.sub.sessionId === msg.sessionId) send(ws, { ...msg.event, machineId, sessionId: msg.sessionId });
      }
      break;
    case 'live':
      broadcast({ t: 'live', machineId, sessions: msg.sessions });
      break;
    case 'attention':
      broadcast({ ...msg, machineId, machineName: conn.record.name });
      break;
    default:
      break;
  }
});

agentWss.on('connection', (ws, record, ip) => {
  const conn = machines.attach(record, {
    send: (msg) => send(ws, msg),
    close: (code, reason) => ws.close(code, reason),
  });
  console.log(`[agents] ${record.name} connected from ${ip}`);
  ws.on('message', (raw) => {
    try {
      conn.receive(JSON.parse(raw));
    } catch (e) {
      console.error('[agents] bad message', e.message);
    }
  });
  ws.on('close', () => machines.detach(conn));
  ws.on('error', () => {});
});

// ---- browser side ----
const BROWSER_ACTIONS = {
  send: (m) => ['send', { sessionId: m.sessionId, text: m.text, images: m.images }],
  permission: (m) => ['permission', { sessionId: m.sessionId, id: m.id, decision: m.decision, message: m.message, answers: m.answers, mode: m.mode }],
  interrupt: (m) => ['interrupt', { sessionId: m.sessionId }],
  mode: (m) => ['mode', { sessionId: m.sessionId, mode: m.mode }],
  model: (m) => ['model', { sessionId: m.sessionId, model: m.model }],
  stop_task: (m) => ['stopTask', { sessionId: m.sessionId, taskId: m.taskId }],
};

browserWss.on('connection', (ws) => {
  ws.sub = null;
  send(ws, { t: 'machines', machines: machines.list() });
  for (const [id, conn] of machines.connections) if (conn.info) send(ws, { t: 'live', machineId: id, sessions: conn.live });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const reply = (extra) => msg.ref && send(ws, { t: 'ack', ref: msg.ref, ...extra });
    try {
      if (msg.t === 'subscribe') {
        ws.sub = { machineId: String(msg.machineId), sessionId: String(msg.sessionId) };
        await sendSnapshot(ws);
      } else if (msg.t === 'unsubscribe') {
        ws.sub = null;
      } else if (msg.t === 'ping') {
        /* keepalive */
      } else if (BROWSER_ACTIONS[msg.t]) {
        const [method, params] = BROWSER_ACTIONS[msg.t](msg);
        await machines.require(String(msg.machineId)).rpc(method, params);
      } else {
        throw new Error(`unknown message ${msg.t}`);
      }
      reply({ ok: true });
    } catch (e) {
      reply({ ok: false, error: e.message });
    }
  });
});

// Keep connections alive through proxies that drop idle sockets; agents use these pings as heartbeat.
setInterval(() => {
  for (const wss of [browserWss, agentWss]) for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.ping();
}, 25_000).unref();

// ---- embedded agent (hub machine itself) ----
let embedded = null;
if (config.embeddedAgent) {
  try {
    const { loadAgentConfig, setConfig } = await import('../agent/config.js');
    setConfig(loadAgentConfig({ embedded: true }));
    const { createAgentCore } = await import('../agent/core.js');
    const record = machines.addEmbedded();
    let conn;
    // JSON round-trips keep the in-process path identical to the network path.
    embedded = createAgentCore((msg) => conn.receive(JSON.parse(JSON.stringify(msg))));
    conn = machines.attach(record, { send: (msg) => embedded.handle(JSON.parse(JSON.stringify(msg))), close: () => {} });
    embedded.hello();
  } catch (e) {
    console.error(`[embedded agent] could not start: ${e.message}`);
    if (e.code === 'ERR_MODULE_NOT_FOUND') console.error('  Install the Claude Agent SDK (npm install without --omit=optional) or set EMBEDDED_AGENT=false.');
    process.exit(1);
  }
}

server.listen(config.port, config.host, () => {
  console.log(`Claude Remote hub listening on http://${config.host}:${config.port}`);
  console.log(`  TOTP: ${config.totpSecret ? 'enabled' : 'disabled'}`);
  console.log(`  machines paired: ${machines.list().filter((m) => !m.embedded).length}${embedded ? ' (+ embedded agent for this machine)' : ''}`);
});

function shutdown() {
  console.log('Shutting down…');
  embedded?.close();
  setTimeout(() => process.exit(0), 1500).unref();
  server.close(() => process.exit(0));
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
