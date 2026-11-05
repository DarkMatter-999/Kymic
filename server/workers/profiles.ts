import type { ProfileDef } from './launcher.js';

const CANVAS = './extensions/canvas.mjs';
const SUBAGENTS = './extensions/subagents.mjs';

/**
 * Operator-defined tool profiles. A conversation picks one by name when it
 * first runs and keeps it. Each control is independent:
 *  - `codemode` extension  → the `codemode` tool exists at all
 *  - `mcp` extension       → MCP servers exist at all (also hidden from codemode)
 *  - `tools`               → which tools the model is offered
 */
export const DEFAULT_PROFILES: Record<string, ProfileDef> = {
  full: {
    label: 'Full',
    description:
      'Coding tools, codemode with MCP servers, canvas and subagents.',
    extensions: ['builtin:mcp', 'builtin:codemode', CANVAS, SUBAGENTS],
    tools: '+codemode',
  },
  workspace: {
    label: 'Workspace',
    description: 'Coding tools and canvas. No codemode, MCP or subagents.',
    extensions: [CANVAS],
  },
  chat: {
    label: 'Chat',
    description: 'Conversation and canvas only. No file, shell or MCP access.',
    extensions: [CANVAS],
    tools: 'update_canvas',
  },
};
