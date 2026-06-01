/**
 * Simple logger with ISO 8601 timestamp (UTC)
 */
function formatTimestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  log: (...args: unknown[]) => {
    console.log(`[${formatTimestamp()}]`, ...args);
  },
  error: (...args: unknown[]) => {
    console.error(`[${formatTimestamp()}]`, ...args);
  },
  warn: (...args: unknown[]) => {
    console.warn(`[${formatTimestamp()}]`, ...args);
  },
};
