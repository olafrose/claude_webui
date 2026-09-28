// Registry of paired machines and their live agent connections.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'machines.json');
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** One connected agent. `transport` is { send(obj), close(code, reason) }. */
class Connection {
  #pending = new Map();
  #n = 0;

  constructor(registry, record, transport) {
    this.registry = registry;
    this.record = record;
    this.transport = transport;
    this.info = null; // from hello
    this.live = []; // live session summaries pushed by the agent
    this.connectedAt = Date.now();
  }

  rpc(method, params = {}, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.#n;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(Object.assign(new Error(`${this.record.name} did not answer in time`), { status: 504 }));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.transport.send({ t: 'rpc', id, method, params });
    });
  }

  receive(msg) {
    switch (msg?.t) {
      case 'rpc_result': {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { status: msg.error.status }));
        else p.resolve(msg.result);
        return;
      }
      case 'hello':
        this.info = msg.machine || {};
        this.live = msg.sessions || [];
        this.registry.updateRecord(this.record.id, { hostname: this.info.hostname, platform: this.info.platform, lastSeen: Date.now() });
        this.registry.emit('online', this);
        return;
      case 'live':
        this.live = msg.sessions || [];
        this.registry.emit('agent_message', this, msg);
        return;
      default:
        this.registry.emit('agent_message', this, msg);
    }
  }

  closed() {
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error(`${this.record.name} went offline`), { status: 503 }));
    }
    this.#pending.clear();
  }
}

export class MachineRegistry extends EventEmitter {
  records = new Map(); // id -> { id, name, tokenHash, createdAt, lastSeen, hostname, platform, embedded? }
  connections = new Map(); // id -> Connection

  constructor() {
    super();
    try {
      for (const r of JSON.parse(fs.readFileSync(FILE, 'utf8'))) this.records.set(r.id, r);
    } catch {
      /* no machines paired yet */
    }
  }

  #saveTimer = null;
  #save() {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const persisted = [...this.records.values()].filter((r) => !r.embedded);
      fs.writeFileSync(FILE, JSON.stringify(persisted, null, 2), { mode: 0o600 });
    }, 200);
  }

  updateRecord(id, patch) {
    const r = this.records.get(id);
    if (!r) return;
    Object.assign(r, patch);
    if (!r.embedded) this.#save();
  }

  /** Pair a new machine. The plain token is returned once and only its hash is stored. */
  create(name) {
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw Object.assign(new Error('Name is required'), { status: 400 });
    const id = `m_${crypto.randomBytes(5).toString('hex')}`;
    const token = `cra_${crypto.randomBytes(32).toString('base64url')}`;
    this.records.set(id, { id, name, tokenHash: hashToken(token), createdAt: Date.now(), lastSeen: null });
    this.#save();
    this.emit('changed');
    return { id, token };
  }

  rename(id, name) {
    const r = this.records.get(id);
    if (!r) throw Object.assign(new Error('Unknown machine'), { status: 404 });
    name = String(name || '').trim().slice(0, 60);
    if (!name) throw Object.assign(new Error('Name is required'), { status: 400 });
    this.updateRecord(id, { name });
    this.emit('changed');
  }

  revoke(id) {
    const r = this.records.get(id);
    if (!r) throw Object.assign(new Error('Unknown machine'), { status: 404 });
    if (r.embedded) throw Object.assign(new Error('The embedded machine is configured with EMBEDDED_AGENT'), { status: 400 });
    this.records.delete(id);
    this.#save();
    this.connections.get(id)?.transport.close(4001, 'revoked');
    this.emit('changed');
  }

  authenticate(token) {
    if (typeof token !== 'string' || !token.startsWith('cra_')) return null;
    const h = Buffer.from(hashToken(token), 'hex');
    for (const r of this.records.values()) {
      if (r.tokenHash && crypto.timingSafeEqual(h, Buffer.from(r.tokenHash, 'hex'))) return r;
    }
    return null;
  }

  addEmbedded() {
    const r = { id: 'local', name: os.hostname(), embedded: true, createdAt: Date.now(), lastSeen: Date.now() };
    this.records.set(r.id, r);
    return r;
  }

  /** Register a connection for a machine, replacing any previous one (e.g. a half-dead socket). */
  attach(record, transport) {
    const old = this.connections.get(record.id);
    if (old) {
      old.replaced = true;
      old.transport.close(4000, 'replaced by a new connection');
      old.closed();
    }
    const conn = new Connection(this, record, transport);
    this.connections.set(record.id, conn);
    return conn;
  }

  detach(conn) {
    conn.closed();
    if (this.connections.get(conn.record.id) !== conn) return;
    this.connections.delete(conn.record.id);
    this.updateRecord(conn.record.id, { lastSeen: Date.now() });
    this.emit('offline', conn);
  }

  /** Online connection for a machine id, or throws 503/404. */
  require(id) {
    const conn = this.connections.get(id);
    if (conn?.info) return conn;
    if (!this.records.has(id)) throw Object.assign(new Error('Unknown machine'), { status: 404 });
    throw Object.assign(new Error(`${this.records.get(id).name} is offline`), { status: 503 });
  }

  list() {
    return [...this.records.values()]
      .map((r) => {
        const c = this.connections.get(r.id);
        return {
          id: r.id,
          name: r.name,
          embedded: !!r.embedded,
          online: !!c?.info,
          hostname: c?.info?.hostname || r.hostname,
          platform: c?.info?.platform || r.platform,
          baseDir: c?.info?.baseDir,
          permissionModes: c?.info?.permissionModes,
          defaultPermissionMode: c?.info?.defaultPermissionMode,
          liveCount: c?.live?.length || 0,
          lastSeen: c?.info ? Date.now() : r.lastSeen,
          createdAt: r.createdAt,
        };
      })
      .sort((a, b) => b.online - a.online || a.name.localeCompare(b.name));
  }
}
