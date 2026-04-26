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
  },{
    name: "yotsuba",
    script: "npx",
    args: "tsx --env-file=.env.yotsuba src/index.ts",
    interpreter: "none",
    watch: false,
    kill_timeout: 10000,
    env: {
      NODE_ENV: "development",
    }
  },{
    name: "sakura",
    script: "npx",
    args: "tsx --env-file=.env.sakura src/index.ts",
    interpreter: "none",
    watch: false,
    kill_timeout: 10000,
    env: {
      NODE_ENV: "development",
    }
  }]
};