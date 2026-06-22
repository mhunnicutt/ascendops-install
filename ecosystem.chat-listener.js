// Google Chat Pub/Sub listener — separate from auto-generated ecosystem.config.js
// Runs chat-listener.js every minute via PM2 cron_restart.
module.exports = {
  apps: [
    {
      name: 'chat-listener',
      script: 'C:\\Users\\mhunnicutt_foothills\\ascendops-install\\scripts\\chat-listener.js',
      cwd: 'C:\\Users\\mhunnicutt_foothills\\ascendops-install',
      cron_restart: '* * * * *',
      autorestart: false,
      watch: false,
      env: {
        CTX_INSTANCE_ID: process.env.CTX_INSTANCE_ID || 'default',
        CTX_ROOT: process.env.CTX_ROOT || 'C:\\Users\\mhunnicutt_foothills\\.cortextos\\default',
        CTX_FRAMEWORK_ROOT: 'C:\\Users\\mhunnicutt_foothills\\ascendops-install',
        CTX_PROJECT_ROOT: 'C:\\Users\\mhunnicutt_foothills\\ascendops-install',
        CTX_ORG: process.env.CTX_ORG || 'foothills-pm',
        CTX_AGENT_NAME: 'anna',
      },
    },
  ],
};
