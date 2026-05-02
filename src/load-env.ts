import fs from 'node:fs';
import { parseEnv } from 'node:util';

// Load env file with override semantics so PM2 / shell env can't leak
// stale values (e.g. DISCORD_BOT_TOKEN) from a previous AGENT into this
// process when restarting with --update-env.
const agent = process.env.AGENT?.trim();
const envFile = agent ? `.env.${agent}` : '.env';

if (fs.existsSync(envFile)) {
  Object.assign(process.env, parseEnv(fs.readFileSync(envFile, 'utf8')));
}
