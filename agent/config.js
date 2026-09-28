import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'];

/**
 * Agent configuration. Throws on invalid settings so both the standalone agent and the
 * hub's embedded agent can report the problem their own way.
 * @param {{ embedded?: boolean }} opts
 */
export function loadAgentConfig({ embedded = false } = {}) {
  const env = process.env;

  const baseDir = path.resolve(env.BASE_DIR || path.join(os.homedir(), 'source', 'repos'));
  if (!fs.existsSync(baseDir) || !fs.statSync(baseDir).isDirectory()) throw new Error(`BASE_DIR does not exist: ${baseDir}`);

  const defaultPermissionMode = env.DEFAULT_PERMISSION_MODE || 'default';
  if (!PERMISSION_MODES.includes(defaultPermissionMode)) throw new Error(`DEFAULT_PERMISSION_MODE must be one of ${PERMISSION_MODES.join(', ')}`);

  const allowBypassPermissions = env.ALLOW_BYPASS_PERMISSIONS === 'true';

  let hubUrl = null;
  if (!embedded) {
    if (!env.HUB_URL) throw new Error('HUB_URL must be set (e.g. https://claude.example.com)');
    if (!env.AGENT_TOKEN) throw new Error('AGENT_TOKEN must be set (create one on the hub under Machines → Add machine)');
    const u = new URL(env.HUB_URL);
    u.protocol = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
    u.pathname = `${u.pathname.replace(/\/+$/, '')}/agent`;
    hubUrl = u.toString();
    if (u.protocol === 'ws:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) {
      console.warn('[agent] WARNING: HUB_URL is not https — the agent token and all session traffic travel unencrypted.');
    }
  }

  return {
    embedded,
    hubUrl,
    token: env.AGENT_TOKEN || null,
    baseDir,
    defaultPermissionMode,
    allowBypassPermissions,
    permissionModes: PERMISSION_MODES.filter((m) => m !== 'bypassPermissions' || allowBypassPermissions),
    idleCloseMs: Number(env.IDLE_CLOSE_MINUTES ?? 120) * 60_000,
  };
}

/** The active agent config; set once by the agent entry point before anything else uses it. */
export const config = {};

export function setConfig(c) {
  Object.assign(config, c);
}
