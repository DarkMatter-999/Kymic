import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';

const SKILLS_DIR = path.join(process.cwd(), 'skills');

function resolveSkillPath(skillId: string): string {
  const resolved = path.resolve(SKILLS_DIR, path.basename(skillId));
  const skillsRoot = path.resolve(SKILLS_DIR);
  if (!resolved.startsWith(skillsRoot + path.sep) && resolved !== skillsRoot) {
    throw new Error(`Invalid skill ID: "${skillId}"`);
  }
  return resolved;
}

async function ensureSkillsDir() {
  await fs.mkdir(SKILLS_DIR, { recursive: true });
}

async function getAvailableSkillIds(): Promise<string[]> {
  await ensureSkillsDir();
  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

interface SkillData {
  id: string;
  name: string;
  description: string;
  body: string;
  rawContent: string;
}

function parseSkillContent(id: string, rawContent: string): SkillData {
  const match = rawContent.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);

  let name = id;
  let description = 'No description provided.';
  let body = rawContent;

  if (match) {
    const frontmatter = match[1];
    body = match[2];

    const nameMatch = frontmatter.match(/name:\s*(.+)/i);
    const descMatch = frontmatter.match(/description:\s*(.+)/i);

    if (nameMatch) name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
    if (descMatch)
      description = descMatch[1].trim().replace(/^['"]|['"]$/g, '');
  }

  return { id, name, description, body, rawContent };
}

async function readSkill(skillId: string): Promise<SkillData | null> {
  const skillDir = resolveSkillPath(skillId);
  const skillPath = path.join(skillDir, 'SKILL.md');
  try {
    const content = await fs.readFile(skillPath, 'utf-8');
    return parseSkillContent(skillId, content);
  } catch {
    return null;
  }
}

const server = new McpServer({
  name: 'Skill-Manager',
  version: '1.0.0',
});

server.registerTool(
  'list_skills',
  {
    description:
      'List all available agent skills and their metadata (name and description).',
    inputSchema: {},
  },
  async () => {
    const skillIds = await getAvailableSkillIds();
    const skillsMetadata = [];

    for (const id of skillIds) {
      const skill = await readSkill(id);
      if (skill) {
        skillsMetadata.push(
          `- ID: ${skill.id}\n  Name: ${skill.name}\n  Description: ${skill.description}`
        );
      }
    }

    return {
      content: [
        {
          type: 'text',
          text:
            skillsMetadata.length > 0
              ? `Available skills:\n\n${skillsMetadata.join('\n\n')}`
              : 'No valid skills (missing SKILL.md) currently installed.',
        },
      ],
    };
  }
);

server.registerTool(
  'get_skill',
  {
    description:
      'Get the detailed workflow (SKILL.md) and instructions for a specific skill.',
    inputSchema: {
      skill_id: z
        .string()
        .describe('The ID (folder name) of the skill to retrieve.'),
    },
  },
  async ({ skill_id }) => {
    let skill: SkillData | null;
    try {
      skill = await readSkill(skill_id);
    } catch {
      return {
        isError: true,
        content: [{ type: 'text', text: `Invalid skill ID: "${skill_id}"` }],
      };
    }

    if (!skill) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Skill '${skill_id}' not found or missing SKILL.md file.`,
          },
        ],
      };
    }

    return {
      content: [{ type: 'text', text: skill.rawContent }],
    };
  }
);

server.registerTool(
  'search_skills',
  {
    description: 'Search for available agent skills based on a text query.',
    inputSchema: {
      query: z.string().describe('The search term or keywords to look for.'),
      limit: z
        .number()
        .min(1)
        .max(50)
        .optional()
        .default(5)
        .describe('Maximum number of results to return (1-50).'),
    },
  },
  async ({ query, limit }) => {
    const normalizedQuery = query.toLowerCase();
    const skillIds = await getAvailableSkillIds();
    const results: Array<{ skill: SkillData; score: number }> = [];

    for (const id of skillIds) {
      const skill = await readSkill(id);
      if (!skill) continue;

      const textToSearch =
        `${skill.name} ${skill.description} ${skill.body}`.toLowerCase();
      const terms = normalizedQuery.split(/\s+/).filter(Boolean);
      let score = 0;

      for (const term of terms) {
        const matches = textToSearch.split(term).length - 1;
        score += matches;
      }

      if (score > 0) {
        if (skill.name.toLowerCase().includes(normalizedQuery)) score += 10;
        if (skill.description.toLowerCase().includes(normalizedQuery))
          score += 5;
        results.push({ skill, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, limit);

    if (topResults.length === 0) {
      return {
        content: [
          { type: 'text', text: `No skills found matching query: "${query}"` },
        ],
      };
    }

    const formattedResults = topResults
      .map(
        (r) =>
          `Skill ID: ${r.skill.id} (Score: ${r.score})\nName: ${r.skill.name}\nDescription: ${r.skill.description}`
      )
      .join('\n\n');

    return {
      content: [
        {
          type: 'text',
          text: `Search results for "${query}":\n\n${formattedResults}`,
        },
      ],
    };
  }
);

server.registerTool(
  'read_skill_file',
  {
    description:
      'Read the contents of a specific file inside a skill\'s folder. Use this when a SKILL.md references an asset such as a script, config, or template (e.g. "run scripts/setup.sh" or "see template.json").',
    inputSchema: {
      skill_id: z.string().describe('The ID (folder name) of the skill.'),
      file_path: z
        .string()
        .describe(
          'Relative path to the file within the skill folder, ' +
            'e.g. "scripts/setup.sh" or "template.json".'
        ),
    },
  },
  async ({ skill_id, file_path }) => {
    const safeSkillId = path.basename(skill_id);

    const skillDir = path.resolve(SKILLS_DIR, safeSkillId);
    const resolvedFile = path.resolve(skillDir, file_path);

    if (!resolvedFile.startsWith(skillDir + path.sep)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Access denied: file_path must resolve within the skill folder.',
          },
        ],
      };
    }

    const ALLOWED_EXTENSIONS = new Set([
      '.md',
      '.txt',
      '.sh',
      '.bash',
      '.zsh',
      '.js',
      '.ts',
      '.py',
      '.rb',
      '.json',
      '.yaml',
      '.yml',
      '.toml',
      '.env.example',
      '.html',
      '.css',
      '.sql',
    ]);
    const ext = path.extname(resolvedFile).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `File type '${ext || '(none)'}' is not permitted. Allowed: ${[...ALLOWED_EXTENSIONS].join(', ')}`,
          },
        ],
      };
    }

    try {
      const content = await fs.readFile(resolvedFile, 'utf-8');
      return {
        content: [
          {
            type: 'text',
            text: `Contents of '${safeSkillId}/${file_path}':\n\n${content}`,
          },
        ],
      };
    } catch (error: unknown) {
      const isNotFound =
        typeof error === 'object' &&
        error !== null &&
        (error as NodeJS.ErrnoException).code === 'ENOENT';

      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: isNotFound
              ? `File '${file_path}' not found in skill '${safeSkillId}'.`
              : `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
