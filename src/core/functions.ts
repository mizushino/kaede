import { defineTool } from '@github/copilot-sdk';
import { z, type ZodType } from 'zod';
import { readdir, readFile, writeFile, unlink } from 'fs/promises';
import { mkdirSync } from 'fs';
import path from 'path';
import { logger } from './logger.js';

/** Plain tool definition exported by function files (no SDK dependency needed). */
interface RawTool {
  name: string;
  description: string;
  parameters: ZodType;
  handler: (args: any) => Promise<unknown>;
}

export class FunctionLoader {
  readonly functionsDir: string;

  constructor(functionsDir: string) {
    this.functionsDir = path.resolve(functionsDir);
    mkdirSync(this.functionsDir, { recursive: true });
  }

  /** Import a function file and return its raw tools. Always loads fresh (no cache). */
  private async importFunction(file: string, ctx: unknown): Promise<RawTool[]> {
    const filePath = path.join(this.functionsDir, file);
    // Use dynamic import with cache busting for fresh loads
    const mod = await import(`${filePath}?t=${Date.now()}`);
    if (typeof mod.createTools !== 'function') return [];
    const tools = mod.createTools(ctx);
    return Array.isArray(tools) ? tools : [];
  }

  /** Load function tools wrapped with defineTool for session registration. */
  async loadTools(ctx: unknown): Promise<any[]> {
    const files = await this.listFiles();
    const sdkTools: any[] = [];

    for (const file of files) {
      try {
        const rawTools = await this.importFunction(file, ctx);
        for (const t of rawTools) {
          sdkTools.push(defineTool(t.name, {
            description: t.description,
            parameters: t.parameters,
            skipPermission: true,
            handler: t.handler,
          }));
        }
        if (rawTools.length) logger.log(`[functions] ${file}: ${rawTools.length} tool(s)`);
      } catch (err) {
        logger.error(`[functions] Failed to load ${file}:`, err);
      }
    }
    return sdkTools;
  }

  /** Create CRUD management tools for functions. */
  createTools(ctx: unknown) {
    return [
      defineTool('list_funcs', {
        description: 'List installed functions.',
        parameters: z.object({}),
        skipPermission: true,
        handler: async () => {
          const files = await this.listFiles();
          const functions: { file: string; name?: string; description?: string }[] = [];
          for (const file of files) {
            const meta: typeof functions[number] = { file };
            try {
              const src = await readFile(path.join(this.functionsDir, file), 'utf-8');
              meta.name = src.match(/export\s+const\s+name\s*=\s*['"`]([^'"`]+)['"`]/)?.[1];
              meta.description = src.match(/export\s+const\s+description\s*=\s*['"`]([^'"`]+)['"`]/)?.[1];
            } catch { /* skip unreadable files */ }
            functions.push(meta);
          }
          return { functions };
        },
      }),

      defineTool('read_func', {
        description: 'Read a function file\'s source code.',
        parameters: z.object({ filename: z.string() }),
        skipPermission: true,
        handler: async ({ filename }) => {
          try {
            return { content: await readFile(path.join(this.functionsDir, this.sanitize(filename)), 'utf-8') };
          } catch (err: unknown) {
            return { error: (err as Error).message };
          }
        },
      }),

      defineTool('write_func', {
        description: `Create or overwrite a function file. Must export: name (string), description (string), createTools(ctx) returning array of {name, description, parameters: z.object(...), handler: async (args) => result}. No SDK import needed — only zod. Use run_func to invoke immediately.`,
        parameters: z.object({
          filename: z.string().describe('e.g. "weather.ts"'),
          content: z.string().describe('Full TypeScript source'),
        }),
        skipPermission: true,
        handler: async ({ filename, content }) => {
          try {
            const safe = this.sanitize(filename);
            if (!/\.(ts|js|mjs)$/.test(safe)) return { error: 'Must end in .ts/.js/.mjs' };
            const p = path.join(this.functionsDir, safe);
            await writeFile(p, content, 'utf-8');
            return { success: true, path: p };
          } catch (err: unknown) {
            return { error: (err as Error).message };
          }
        },
      }),

      defineTool('delete_func', {
        description: 'Delete a function file.',
        parameters: z.object({ filename: z.string() }),
        skipPermission: true,
        handler: async ({ filename }) => {
          try {
            await unlink(path.join(this.functionsDir, this.sanitize(filename)));
            return { success: true };
          } catch (err: unknown) {
            return { error: (err as Error).message };
          }
        },
      }),

      defineTool('run_func', {
        description: 'Run a tool from a function file. Use after write_func to invoke immediately in this session.',
        parameters: z.object({
          filename: z.string().describe('Function filename'),
          tool: z.string().describe('Tool name to invoke'),
          args: z.record(z.string(), z.unknown()).optional().describe('Tool arguments'),
        }),
        skipPermission: true,
        handler: async ({ filename, tool, args }) => {
          try {
            const rawTools = await this.importFunction(this.sanitize(filename), ctx);
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
      const entries = await readdir(this.functionsDir);
      return entries.filter(f => /\.(ts|js|mjs)$/.test(f));
    } catch {
      return [];
    }
  }
}
