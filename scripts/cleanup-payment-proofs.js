'use strict';

// Render Cron Job entrypoint. Configure it to run every 15 minutes with the
// same environment variables as the backend Web Service.
require('dotenv').config();

const { runProofRetentionCleanup } = require('../services/proofRetentionJob');

runProofRetentionCleanup()
  .then((result) => {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    process.exitCode = 0;
  })
  .catch((error) => {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 1;
  });
