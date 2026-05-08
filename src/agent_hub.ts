import './load-env.js';
import { AgentHubBot } from './discord/agent_hub_bot.js';
import { logger } from './core/logger.js';
import { killAllAcpChildren } from './providers/index.js';

const bot = new AgentHubBot();
bot.start().catch(logger.error);

// Graceful shutdown
let shuttingDown = false;
const onShutdown = async (signal?: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (signal) logger.log(`[AGENT HUB] Received ${signal}`);

  // Force exit if graceful shutdown hangs
  const forceTimer = setTimeout(() => {
    logger.error('[AGENT HUB] Forced exit after timeout');
    killAllAcpChildren();
    process.kill(process.pid, 'SIGKILL');
  }, 8_000);
  forceTimer.unref();

  await bot.shutdown();
  process.exit(0);
};

process.on('SIGTERM', () => onShutdown('SIGTERM'));
process.on('SIGINT', () => onShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('[AGENT HUB] Uncaught exception:', err);
  onShutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  logger.error('[AGENT HUB] Unhandled rejection:', err);
  onShutdown('unhandledRejection');
});
