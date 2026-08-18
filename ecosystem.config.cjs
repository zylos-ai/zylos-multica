const path = require('path');
const os = require('os');

module.exports = {
  apps: [{
    name: 'zylos-multica',
    script: 'src/main.js',
    cwd: path.join(os.homedir(), 'zylos/.claude/skills/multica'),
    env: {
      NODE_ENV: 'production'
    },
    // Restart on failure
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    // Logs managed by PM2
    error_file: path.join(os.homedir(), 'zylos/components/multica/logs/error.log'),
    out_file: path.join(os.homedir(), 'zylos/components/multica/logs/out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss'
  }]
};
