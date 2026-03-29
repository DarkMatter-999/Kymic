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
