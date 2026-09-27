import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, '.data');

function fail(msg) {
  console.error(`[config] ${msg}`);
  process.exit(1);
}

function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const secret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

const env = process.env;

const baseDir = path.resolve(env.BASE_DIR || path.join(os.homedir(), 'source', 'repos'));
if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) fail(`BASE_DIR does not exist: ${baseDir}`);

const password = env.APP_PASSWORD || '';
if (password.length < 12) fail('APP_PASSWORD must be set and at least 12 characters long (this app exposes a shell on your machine).');

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];
const defaultPermissionMode = env.DEFAULT_PERMISSION_MODE || 'default';
if (!PERMISSION_MODES.includes(defaultPermissionMode)) fail(`DEFAULT_PERMISSION_MODE must be one of ${PERMISSION_MODES.join(', ')}`);

export const config = {
  port: Number(env.PORT || 3456),
  host: env.HOST || '0.0.0.0',
  baseDir,
  password,
  totpSecret: (env.TOTP_SECRET || '').replace(/\s+/g, '').toUpperCase(),
  sessionSecret: loadSecret(),
  sessionTtlMs: Number(env.SESSION_TTL_DAYS || 14) * 86400_000,
  trustProxy: env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal',
  defaultPermissionMode,
  allowBypassPermissions: env.ALLOW_BYPASS_PERMISSIONS === 'true',
  idleCloseMs: Number(env.IDLE_CLOSE_MINUTES ?? 120) * 60_000,
  permissionModes: PERMISSION_MODES.filter((m) => m !== 'bypassPermissions' || env.ALLOW_BYPASS_PERMISSIONS === 'true'),
};
