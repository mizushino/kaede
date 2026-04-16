import { CopilotClient } from '@github/copilot-sdk';

export class CopilotClientManager {
  private client: CopilotClient | null = null;
  private clientPromise: Promise<CopilotClient> | null = null;
  private _generation = 0;

  get generation(): number {
    return this._generation;
  }

  async getClient(): Promise<CopilotClient> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const opts: Record<string, unknown> = { logLevel: 'warning' };
        if (process.env.GITHUB_TOKEN) {
          opts.githubToken = process.env.GITHUB_TOKEN;
        } else {
          opts.useLoggedInUser = true;
        }
        const client = new CopilotClient(opts);
        await client.start();
        this.client = client;
        console.log('[CopilotClient] Started');
        return client;
      })();
    }
    return this.clientPromise;
  }

  invalidate(): void {
    this._generation++;
    const oldClient = this.client;
    this.client = null;
    this.clientPromise = null;
    if (oldClient) oldClient.stop().catch(() => {});
  }

  async warmup(): Promise<void> {
    console.log('[CopilotClient] Warming up...');
    try {
      await this.getClient();
    } catch (err) {
      console.log('[CopilotClient] Warmup failed (will retry on first message):', (err as Error).message);
      this.invalidate();
    }
  }

  async shutdown(): Promise<void> {
    if (this.client) {
      const client = this.client;
      this.client = null;
      this.clientPromise = null;
      try {
        await Promise.race([
          client.stop(),
          new Promise(r => setTimeout(r, 3_000)),
        ]);
      } catch (err) {
        console.error('[CopilotClient] Stop error:', err);
      }
    }
  }
}
