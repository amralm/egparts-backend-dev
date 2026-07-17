const { supabase } = require('./supabase');
const logger = require('../utils/logger');

// Run cleanup every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Periodically deletes expired reservations from the database to ensure
 * abandoned or crashed operations do not permanently consume quotas.
 */
async function cleanupStaleReservations() {
  try {
    const { data, error } = await supabase
      .from('feature_reservations')
      .delete()
      .lt('expires_at', new Date().toISOString())
      .select('id');

    if (error) {
      logger.error('Failed to cleanup stale reservations:', error.message);
    } else if (data && data.length > 0) {
      logger.info(`Cleaned up ${data.length} stale feature reservations.`);
    }
  } catch (err) {
    logger.error('Error during stale reservation cleanup:', err);
  }
}

/**
 * Starts the periodic cleanup job.
 */
function startCleanupJob() {
  // Run once immediately on startup
  cleanupStaleReservations();
  
  // Schedule periodic executions
  setInterval(cleanupStaleReservations, CLEANUP_INTERVAL_MS);
  logger.info('Stale reservation cleanup job scheduled.');
}

module.exports = {
  startCleanupJob,
  cleanupStaleReservations
};
