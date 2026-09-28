import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, '.data'));

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

const password = env.APP_PASSWORD || '';
if (password.length < 12) fail('APP_PASSWORD must be set and at least 12 characters long (connected machines can run arbitrary commands).');

export const config = {
  port: Number(env.PORT || 3456),
  host: env.HOST || '0.0.0.0',
  password,
  totpSecret: (env.TOTP_SECRET || '').replace(/\s+/g, '').toUpperCase(),
  sessionSecret: loadSecret(),
  sessionTtlMs: Number(env.SESSION_TTL_DAYS || 14) * 86400_000,
  trustProxy: env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal',
  // Run an agent inside the hub process so the hub's own machine shows up without a separate agent.
  embeddedAgent: env.EMBEDDED_AGENT === 'true',
  // Public URL of the hub, used in the setup snippet shown when adding a machine.
  publicUrl: env.PUBLIC_URL || '',
};
