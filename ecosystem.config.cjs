const fs = require('fs');
const path = require('path');

let agent = '';
try {
  const content = fs.readFileSync(path.join(__dirname, '.current-env'), 'utf8').trim();
  agent = content;
} catch {}

module.exports = {
  apps: [{
    name: "kaede",
    script: "npm",
    args: "start",
    interpreter: "none",
    watch: false,
    kill_timeout: 10000,
    env: {
      NODE_ENV: "development",
      AGENT: agent,
    }
  }]
};
