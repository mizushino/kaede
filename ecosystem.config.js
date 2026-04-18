module.exports = {
  apps: [{
    name: "kaede",
    script: "npx",
    args: "tsx --env-file=.env src/index.ts",
    interpreter: "none",
    watch: false,
    env: {
      NODE_ENV: "development",
    }
  }]
};