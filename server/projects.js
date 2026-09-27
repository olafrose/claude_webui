import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { config } from './config.js';

const isWin = process.platform === 'win32';
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** Normalised key for comparing paths (case-insensitive on Windows, no trailing slash). */
export function pathKey(p) {
  let k = path.resolve(p).replace(/[\\/]+$/, '');
  if (isWin) k = k.toLowerCase();
  return k;
}

function isWithin(child, parent) {
  const c = pathKey(child);
  const p = pathKey(parent);
  return c === p || c.startsWith(p + path.sep);
}

/** Ensure a path is BASE_DIR itself or a direct/indirect child of it; returns the resolved path. */
export function resolveProjectPath(p) {
  const resolved = path.resolve(p);
  if (!isWithin(resolved, config.baseDir)) throw Object.assign(new Error('Path is outside BASE_DIR'), { status: 400 });
  return resolved;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Claude Code processes running on this machine (terminal, IDE, SDK), from ~/.claude/sessions/<pid>.json. */
export async function listExternalLive() {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const info = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      if (!info.sessionId || !pidAlive(info.pid)) continue;
      out.push({
        sessionId: info.sessionId,
        pid: info.pid,
        cwd: info.cwd,
        status: info.status || 'unknown',
        name: info.name,
        entrypoint: info.entrypoint,
        kind: info.kind,
        updatedAt: info.updatedAt || info.statusUpdatedAt,
      });
    } catch {
      /* partially written or unreadable; skip */
    }
  }
  return out;
}

let cache = { at: 0, sessions: null };

async function allSessions() {
  if (cache.sessions && Date.now() - cache.at < 4000) return cache.sessions;
  const sessions = await listSessions({ includeProgrammatic: true });
  cache = { at: Date.now(), sessions };
  return sessions;
}

export function invalidateSessionCache() {
  cache.at = 0;
}

/**
 * @param {Map<string, object>} appLive  sessionId -> live summary for sessions this server runs
 */
export async function listProjects(appLive) {
  const entries = await fs.readdir(config.baseDir, { withFileTypes: true });
  const projects = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => ({ name: e.name, path: path.join(config.baseDir, e.name), sessions: [], lastActivity: 0 }));

  const byKey = new Map(projects.map((p) => [pathKey(p.path), p]));
  const [sessions, external] = await Promise.all([allSessions(), listExternalLive()]);
  const externalById = new Map(external.map((x) => [x.sessionId, x]));

  const findProject = (cwd) => {
    if (!cwd) return null;
    // Walk up from cwd so sessions started in subfolders belong to their top-level project.
    let k = pathKey(cwd);
    const base = pathKey(config.baseDir);
    while (k.length > base.length) {
      if (byKey.has(k)) return byKey.get(k);
      const up = path.dirname(k);
      if (up === k) break;
      k = up;
    }
    return null;
  };

  const seen = new Set();
  for (const s of sessions) {
    const project = findProject(s.cwd);
    if (!project) continue;
    seen.add(s.sessionId);
    project.sessions.push(sessionSummary(s, appLive.get(s.sessionId), externalById.get(s.sessionId)));
  }
  // Live sessions whose transcript doesn't exist yet (just started) still need to show up.
  for (const live of appLive.values()) {
    if (seen.has(live.sessionId)) continue;
    const project = findProject(live.cwd);
    if (project) project.sessions.push({ sessionId: live.sessionId, title: live.title || 'New session', lastModified: live.lastActivity, cwd: live.cwd, live: 'app', status: live.status });
  }

  for (const p of projects) {
    p.sessions.sort((a, b) => (b.live ? 1 : 0) - (a.live ? 1 : 0) || b.lastModified - a.lastModified);
    p.lastActivity = Math.max(0, ...p.sessions.map((s) => s.lastModified || 0));
    p.liveCount = p.sessions.filter((s) => s.live).length;
    p.sessionCount = p.sessions.length;
  }
  projects.sort((a, b) => b.liveCount - a.liveCount || b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
  return projects;
}

function sessionSummary(s, live, ext) {
  return {
    sessionId: s.sessionId,
    title: s.customTitle || s.summary || s.firstPrompt || '(untitled)',
    lastModified: live ? Math.max(live.lastActivity || 0, s.lastModified) : s.lastModified,
    createdAt: s.createdAt,
    gitBranch: s.gitBranch,
    cwd: s.cwd,
    live: live ? 'app' : ext ? 'external' : null,
    status: live ? live.status : ext ? ext.status : null,
    external: ext ? { entrypoint: ext.entrypoint, name: ext.name, pid: ext.pid } : undefined,
  };
}

export async function createProject(name) {
  if (!/^[\w.-][\w .-]{0,99}$/.test(name) || name.includes('..')) throw Object.assign(new Error('Invalid folder name'), { status: 400 });
  const p = path.join(config.baseDir, name.trim());
  await fs.mkdir(p);
  return p;
}
