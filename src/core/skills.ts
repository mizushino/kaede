import { defineTool } from '@github/copilot-sdk';
import { z, type ZodType } from 'zod';
import { readdir, readFile, writeFile, unlink } from 'fs/promises';
import { mkdirSync } from 'fs';
import path from 'path';
import { createRequire } from 'module';

/** Plain tool definition exported by skill files (no SDK dependency needed). */
interface RawTool {
  name: string;
  description: string;
  parameters: ZodType;
  handler: (args: any) => Promise<unknown>;
}

export class SkillLoader {
  readonly skillsDir: string;

  constructor(skillsDir: string) {
    this.skillsDir = path.resolve(skillsDir);
    mkdirSync(this.skillsDir, { recursive: true });
  }

  /** Import a skill file and return its raw tools. Always loads fresh (no cache). */
  private async importSkill(file: string, ctx: unknown): Promise<RawTool[]> {
    const filePath = path.join(this.skillsDir, file);
    // Clear the CJS require cache so edits to skill files take effect immediately.
    const _require = createRequire(__filename);
    try { delete _require.cache[_require.resolve(filePath)]; } catch { /* ignore */ }
    const mod = await import(`${filePath}?t=${Date.now()}`);
    if (typeof mod.createTools !== 'function') return [];
    const tools = mod.createTools(ctx);
    return Array.isArray(tools) ? tools : [];
  }

  /** Load skill tools wrapped with defineTool for session registration. */
  async loadTools(ctx: unknown): Promise<any[]> {
    const files = await this.listFiles();
    const sdkTools: any[] = [];

    for (const file of files) {
      try {
        const rawTools = await this.importSkill(file, ctx);
        for (const t of rawTools) {
          sdkTools.push(defineTool(t.name, {
            description: t.description,
            parameters: t.parameters,
            skipPermission: true,
            handler: t.handler,
          }));
        }
        if (rawTools.length) console.log(`[skills] ${file}: ${rawTools.length} tool(s)`);
      } catch (err) {
        console.error(`[skills] Failed to load ${file}:`, err);
      }
    }
    return sdkTools;
  }

  /** Create CRUD management tools for skills. */
  createTools(ctx: unknown) {
    return [
      defineTool('list_skills', {
        description: 'List installed skills.',
        parameters: z.object({}),
        skipPermission: true,
        handler: async () => {
          const files = await this.listFiles();
          const skills: { file: string; name?: string; description?: string }[] = [];
          for (const file of files) {
            const meta: typeof skills[number] = { file };
            try {
              const src = await readFile(path.join(this.skillsDir, file), 'utf-8');
              meta.name = src.match(/export\s+const\s+name\s*=\s*['"`]([^'"`]+)['"`]/)?.[1];
              meta.description = src.match(/export\s+const\s+description\s*=\s*['"`]([^'"`]+)['"`]/)?.[1];
            } catch { /* skip unreadable files */ }
            skills.push(meta);
          }
          return { skills };
        },
      }),

      defineTool('read_skill', {
        description: 'Read a skill file\'s source code.',
        parameters: z.object({ filename: z.string() }),
        skipPermission: true,
        handler: async ({ filename }) => {
          try {
            return { content: await readFile(path.join(this.skillsDir, this.sanitize(filename)), 'utf-8') };
          } catch (err: unknown) {
            return { error: (err as Error).message };
          }
        },
      }),

      defineTool('write_skill', {
        description: `Create or overwrite a skill file. Must export: name (string), description (string), createTools(ctx) returning array of {name, description, parameters: z.object(...), handler: async (args) => result}. No SDK import needed — only zod. Use run_skill to invoke immediately.`,
        parameters: z.object({
          filename: z.string().describe('e.g. "weather.ts"'),
          content: z.string().describe('Full TypeScript source'),
        }),
        skipPermission: true,
        handler: async ({ filename, content }) => {
          try {
            const safe = this.sanitize(filename);
            if (!/\.(ts|js|mjs)$/.test(safe)) return { error: 'Must end in .ts/.js/.mjs' };
            const p = path.join(this.skillsDir, safe);
            await writeFile(p, content, 'utf-8');
            return { success: true, path: p };
          } catch (err: unknown) {
            return { error: (err as Error).message };
          }
        },
      }),

      defineTool('delete_skill', {
        description: 'Delete a skill file.',
        parameters: z.object({ filename: z.string() }),
        skipPermission: true,
        handler: async ({ filename }) => {
          try {
            await unlink(path.join(this.skillsDir, this.sanitize(filename)));
            return { success: true };
          } catch (err: unknown) {
            return { error: (err as Error).message };
          }
        },
      }),

      defineTool('run_skill', {
        description: 'Run a tool from a skill file. Use after write_skill to invoke immediately in this session.',
        parameters: z.object({
          filename: z.string().describe('Skill filename'),
          tool: z.string().describe('Tool name to invoke'),
          args: z.record(z.string(), z.unknown()).optional().describe('Tool arguments'),
        }),
        skipPermission: true,
        handler: async ({ filename, tool, args }) => {
          try {
            const rawTools = await this.importSkill(this.sanitize(filename), ctx);
            const t = rawTools.find(t => t.name === tool);
            if (!t) return { error: `Tool '${tool}' not found. Available: ${rawTools.map(t => t.name).join(', ')}` };
            return await t.handler(args ?? {});
          } catch (err: unknown) {
            return { error: (err as Error).message };
          }
        },
      }),
    ];
  }

  /** Strip directory components to prevent path traversal. */
  private sanitize(filename: string): string {
    return path.basename(filename);
  }

  private async listFiles(): Promise<string[]> {
    try {
      const entries = await readdir(this.skillsDir);
      return entries.filter(f => /\.(ts|js|mjs)$/.test(f));
    } catch {
      return [];
    }
  }
}
