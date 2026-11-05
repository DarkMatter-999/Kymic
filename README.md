# Code Mode AI Agents

Code Mode AI Agents is a autonomous AI orchestration platform that leverages the **Model Context Protocol (MCP)** and an interactive **Code Mode** execution paradigm to build highly capable, secure, and context-efficient AI agents.

This project addresses the limitations of traditional "JSON tool calling" by providing agents with a dynamic JavaScript interactive REPL environment. Instead of injecting hundreds of static tool definitions into the model context (which leads to "context rot" and massive token consumption), agents dynamically write, evaluate, and execute scripts to discover tools and manipulate data on demand.

https://github.com/user-attachments/assets/c0e68e8a-7434-4fb0-8120-629b1261b604

## Key Architectural Features

- **Code Mode Execution**: Agents are equipped with an interactive programmatic interpreter. By batching multiple operations into a single script, the system dramatically reduces network round-trips and lowers token usage when compared to traditional tool calling.
- **Orchestrator-Subagent Architecture**: Highly complex tasks are delegated from a primary Orchestrator agent to specialized subagents. Subagents operate in isolated contexts, returning only highly condensed, relevant summaries to the Orchestrator.
- **Dynamic Skill Acquisition (Skill MCP)**: Instead of loading all potential skills into memory, the agent can actively search for and retrieve expert workflows and methodologies only when needed.
- **Browser-Native Canvas Interfaces**: A dedicated Canvas MCP allows agents to generate and display interactive structural outputs (data visualizations, architectural diagrams, forms) in the UI.
- **Sandboxing**:
  - **Node.js**: Lightweight JavaScript execution runs in highly restricted V8 engine contexts for rapid logical operations without access to system APIs.
  - **Docker Containerization**: Operations requiring CLI access, networking, or file system modifications are executed within completely isolated Docker environments to protect the host system.

## Tech Stack

- **Frontend**: React, TypeScript, Vite, Tailwind CSS
- **Backend**: Node.js, Express, WebSocket (`ws`), Redis (`ioredis`)
- **AI & Agent Integrations**:
  - Vercel AI SDK (`ai`, `@ai-sdk/openai`, `@ai-sdk/react`)
  - Cloudflare Code Mode (`@cloudflare/codemode`)
  - Model Context Protocol (`@modelcontextprotocol/sdk`)

## Deploying the Pi gateway (Docker)

One app container runs the gateway, which serves the UI and starts one Pi process per conversation as an unprivileged `agent` user. An allowlist proxy is the only way out to the internet, and nginx is the only published port.

```bash
GATEWAY_PASSWORD='at least 12 characters' PUBLIC_ORIGIN=http://127.0.0.1:8080 \
  docker compose -f docker-compose.prod.yml up -d --build
# open http://127.0.0.1:8080, sign in, then add a model provider under Settings
```

- `PUBLIC_ORIGIN` must be the exact origin you type in the browser; the gateway rejects every other `Origin`.
- **Remote access needs TLS.** Put a certificate and key in `certs/tls.crt` and `certs/tls.key`, then set `NGINX_CONF=nginx.tls.conf COOKIE_SECURE=1 PUBLIC_ORIGIN=https://your.host BIND_ADDRESS=0.0.0.0 HTTP_PORT=80 HTTPS_PORT=443`. Without TLS keep the default loopback binding.
- `EGRESS_ALLOW` is the list of hosts workers and sign-in may reach. The default covers common model providers and is a starting point: add the hosts for the providers you use, or sign-in and model calls will be refused (check `docker compose logs egress`).
- Sign-in through the browser: OAuth flows that redirect to `localhost` on the server cannot complete from another machine; use the device-code or paste-the-URL option when offered.
- Health: `GET /health` (process up) and `GET /health/ready` (Pi CLI, worker files and data directory usable). Neither requires login or reveals details.
- Known limit: the agent's shell runs as the `agent` user and can read that user's Pi configuration, including provider credentials saved by sign-in. The egress allowlist limits where they could be sent, but treat the agent as able to see them.

Opt-in checks against the real image: `DOCKER_TESTS=1 node --import tsx --test tests/docker-acceptance.test.mjs` (add `ACCEPTANCE_TLS=1` for the TLS edge).

## Getting Started

### Prerequisites

- Node.js (v24 or compatible)
- Redis Server (or Docker to run Redis)
- Docker & Docker Compose (for containerized execution and Sandbox)

### Installation

1. Clone the repository and install dependencies:

   ```bash
   npm install
   ```

2. Configure environment variables:
   Copy `.env.example` to `.env` and fill in your AI provider API keys, Redis URL, and MCP server configurations.
   ```bash
   cp .env.example .env
   ```

### Running the Development Environment

#### Using Docker Compose (Recommended)

To easily spin up the entire application stack including Redis, the backend server, and the frontend via Docker:

```bash
# Development build
docker-compose -f docker-compose.dev.yml up --build

# Production build
docker-compose -f docker-compose.prod.yml up --build
```

#### Running Locally (Manual)

Alternatively, you can start the React frontend (Vite) and the Express/WebSocket backend simultaneously on your host machine.

**Frontend:**

```bash
npm run dev
```

**Backend API & WebSocket Server:**

```bash
npm run dev:server
```

### Production Build

To build the client for production:

```bash
npm run build
```
