import { DiscordBot } from './discord/bot.js';
import { logger } from './core/logger.js';

const bot = new DiscordBot();
bot.start().catch(logger.error);

// Graceful shutdown
let shuttingDown = false;
const onShutdown = async (signal?: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  if (signal) logger.log(`[BOT] Received ${signal}`);

  // Force exit if graceful shutdown hangs
  const forceTimer = setTimeout(() => {
    logger.error('[BOT] Forced exit after timeout');
    process.kill(process.pid, 'SIGKILL');
  }, 8_000);
  forceTimer.unref();

  await bot.shutdown();
  process.exit(0);
};

process.on('SIGTERM', () => onShutdown('SIGTERM'));
process.on('SIGINT', () => onShutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.error('[BOT] Uncaught exception:', err);
  onShutdown('uncaughtException');
});
process.on('unhandledRejection', (err) => {
  logger.error('[BOT] Unhandled rejection:', err);
  onShutdown('unhandledRejection');
});
