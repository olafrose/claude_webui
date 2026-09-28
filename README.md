# Claude Remote

A self-hosted, mobile-friendly web UI for the Claude Code sessions on your PCs. Put the hub behind
Nginx Proxy Manager and keep working with Claude from your phone, across as many machines as you like.

- **Multiple machines**: each PC runs a small agent that connects *out* to the hub, so PCs need no
  open ports, VPN or proxy entry. They can be anywhere with internet access.
- **Dashboard**: every machine with the folders in its `BASE_DIR` and their Claude Code sessions.
  "Active now" shows running sessions across all machines, including ones open in a terminal or VS Code.
- **Start / resume / fork** a session in any folder on any machine. Resuming picks up the full history,
  including sessions you started at your desk.
- **Chat**: streamed replies, tool-call cards (diffs, commands, todo lists), image attachments
  (camera or gallery), slash-command suggestions, interrupt, and permission-mode and model switching.
- **Approvals on the go**: permission requests, `AskUserQuestion` prompts and plan approvals appear as
  cards with Allow / Always allow / Deny buttons. You get a toast or notification when Claude needs you
  or has finished.
- **Agent monitor**: every subagent and background task a session spawns, with live status, token and
  tool counts, progress summaries, its own activity feed, and a Stop button.
- **Watch mode**: sessions running elsewhere (e.g. the VS Code extension) are shown read-only and
  update live. Sending a message forks them so the two processes never write to the same transcript.

## How it fits together

```
 phone / browser ──https──▶ Nginx Proxy Manager ──▶ hub ◀──wss── agent on PC 1 ── Claude Code
                                                        ◀──wss── agent on PC 2 ── Claude Code
                                                        ◀─ (in-process) embedded agent, optional
```

- **Hub** (`npm start`): login, web UI, machine pairing, and a relay between browsers and agents. It
  doesn't need Claude Code, so it can run on a NAS or in Docker next to NPM.
- **Agent** (`npm run agent`): runs on each PC with Claude Code. It uses the official
  [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and the Claude login
  already on that PC. Sessions are ordinary Claude Code sessions in `~/.claude/projects`, so you can
  `claude --resume` them at the desk.
- **Embedded agent** (`EMBEDDED_AGENT=true`): the hub also serves its own machine, so a single-PC
  setup needs only one process.

## Setup

Requires Node.js ≥ 22.9.

### 1. Hub

**Single PC** (hub and Claude Code on the same machine):

```powershell
npm install
copy .env.example .env      # set APP_PASSWORD, BASE_DIR, and keep EMBEDDED_AGENT=true
npm run totp-setup          # optional but recommended: prints a TOTP_SECRET for your authenticator app
npm start
```

**Dedicated server / Docker** (hub only): use the `Dockerfile` (it leaves out the Claude SDK). See
`docker-compose.example.yml` for running it on the same Docker network as Nginx Proxy Manager.
Without Docker, run `npm install --omit=optional` and set `EMBEDDED_AGENT=false`.

Open the hub, sign in, and on your phone use "Add to Home Screen" so it runs like an app.

### 2. Add more PCs

1. In the web UI open **Machines → Add**, give the PC a name, and copy the `.env` snippet. The token
   is shown only once.
2. On that PC, install Node.js and Claude Code, and sign in to Claude once by running `claude`.
3. Copy this project there, run `npm install`, and put the snippet into `.env` (adjust `BASE_DIR`).
4. Run `npm run agent`. The machine shows up as online within seconds.

The agent reconnects automatically. To revoke a PC, use **Machines → Revoke**, which disconnects it
immediately.

### Configuration (`.env`)

Hub:

| Variable | Default | Meaning |
|---|---|---|
| `APP_PASSWORD` | – (required, ≥ 12 chars) | Login password |
| `TOTP_SECRET` | empty | Enables a 6-digit authenticator code as a second factor |
| `HOST` / `PORT` | `0.0.0.0` / `3456` | Listen address |
| `PUBLIC_URL` | browser URL | Hub URL used in the "Add machine" snippet |
| `TRUST_PROXY` | LAN/Docker ranges | Which proxies may set `X-Forwarded-*` |
| `EMBEDDED_AGENT` | `false` | Also serve this machine's projects from the hub process |
| `DATA_DIR` | `./.data` | Where the hub keeps its secret and paired machines |
| `SESSION_TTL_DAYS` | `14` | How long a login lasts |

Agent (standalone or embedded):

| Variable | Default | Meaning |
|---|---|---|
| `HUB_URL` | – (standalone: required) | e.g. `https://claude.example.com` |
| `AGENT_TOKEN` | – (standalone: required) | Token from **Machines → Add** |
| `BASE_DIR` | `~/source/repos` | Folder whose subfolders are listed as projects |
| `DEFAULT_PERMISSION_MODE` | `default` | `default`, `acceptEdits`, `plan`, `auto`, `dontAsk` |
| `ALLOW_BYPASS_PERMISSIONS` | `false` | Allow choosing `bypassPermissions` for this machine |
| `IDLE_CLOSE_MINUTES` | `120` | Stop idle sessions after this long (resumable) |

## Nginx Proxy Manager

1. **Proxy Host → Details**
   - Forward Hostname/IP: the hub (its LAN IP, the container name on NPM's Docker network, or
     `host.docker.internal` if NPM runs in Docker Desktop on the hub machine), Forward Port `3456`,
     scheme `http`
   - Enable **Websockets Support** (required: browsers *and* agents use WebSockets)
   - Enable **Block Common Exploits**
2. **SSL**: request a Let's Encrypt certificate, and enable **Force SSL** and **HTTP/2**.
3. **Advanced**: raise the body size limit so image uploads aren't rejected:
   ```nginx
   client_max_body_size 30m;
   proxy_read_timeout 1h;
   ```

Don't put an NPM Access List (basic auth) in front of the whole host: agents can't answer it. If you
want one, add a custom location for `/agent` without the access list.

If the hub runs natively on Windows and NPM is on another machine, open the port for NPM's IP only
(admin PowerShell):

```powershell
New-NetFirewallRule -DisplayName "Claude Remote" -Direction Inbound -Protocol TCP -LocalPort 3456 -RemoteAddress <NPM-IP> -Action Allow
```

## Security notes

Whoever signs in to the hub can run arbitrary commands on every connected machine, as the user running
its agent. Treat it accordingly:

- Use a long, unique `APP_PASSWORD`, and enable `TOTP_SECRET` when exposing the hub to the internet.
- Failed logins are rate-limited (5 per 15 min per IP, and TOTP codes can't be replayed). The login
  cookie is `HttpOnly` + `SameSite=Strict`, and `Secure` behind HTTPS. API calls need a same-origin
  header, and browser WebSocket upgrades check the cookie and `Origin`.
- Each machine has its own random token. The hub stores only its hash, and you can revoke tokens.
  Failed agent connections are rate-limited per IP.
- Always use an `https://` `HUB_URL` for agents outside your LAN. The agent warns otherwise.
- Each agent refuses to work outside its own `BASE_DIR`, whatever the hub asks.
- `bypassPermissions` is off unless enabled per machine. In the default mode, anything risky needs your
  explicit approval.

## Running permanently (Windows)

The simplest option is a Task Scheduler task that runs at logon. Use `start` for the hub and `run agent`
for an agent:

```powershell
$action = New-ScheduledTaskAction -Execute "npm.cmd" -Argument "run agent" -WorkingDirectory "C:\path\to\claude-remote"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "Claude Remote Agent" -Action $action -Trigger $trigger -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1))
```

Agents must run as your user, because they use your Claude login and `~/.claude` data.

## Limitations

- Notifications only arrive while the page or PWA is open or in the background with its connection
  alive. There is no push server. On iOS, notifications need the app added to the home screen.
- Sessions running in another process can be watched, not driven. Sending to them creates a fork.
- Live sessions survive a hub restart or network drop, since the agent keeps them running and the view
  re-syncs. They stop when their agent stops. Resume them afterwards from the dashboard.

## Project layout

```
hub/
  index.js      HTTP + WebSocket server: browser API, agent endpoint, relay
  machines.js   Paired machines, tokens, agent connections and RPC
  auth.js       Password + TOTP login, signed cookies, CSRF/origin checks
  config.js     Hub configuration
agent/
  index.js      Standalone agent: connects to the hub, reconnects
  core.js       Agent RPC methods and event forwarding (shared with the embedded agent)
  sessions.js   Live session manager (Agent SDK query(), permissions, agents/tasks)
  projects.js   Folder/session catalogue, detection of externally running sessions
  normalize.js  SDK/transcript messages → UI entries
  config.js     Agent configuration
public/         Frontend (vanilla JS, no build step)
```
