module.exports = {
  apps: [{
    name: "kaede",
    script: "npx",
    args: "tsx --env-file=.env src/index.ts",
    interpreter: "none",
    watch: false,
    kill_timeout: 10000,
    env: {
      NODE_ENV: "development",
    }
  }]
};
