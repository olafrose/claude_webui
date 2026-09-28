// Standalone agent: runs on a PC with Claude Code and connects out to the hub.
import WebSocket from 'ws';
import { loadAgentConfig, setConfig, config } from './config.js';

try {
  setConfig(loadAgentConfig());
} catch (e) {
  console.error(`[agent] ${e.message}`);
  process.exit(1);
}

// Import after config is set: the session manager reads it on construction.
const { createAgentCore } = await import('./core.js');

let sock = null;
const core = createAgentCore((msg) => {
  if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(msg));
});

let backoff = 1000;
let heartbeat;

function connect() {
  const ws = new WebSocket(config.hubUrl, {
    headers: { authorization: `Bearer ${config.token}` },
    maxPayload: 30 * 1024 * 1024,
    handshakeTimeout: 15_000,
  });
  sock = ws;

  // The hub pings every 25s; if we hear nothing for longer, the connection is dead.
  const alive = () => {
    clearTimeout(heartbeat);
    heartbeat = setTimeout(() => ws.terminate(), 70_000);
  };

  ws.on('open', () => {
    console.log(`[agent] connected to ${config.hubUrl}`);
    backoff = 1000;
    alive();
    core.hello();
  });
  ws.on('ping', alive);
  ws.on('message', (raw) => {
    alive();
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    core.handle(msg);
  });
  ws.on('unexpected-response', (req, res) => {
    if (res.statusCode === 401) {
      console.error('[agent] the hub rejected AGENT_TOKEN (revoked or wrong). Retrying in 60s…');
      backoff = 60_000;
    } else {
      console.error(`[agent] hub responded with HTTP ${res.statusCode}`);
    }
    ws.terminate();
  });
  ws.on('error', (e) => {
    if (backoff < 60_000) console.error(`[agent] connection error: ${e.message}`);
  });
  ws.on('close', (code) => {
    clearTimeout(heartbeat);
    if (sock !== ws) return;
    sock = null;
    if (code === 4001) {
      console.error('[agent] this machine was revoked on the hub. Retrying in 60s…');
      backoff = 60_000;
    }
    const wait = backoff;
    backoff = Math.min(backoff * 2, 60_000);
    console.log(`[agent] disconnected, reconnecting in ${Math.round(wait / 1000)}s (sessions keep running)`);
    setTimeout(connect, wait);
  });
}

console.log(`[agent] base directory: ${config.baseDir}`);
connect();

function shutdown() {
  console.log('[agent] shutting down, closing live sessions…');
  core.close();
  sock?.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
