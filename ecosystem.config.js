// PM2 production config
module.exports = {
  apps: [{
    name:               'meet-commerce-api',
    script:             './src/server.js',
    instances:          2,
    exec_mode:          'cluster',
    max_memory_restart: '1500M',
    node_args:          '--max-old-space-size=1400',
    env_production: {
      NODE_ENV: 'production',
      PORT:     3000,
    },
    error_file:      './logs/err.log',
    out_file:        './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    restart_delay:   1000,
    max_restarts:    10,
    kill_timeout:    5000,
    listen_timeout:  10000,
    wait_ready:      true,
  }]
}
