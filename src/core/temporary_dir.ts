import path from 'path';

function readEnv(name: string): string {
  return process.env[name]?.trim() || '';
}

function getTemporaryDirScope(): string {
  return readEnv('AGENT_NAME') || 'agent';
}

export function getDefaultTemporaryDir(): string {
  return path.join('.kaede', getTemporaryDirScope(), 'tmp');
}

export function getConfiguredTemporaryDir(): string {
  return readEnv('TEMPORARY_DIR') || getDefaultTemporaryDir();
}
