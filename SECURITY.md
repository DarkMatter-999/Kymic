# Security model

This is a **single-user** application. It is built so that one trusted person can run an agent on their own machine or server. It is not a multi-tenant service, and it does not defend one conversation against another.

## Who can do what

| Party                                                     | Can                                                                                                              | Cannot                                                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Anyone on the network                                     | Load the page, call `/health`, attempt a login                                                                   | Reach any API or the agent socket without a session                                                  |
| You (signed in)                                           | Everything below, including every conversation                                                                   | Change the gateway's code, or run anything as root                                                   |
| The agent (and its subagents, MCP servers and extensions) | Run commands and read/write files as the `agent` user; call allowlisted hosts; read that user's Pi configuration | Write the application code, read gateway data, reach the internet except through the allowlist proxy |

**Everything the agent is given, it can use freely and can be talked into misusing.** Prompt injection from web pages, files or tool output can steer it. The boundaries below limit the damage; they do not make the agent safe to point at untrusted input with valuable access.

## Authentication

- Set `GATEWAY_PASSWORD` (12+ characters). The first request to the page shows a login screen; there is no account creation and no default password.
- The password is compared with scrypt and a constant-time check. Sessions are random tokens; only a hash is stored. The cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` when `COOKIE_SECURE=1`.
- Failed logins are rate limited globally. Logout invalidates the session on the server.
- Every state-changing request and every WebSocket upgrade must carry an `Origin` in `ALLOWED_ORIGINS`. A token in a URL never authenticates.
- Without a password, protected routes deny access. `PI_GATEWAY_INSECURE_DEV=1` turns login off and must never be used on a reachable host.
- **Use TLS for anything off your own machine.** Without it the password and session cookie cross the network in clear text.

## Isolation in the container deployment

- The gateway runs as root only to start each Pi process as user 10001 (`agent`). It keeps five capabilities (`CHOWN`, `FOWNER`, `SETUID`, `SETGID`, `DAC_READ_SEARCH`), runs with a read-only root filesystem and `no-new-privileges`, and has memory and process limits.
- Application code is root-owned and read-only to the agent. Gateway state (login and schedule databases, per-conversation records) is root-only. The agent cannot write the directories the gateway writes into.
- The app container's network has **no route to the internet**. The only way out is an allowlist proxy that refuses unlisted hosts, unlisted ports, and anything that resolves to a private or link-local address. This applies to shell commands too, whatever proxy settings they ignore.
- No Docker socket is mounted. Only nginx publishes a port, on loopback unless you change `BIND_ADDRESS`.
- Verified by automated tests against the real image: the worker runs as uid 10001; it cannot write `/app`, read or list gateway data, or open a direct connection to the internet; a fetch to an unlisted host is refused. See `tests/docker-acceptance.test.mjs`.

## Known limits and residual risks

- **Credentials are visible to the agent.** Provider credentials saved by GUI sign-in live in the `agent` user's Pi home (`auth.json`), and the agent's shell runs as that user, so it can read them. The egress allowlist limits where they could be sent, but an allowlisted host (a model provider) is still a place they could be sent to. Use API keys with spending limits where you can, and do not run untrusted input through an agent that holds valuable subscription logins.
- **Conversations share one identity.** All Pi processes run as the same `agent` user, so one conversation can read another's workspace and session files. This is a single-user product; do not give someone else access to it.
- **Subagents and extensions are not sandboxed from the worker.** A subagent is a child process with the worker's identity and environment. MCP servers you configure run with the same access.
- **The default egress allowlist is a starting point.** It lists common model-provider hosts, but the exact hosts each provider's sign-in needs have not been verified; if a flow is refused, read `docker compose logs egress` and add the host. Only a scripted local model has been exercised through the proxy.
- **Canvas.** Generated HTML runs in an iframe without `allow-same-origin` and with a CSP that blocks all network requests, so it cannot read the app's cookies or storage or call its API. It cannot load external libraries or fonts. This was checked in headless Chromium; other browsers were not tested.
- **Subscription logins are unverified here.** Whether a ChatGPT or Claude subscription login works headless or in the container depends on the provider's flow and policy; this project drives Pi's login and makes no promise about it.
- **No per-conversation limits.** Nothing caps tokens or spend. Schedules cap frequency (at least one minute), the number of schedules, and prompt size, but a schedule running a costly prompt every minute is allowed.
- **Edit or regenerate on an older message** forks the session and continues from there; later messages stay on the original branch but are no longer shown. There is no branch picker yet.
- **The gateway process is a single point of failure.** Pi processes and schedules stop with it. After a restart, runs that were in flight are marked interrupted and never retried automatically, because their side effects are unknown.

## Scheduled tasks

Schedules run on the server with no browser. An occurrence runs at most once. If the gateway was down at the due time, that occurrence is skipped (not run late); if the conversation is busy, the occurrence is recorded as skipped. A run left in flight by a crash is marked **interrupted** and is not re-run. A scheduled prompt runs with the same access as any other prompt in that conversation, with no one watching, so keep scheduled prompts narrow. Daylight-saving rules: a local time that does not exist runs once at the shifted time; a repeated local time runs once, at the first occurrence.

## Reporting problems

This is a personal project. Open an issue on the repository, and do not include credentials or conversation contents.
