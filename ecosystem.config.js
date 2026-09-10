'use strict';
/**
 * ============================================================================
 *  ecosystem.config.js — pm2 process definition (Phase 0(g))
 * ============================================================================
 *   pm2 start ecosystem.config.js --env production
 *   pm2 reload spread-backend        # zero-downtime after a deploy
 *   pm2 logs spread-backend
 *   pm2 save && pm2 startup          # survive a host reboot
 *
 * ─── ONE INSTANCE. THIS IS LOAD-BEARING, NOT A DEFAULT ──────────────────────
 *
 * This process holds STATE IN MEMORY that must exist exactly once:
 *   · the SPR-28 stats scheduler (jobs/schedule.js) — clustering would fire the
 *     13:45 stats + fee-reconcile slot N times, reconciling the day's fees N
 *     times.
 *   · the halt-resume session map, the entry-window map, and the row-poller
 *     cursors (socket.js) — a second copy would re-fire halts and re-emit rows.
 * So exec_mode is 'fork' and instances is 1. Do NOT switch to cluster mode to
 * "use more cores": the funnel is I/O-bound on Postgres, and a second scheduler
 * is a correctness bug, not a speed-up.
 *
 * kill_timeout (8s) is deliberately LONGER than the app's own 5s graceful-
 * shutdown deadline (src/index.js), so pm2's SIGINT lets the pool drain and the
 * sockets close before SIGKILL — a shutdown mid-query is what this avoids.
 * The uncaughtException / server 'error' handlers exit(1); autorestart brings
 * the process back clean, which is the pairing Phase 0(c) is built around.
 * ============================================================================
 */
module.exports = {
  apps: [
    {
      name: 'spread-backend',
      script: 'src/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      // A crash loop should back off, not hammer. 10 restarts inside min_uptime
      // and pm2 stops trying and leaves it stopped-errored (visible), rather than
      // spinning forever on a bad config.
      min_uptime: '20s',
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: '512M',
      kill_timeout: 8000,
      // The app logs structured JSON to stdout already; let pm2 timestamp the
      // capture so `pm2 logs` lines are ordered even across a restart.
      time: true,
      env: {
        NODE_ENV: 'development',
      },
      env_production: {
        NODE_ENV: 'production',
        // These are REQUIRED in production (assertProductionConfig refuses to
        // boot without the first two); set them in the environment or a pm2
        // deploy secret, never committed here:
        //   DATABASE_URL, SPREAD_API_TOKEN, CORS_ORIGIN,
        //   SCRAPER_INGEST_URL, ANTHROPIC_MODEL, TRUST_PROXY
      },
    },
  ],
};
