import fs from 'node:fs';
import { parseEnv } from 'node:util';

const defaultsEnvFile = '.env.defaults';
if (fs.existsSync(defaultsEnvFile)) {
  Object.assign(process.env, parseEnv(fs.readFileSync(defaultsEnvFile, 'utf8')));
}

const agent = process.env.AGENT?.trim();
const envFile = agent ? `.env.${agent}` : '.env';
if (fs.existsSync(envFile)) {
  Object.assign(process.env, parseEnv(fs.readFileSync(envFile, 'utf8')));
}
