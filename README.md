# Code Mode AI Agents

A self-hosted web GUI for the [Pi](https://github.com/earendil-works) coding agent, for one user. You sign in, pick a model provider, and chat with an agent that can run code, call MCP servers through **codemode**, show an interactive canvas, delegate to subagents, and run scheduled prompts in the background.

Pi owns the agent: its tools, sessions, history, forks and compaction. This project is the gateway and the interface around it. It does not replay history from the browser, and it does not run model calls itself.

https://github.com/user-attachments/assets/c0e68e8a-7434-4fb0-8120-629b1261b604

> **Trust model in one line:** everything the agent can do, it can do as the unprivileged `agent` user inside the container, with that user's files and credentials. Read [SECURITY.md](SECURITY.md) before exposing this beyond your own machine.

## What you get

- **Chat over Pi RPC.** One Pi process per conversation, started on demand and kept running while a turn is in progress, even if the browser closes. Reloading restores the conversation from Pi's own session.
- **Edit and regenerate.** Both fork Pi's session at that message; the original branch stays on disk.
- **Extension dialogs.** Questions that extensions ask (select, confirm, input, editor) appear as dialogs. Closing one is a denial, never an approval.
- **Codemode and MCP.** Agents write JavaScript that calls MCP tools on demand instead of loading every tool definition.
- **Canvas.** The agent can show HTML/CSS/JS in a sandboxed frame with no network access and no access to the app.
- **Subagents.** `run_subagent` delegates a task to a child Pi process; lifecycle shows in the Subagents panel.
- **Tool profiles.** Pick **Full**, **Workspace** or **Chat** when a conversation starts; the choice is recorded and cannot change.
- **Scheduled tasks.** Run a prompt every N minutes, daily, or on chosen weekdays at a local time (daylight-saving aware). Runs happen on the server without a browser.
- **Provider sign-in in the GUI.** Settings lists the providers Pi supports and drives their OAuth, device-code and API-key flows.
- **Skills.** Pi discovers the skills listed in `PI_SKILLS` (a small example ships in `skills/spike`).

## Run it locally

Requires Node.js 24.

```bash
npm install
cp .env.example .env     # optional
```

Terminal 1, the gateway (serves the API and the agent socket):

```bash
GATEWAY_PASSWORD='at least 12 characters' PORT=3100 npm run dev:server
```

Terminal 2, the frontend:

```bash
VITE_PROXY_TARGET=http://127.0.0.1:3100 npm run dev
```

Open http://localhost:5173, sign in with the password, open **Settings**, and sign in to a model provider. Then send a message.

For development without a login (loopback only), set `PI_GATEWAY_INSECURE_DEV=1` instead of a password. Never do this on a reachable host.

### Try it without a model account

A scripted fake model lets you exercise the whole UI offline:

```bash
export PI_AGENT_HOME=$PWD/.pi-data/fake-home        # keep it apart from any real sign-in
node --import tsx scripts/dev-fake-model.mjs        # starts the fake model and writes a Pi home that uses it
PI_GATEWAY_INSECURE_DEV=1 PORT=3100 PI_EXTENSIONS=builtin:mcp,builtin:codemode,./tests/fixtures/extensions/dialog-ext.mjs npm run dev:server
```

Commands such as `/ask select`, `/ask confirm` and `/noise` trigger extension dialogs.

## Configuration

All settings are environment variables on the gateway.

| Variable                                            | Default                   | Purpose                                                              |
| --------------------------------------------------- | ------------------------- | -------------------------------------------------------------------- |
| `GATEWAY_PASSWORD`                                  | none                      | Login password, 12+ characters. Without it, protected routes deny.   |
| `PI_GATEWAY_INSECURE_DEV`                           | off                       | `1` disables login. Local development only.                          |
| `ALLOWED_ORIGINS`                                   | `http://localhost:5173`   | Exact browser origins allowed (comma separated). Others are refused. |
| `COOKIE_SECURE`                                     | off                       | `1` when served over HTTPS.                                          |
| `SESSION_TTL_HOURS`                                 | 168                       | Login lifetime.                                                      |
| `PORT` / `HOST`                                     | `3000` / `127.0.0.1`      | Listen address. Containers set `HOST=0.0.0.0` behind the proxy.      |
| `PI_DATA_DIR`                                       | `./.pi-data`              | Gateway state: login and schedule databases.                         |
| `PI_AGENT_HOME`                                     | `$PI_DATA_DIR/agent-home` | Pi's configuration, including provider credentials.                  |
| `PI_WORKSPACE_DIR`, `PI_SESSION_DIR`, `PI_META_DIR` | under `PI_DATA_DIR`       | Where workers and records live (set separately in the container).    |
| `PI_AGENT_UID`, `PI_AGENT_GID`                      | unset                     | Run workers as this user. Needs root and `PI_META_DIR`.              |
| `PI_SKILLS`                                         | `./skills/spike/SKILL.md` | Skill files or directories to load (comma separated).                |
| `PI_EXTENSIONS`                                     | unset                     | Replaces the tool profiles with one explicit extension list.         |
| `PI_WORKER_PROXY`                                   | unset                     | HTTP proxy URL that workers must use for the internet.               |
| `STATIC_DIR`                                        | unset                     | Serve the built frontend from here (the container sets it).          |

Extensions and profiles are chosen by the operator only. A browser request can name a profile; it can never supply a path, argument or environment variable.

## Model providers

Open **Settings → Model providers**. Each provider lists the sign-in methods Pi offers: OAuth (browser or device code) or an API key. Credentials are saved by Pi into `PI_AGENT_HOME/auth.json`. The key you type is sent to Pi and never shown again.

- **From another machine:** an OAuth flow that redirects to `localhost` on the server cannot finish in your browser. Pick the **device code** option when offered, or paste the redirect URL when asked.
- **Subscription logins (ChatGPT, Claude):** the GUI drives whatever Pi supports for the provider. Whether a particular subscription works in a headless or containerised setup depends on the provider and is not guaranteed by this project; verify it with your own account.
- Signing in or out restarts idle conversations' Pi processes (they resume the same session) so they pick up the change; a conversation that is mid-reply restarts when the reply ends.
- **Choosing a model.** Settings → **Default model** sets the model for new conversations, and the model selector in the chat header switches the current conversation (while it is idle; history carries over). The lists show the models your signed-in providers offer; the refresh button asks providers that discover models dynamically (for example local servers or aggregators) for their current list. A model you add through your own `models.json` works in Pi but is not listed here, because the gateway never reads that file (the agent controls it and it can name commands to run).

You can also place a Pi `models.json` or `mcp.json` in `PI_AGENT_HOME` to add custom model endpoints or MCP servers.

## Deploy with Docker

One app container runs the gateway, which also serves the UI and starts one Pi process per conversation as an unprivileged `agent` user. An allowlist proxy is the only way out to the internet, and nginx is the only published port.

```bash
GATEWAY_PASSWORD='at least 12 characters' PUBLIC_ORIGIN=http://127.0.0.1:8080 \
  docker compose -f docker-compose.prod.yml up -d --build
# open http://127.0.0.1:8080, sign in, then add a model provider under Settings
```

- `PUBLIC_ORIGIN` must be the exact origin you type in the browser.
- **Remote access needs TLS.** Put a certificate and key in `certs/tls.crt` and `certs/tls.key`, then set `NGINX_CONF=nginx.tls.conf COOKIE_SECURE=1 PUBLIC_ORIGIN=https://your.host BIND_ADDRESS=0.0.0.0 HTTP_PORT=80 HTTPS_PORT=443`. Without TLS keep the default loopback binding.
- `EGRESS_ALLOW` lists the hosts workers and provider sign-in may reach. The default is a starting point for common providers; add the hosts for the ones you use, or sign-in and model calls are refused (see `docker compose logs egress`).
- **Health:** `GET /health` (process up) and `GET /health/ready` (Pi CLI, worker files and data directory usable). Neither needs a login or reveals details.
- Development compose (`docker-compose.dev.yml`) is for hot reload on loopback only; it is not the isolation model used in production.

### Backup and recovery

Everything lives in one volume, `app-data`, mounted at `/data`:

| Path                     | Contents                                                            | If lost                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `/data/agent/sessions`   | Pi session files: all conversation history and forks                | Conversations are gone                                                                                                                        |
| `/data/agent/workspaces` | Files the agent created                                             | Agent work product is gone                                                                                                                    |
| `/data/agent/home`       | Provider credentials, `models.json`, `mcp.json`                     | Sign in to providers again                                                                                                                    |
| `/data/gateway`          | Login sessions, schedules and run history, per-conversation records | Everyone is signed out; schedules are gone; conversations keep their history but fall back to the newest session file and the default profile |

Back up while the stack is stopped (the databases use write-ahead logs):

```bash
docker compose -f docker-compose.prod.yml stop app
docker volume ls | grep app-data        # the volume is named <project>_app-data
docker run --rm -v codemodeagents_app-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/app-data.tgz -C /data .
docker compose -f docker-compose.prod.yml start app
```

Restore by extracting the archive into an empty volume before starting. The backup contains provider credentials; protect it like a password file.

## Tests

```bash
npx tsc -b && npm run lint && npm run build
node --import tsx --test --test-timeout=90000 tests/*.test.mjs
```

The suite drives real Pi processes against a scripted fake model, so it needs no accounts or network. Checks that need Docker are opt-in:

```bash
DOCKER_TESTS=1 node --import tsx --test tests/docker-acceptance.test.mjs
DOCKER_TESTS=1 ACCEPTANCE_TLS=1 node --import tsx --test tests/docker-acceptance.test.mjs   # through the TLS edge
```

One test needs root (it checks the user switch for workers) and is skipped otherwise; the Docker acceptance test covers the same property in the real image.

## How it is put together

```
browser ── HTTP + WebSocket ──▶ nginx (optional) ──▶ gateway (Express)
                                                       │  auth, origin checks, schedules, sign-in
                                                       └─ one Pi RPC process per conversation
                                                            tools · codemode/MCP · canvas · subagents
```

- `server/gateway/` — WebSocket protocol, conversations, dialogs, history, login and auth.
- `server/workers/` — starts Pi processes (fixed arguments, scrubbed environment, tool profiles).
- `server/scheduler/` — durable schedules and recurrence.
- `extensions/` — the canvas and subagent tools that Pi loads.
- `src/` — the React interface.
- `server/egress-proxy.ts` — the allowlist proxy used in the container deployment.

## License

MIT
