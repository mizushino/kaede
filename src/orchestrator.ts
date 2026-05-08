import './load-env.js';
import { OrchestratorBot } from './discord/orchestrator_bot.js';
import { logger } from './core/logger.js';
import { killAllAcpChildren } from './providers/index.js';

const bot = new OrchestratorBot();
bot.start().catch(logger.error);

// Graceful shutdown
let shuttingDown = false;
const onShutdown = async (signal?: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (signal) logger.log(`[ORCHESTRATOR] Received ${signal}`);

  // Force exit if graceful shutdown hangs
  const forceTimer = setTimeout(() => {
    logger.error('[ORCHESTRATOR] Forced exit after timeout');
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
  logger.error('[ORCHESTRATOR] Uncaught exception:', err);
  onShutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  logger.error('[ORCHESTRATOR] Unhandled rejection:', err);
  onShutdown('unhandledRejection');
});
