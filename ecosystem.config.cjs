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
      AGENT: "kaede",
    }
  }]
};
