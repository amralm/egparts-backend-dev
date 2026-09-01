'use strict';

// Master Render Cron Job entrypoint.
// Runs every 15 minutes to execute all database retention policies,
// delete expired media from Cloudflare R2, and keep storage bloat at 0.
require('dotenv').config();

const { runMasterRetentionCleanup } = require('../services/retentionService');

runMasterRetentionCleanup()
  .then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    process.exitCode = 0;
  })
  .catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
