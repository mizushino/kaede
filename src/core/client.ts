import type { CopilotClient } from '@github/copilot-sdk';
import { loadOptionalSdk } from './optional_sdk.js';
import { logger } from './logger.js';

type CopilotSdkModule = typeof import('@github/copilot-sdk');

export class CopilotClientManager {
  private client: CopilotClient | null = null;
  private clientPromise: Promise<CopilotClient> | null = null;
  private _generation = 0;
  private shuttingDown = false;

  get generation(): number {
    return this._generation;
  }

  async getClient(): Promise<CopilotClient> {
    if (this.shuttingDown) {
      throw new Error('CopilotClientManager is shutting down');
    }
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const sdk = await loadOptionalSdk<CopilotSdkModule>('@github/copilot-sdk');
        const opts: Record<string, unknown> = { logLevel: 'warning' };
        const isByok = !!process.env.COPILOT_PROVIDER_BASE_URL;
        if (process.env.GITHUB_TOKEN) {
          opts.gitHubToken = process.env.GITHUB_TOKEN;
        } else if (!isByok) {
          opts.useLoggedInUser = true;
        }
        // Copilot CLI 1.0.36+ requires COPILOT_MODEL at CLI startup when BYOK is
        // active, even though we also pass `model` per session. Backfill from
        // AGENT_MODEL unconditionally so the CLI (and any sub-agents it spawns)
        // sees the model we configured.
        if (!process.env.COPILOT_MODEL && process.env.AGENT_MODEL) {
          process.env.COPILOT_MODEL = process.env.AGENT_MODEL;
        }
        const client = new sdk.CopilotClient(opts);
        await client.start();
        if (this.shuttingDown) {
          await client.stop().catch(() => {});
          throw new Error('CopilotClientManager is shutting down');
        }
        this.client = client;
        if (isByok) {
          logger.log(`[CopilotClient] Started (BYOK: ${process.env.COPILOT_PROVIDER_TYPE})`);
        } else {
          logger.log('[CopilotClient] Started');
        }
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
    logger.log('[CopilotClient] Warming up...');
    try {
      await this.getClient();
    } catch (err) {
      logger.log('[CopilotClient] Warmup failed (will retry on first message):', (err as Error).message);
      this.invalidate();
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const pending = this.clientPromise;
    this.clientPromise = null;

    let client: CopilotClient | null = null;
    if (pending) {
      client = await pending.catch(() => null);
    }
    // Check if a new client was created after we cleared clientPromise
    if (!client) {
      client = this.client;
      this.client = null;
    }
    if (!client) return;

    try {
      await Promise.race([
        client.stop(),
        new Promise(r => setTimeout(r, 3_000)),
      ]);
    } catch (err) {
      logger.error('[CopilotClient] Stop error:', err);
    }
  }
}
