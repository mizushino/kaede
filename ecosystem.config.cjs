const fs = require('fs');
const path = require('path');

let envFile = '.env';
try {
  const currentEnv = fs.readFileSync(path.join(__dirname, '.current-env'), 'utf8').trim();
  if (currentEnv) envFile = currentEnv;
} catch {}

module.exports = {
  apps: [{
    name: "kaede",
    script: "npx",
    args: `tsx --env-file=${envFile} src/index.ts`,
    interpreter: "none",
    watch: false,
    kill_timeout: 10000,
    env: {
      NODE_ENV: "development",
    }
  }]
};
