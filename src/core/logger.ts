/**
 * Simple logger with timestamp
 */
function formatTimestamp(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${ms}`;
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
