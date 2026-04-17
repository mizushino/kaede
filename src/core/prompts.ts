import fs from 'fs';
import path from 'path';

export interface PromptFile {
  name: string;
  description?: string;
  content: string;
  filePath: string;
  agent?: string;
  model?: string;
  tools?: string[];
  argumentHint?: string;
}

export class PromptLoader {
  private prompts = new Map<string, PromptFile>();
  private promptsDir: string;

  constructor(promptsDir?: string) {
    // Default to {WORKSPACE}/.github/prompts
    const workspaceDir = process.env.WORKSPACE_DIR || './workspace';
    const defaultDir = path.join(workspaceDir, '.github/prompts');
    this.promptsDir = path.resolve(promptsDir || defaultDir);
  }

  /**
   * Load all .prompt.md files from the prompts directory
   */
  async loadPrompts(): Promise<Map<string, PromptFile>> {
    this.prompts.clear();

    if (!fs.existsSync(this.promptsDir)) {
      console.log(`[PROMPTS] Directory not found: ${this.promptsDir}`);
      return this.prompts;
    }

    try {
      const files = fs.readdirSync(this.promptsDir);
      const promptFiles = files.filter(file => file.endsWith('.prompt.md'));

      for (const file of promptFiles) {
        const filePath = path.join(this.promptsDir, file);
        try {
          const prompt = await this.parsePromptFile(filePath);
          this.prompts.set(prompt.name, prompt);
          console.log(`[PROMPTS] Loaded: ${prompt.name} (${file})`);
        } catch (err) {
          console.error(`[PROMPTS] Failed to parse ${file}:`, err);
        }
      }

      console.log(`[PROMPTS] Loaded ${this.prompts.size} prompt(s)`);
    } catch (err) {
      console.error('[PROMPTS] Failed to load prompts:', err);
    }

    return this.prompts;
  }

  /**
   * Parse YAML frontmatter from markdown content
   */
  private parseFrontmatter(content: string): { data: Record<string, any>; content: string } {
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
    const match = content.match(frontmatterRegex);

    if (!match) {
      return { data: {}, content };
    }

    const [, yamlContent, markdownContent] = match;
    const data: Record<string, any> = {};

    // Simple YAML parser for basic key-value pairs
    const lines = yamlContent.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const colonIndex = trimmed.indexOf(':');
      if (colonIndex === -1) continue;

      const key = trimmed.substring(0, colonIndex).trim();
      let value = trimmed.substring(colonIndex + 1).trim();

      // Remove quotes if present
      if ((value.startsWith("'") && value.endsWith("'")) || 
          (value.startsWith('"') && value.endsWith('"'))) {
        value = value.substring(1, value.length - 1);
      }

      data[key] = value;
    }

    return { data, content: markdownContent };
  }

  /**
   * Parse a single .prompt.md file
   */
  private async parsePromptFile(filePath: string): Promise<PromptFile> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = this.parseFrontmatter(content);

    // Use frontmatter name if available, otherwise use filename without extension
    const fileName = path.basename(filePath, '.prompt.md');
    const name = (parsed.data.name as string) || fileName;

    return {
      name,
      description: parsed.data.description as string | undefined,
      content: parsed.content.trim(),
      filePath,
      agent: parsed.data.agent as string | undefined,
      model: parsed.data.model as string | undefined,
      tools: parsed.data.tools as string[] | undefined,
      argumentHint: parsed.data['argument-hint'] as string | undefined,
    };
  }

  /**
   * Get a prompt by name
   */
  getPrompt(name: string): PromptFile | undefined {
    return this.prompts.get(name);
  }

  /**
   * Get all loaded prompts
   */
  getAllPrompts(): PromptFile[] {
    return Array.from(this.prompts.values());
  }

  /**
   * Reload prompts (useful for hot-reload)
   */
  async reload(): Promise<void> {
    await this.loadPrompts();
  }
}
