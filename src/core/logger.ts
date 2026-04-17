/**
 * Simple logger with ISO 8601 timestamp (UTC)
 */
function formatTimestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  log: (...args: any[]) => {
    console.log(`[${formatTimestamp()}]`, ...args);
  },
  error: (...args: any[]) => {
    console.error(`[${formatTimestamp()}]`, ...args);
  },
  warn: (...args: any[]) => {
    console.warn(`[${formatTimestamp()}]`, ...args);
  },
};
