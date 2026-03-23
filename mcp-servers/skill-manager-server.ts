import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import path from 'path';

const SKILLS_DIR = path.join(process.cwd(), 'skills');

async function ensureSkillsDir() {
  try {
    await fs.access(SKILLS_DIR);
  } catch {
    await fs.mkdir(SKILLS_DIR, { recursive: true });
  }
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
  const skillPath = path.join(SKILLS_DIR, skillId, 'SKILL.md');
  try {
    const content = await fs.readFile(skillPath, 'utf-8');
    return parseSkillContent(skillId, content);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  } catch (error: any) {
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
    const safeSkillId = path.basename(skill_id);
    const skill = await readSkill(safeSkillId);

    if (!skill) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Skill '${safeSkillId}' not found or missing SKILL.md file.`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: skill.rawContent,
        },
      ],
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
        .optional()
        .default(5)
        .describe('Maximum number of results to return.'),
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
