import crypto from 'node:crypto';
import { config } from './config.js';

const COOKIE = 'cr_session';

function hmac(data) {
  return crypto.createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- TOTP (RFC 6238, SHA-1, 30s, 6 digits) ----

function base32Decode(str) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of str.replace(/=+$/, '')) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error('invalid base32');
    bits += v.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function base32Encode(buf) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function totpAt(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

let lastTotpCounter = -1;
function verifyTotp(code) {
  const counter = Math.floor(Date.now() / 30_000);
  for (const c of [counter - 1, counter, counter + 1]) {
    // Reject replays of an already-used code window.
    if (c > lastTotpCounter && safeEqual(totpAt(config.totpSecret, c), String(code || '').trim())) {
      lastTotpCounter = c;
      return true;
    }
  }
  return false;
}

// ---- login rate limiting ----

const failures = new Map(); // ip -> { count, until }
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60_000;

function isLocked(ip) {
  const f = failures.get(ip);
  return f && f.count >= MAX_FAILS && f.until > Date.now();
}

function recordFailure(ip) {
  const f = failures.get(ip) || { count: 0, until: 0 };
  if (f.until < Date.now()) f.count = 0;
  f.count += 1;
  f.until = Date.now() + LOCK_MS;
  failures.set(ip, f);
}

// ---- session cookies ----

function issueToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + config.sessionTtlMs, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !safeEqual(sig, hmac(payload))) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch {
    return false;
  }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function isAuthenticated(req) {
  return verifyToken(parseCookies(req.headers.cookie)[COOKIE]);
}

function setCookie(req, res, value, maxAgeMs) {
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`);
}

export function loginHandler(req, res) {
  const ip = req.ip;
  if (isLocked(ip)) return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
  const { password, totp } = req.body || {};
  const ok = safeEqual(password || '', config.password) && (!config.totpSecret || verifyTotp(totp));
  if (!ok) {
    recordFailure(ip);
    console.warn(`[auth] failed login from ${ip}`);
    // Uniform delay to blunt brute force/timing.
    return setTimeout(() => res.status(401).json({ error: 'Invalid credentials' }), 800);
  }
  failures.delete(ip);
  setCookie(req, res, issueToken(), config.sessionTtlMs);
  res.json({ ok: true });
}

export function logoutHandler(req, res) {
  setCookie(req, res, '', 0);
  res.json({ ok: true });
}

export function requireAuth(req, res, next) {
  if (isAuthenticated(req)) return next();
  res.status(401).json({ error: 'unauthorized' });
}

/** Require a same-origin marker header on state-changing API calls (CSRF defence in addition to SameSite). */
export function requireSameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.get('x-requested-with') !== 'claude-remote') return res.status(403).json({ error: 'bad request origin' });
  next();
}

/** WebSocket upgrades: validate cookie and that Origin matches Host. */
export function authorizeUpgrade(req) {
  if (!isAuthenticated(req)) return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    const o = new URL(origin);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return o.host === host;
  } catch {
    return false;
  }
}
