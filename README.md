# Claude Remote

A self-hosted, mobile-friendly web UI for Claude Code sessions on your dev machine. Put it behind
Nginx Proxy Manager and keep working with Claude from your phone.

- **Dashboard**: every folder in `BASE_DIR` with its Claude Code sessions. Shows which sessions are
  live, both the ones this app runs and ones open in a terminal or VS Code.
- **Start / resume / fork** a session in any folder. Resuming picks up the full history, including
  sessions you started at your desk.
- **Chat**: streamed replies, tool-call cards (diffs, commands, todo lists), image attachments
  (camera or gallery), slash-command suggestions, interrupt, and permission-mode and model switching.
- **Approvals on the go**: permission requests, `AskUserQuestion` prompts and plan approvals appear as
  cards with Allow / Always allow / Deny buttons. You get a toast or notification when Claude needs you
  or has finished.
- **Agent monitor**: every subagent and background task a session spawns, with live status, token and
  tool counts, progress summaries, its own activity feed, and a Stop button.
- **Watch mode**: sessions running elsewhere (e.g. the VS Code extension) are shown read-only and
  update live. Sending a message forks them so the two processes never write to the same transcript.

It uses the official [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).
Sessions it creates are ordinary Claude Code sessions stored in `~/.claude/projects`, so you can
`claude --resume` them at your desk later. It uses the Claude login already on this machine.

## Setup

Requires Node.js ≥ 22.9.

```powershell
npm install
copy .env.example .env      # then edit .env: set APP_PASSWORD and BASE_DIR
npm run totp-setup          # optional but recommended: prints a TOTP_SECRET for your authenticator app
npm start
```

Open `http://localhost:3456`, sign in, then on your phone use "Add to Home Screen" so it runs like an app.

### Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `APP_PASSWORD` | – (required, ≥ 12 chars) | Login password |
| `TOTP_SECRET` | empty | Enables a 6-digit authenticator code as a second factor |
| `BASE_DIR` | `~/source/repos` | Folder whose subfolders are listed as projects |
| `HOST` / `PORT` | `0.0.0.0` / `3456` | Listen address |
| `TRUST_PROXY` | LAN/Docker ranges | Which proxies may set `X-Forwarded-*` |
| `DEFAULT_PERMISSION_MODE` | `default` | `default`, `acceptEdits`, `plan`, `auto`, `dontAsk` |
| `ALLOW_BYPASS_PERMISSIONS` | `false` | Allow choosing `bypassPermissions` in the UI |
| `IDLE_CLOSE_MINUTES` | `120` | Stop idle sessions after this long (resumable) |
| `SESSION_TTL_DAYS` | `14` | How long a login lasts |

## Nginx Proxy Manager

1. **Proxy Host → Details**
   - Forward Hostname/IP: your dev machine's LAN IP (or `host.docker.internal` if NPM runs in Docker
     Desktop on the same machine), Forward Port `3456`, scheme `http`
   - Enable **Websockets Support** (required)
   - Enable **Block Common Exploits**
2. **SSL**: request a Let's Encrypt certificate, and enable **Force SSL** and **HTTP/2**.
3. **Advanced**: raise the body size limit so image uploads aren't rejected:
   ```nginx
   client_max_body_size 30m;
   proxy_read_timeout 1h;
   ```
4. Optional extra layer: add an NPM **Access List** (basic auth) in front of the app.

If NPM runs on a different machine, open the port in Windows Firewall for NPM's IP only, e.g.
(admin PowerShell):

```powershell
New-NetFirewallRule -DisplayName "Claude Remote" -Direction Inbound -Protocol TCP -LocalPort 3456 -RemoteAddress <NPM-IP> -Action Allow
```

## Security notes

This app gives whoever signs in the ability to run arbitrary commands on your machine as your user.
Treat it accordingly:

- Use a long, unique `APP_PASSWORD`, and enable `TOTP_SECRET` when exposing it to the internet.
- Failed logins are rate-limited (5 per 15 min per IP, and TOTP codes can't be replayed). The login
  cookie is `HttpOnly` + `SameSite=Strict`, and `Secure` behind HTTPS. API calls need a same-origin
  header, and WebSocket upgrades check the cookie and `Origin`.
- `bypassPermissions` is hidden unless you opt in. With the default mode, anything risky needs your
  explicit approval on the phone.
- Keep `HOST=127.0.0.1` if NPM runs natively on the same machine.

## Running it permanently (Windows)

The simplest option is a Task Scheduler task that runs at logon:

```powershell
$action = New-ScheduledTaskAction -Execute "npm.cmd" -Argument "start" -WorkingDirectory "C:\path\to\claude-remote"
$trigger = New-ScheduledTaskTrigger -AtLogOn
Register-ScheduledTask -TaskName "Claude Remote" -Action $action -Trigger $trigger -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1))
```

It must run as your user, because it uses your Claude login and `~/.claude` data.

## Limitations

- Notifications only arrive while the page or PWA is open or in the background with its connection
  alive. There is no push server. On iOS, notifications need the app added to the home screen.
- Sessions running in another process can be watched, not driven. Sending to them creates a fork.
- Live sessions this app runs stop when the server stops. Resume them afterwards from the dashboard.

## Project layout

```
server/
  index.js      HTTP + WebSocket server, routes
  sessions.js   Live session manager (Agent SDK query(), permissions, agents/tasks)
  projects.js   Folder/session catalogue, detection of externally running sessions
  normalize.js  SDK/transcript messages → UI entries
  auth.js       Password + TOTP login, signed cookies, CSRF/origin checks
  config.js     Environment configuration
public/         Frontend (vanilla JS, no build step)
```
