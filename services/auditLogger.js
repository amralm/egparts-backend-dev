const { supabase } = require('./supabase');
const logger = require('../utils/logger');

async function logAudit({
  correlationId,
  storeId,
  userId,
  action,
  entityType,
  entityId,
  oldValues = {},
  newValues = {},
  ipAddress,
  userAgent,
  durationMs
}) {
  try {
    const { error } = await supabase
      .from('audit_logs')
      .insert({
        correlation_id: correlationId,
        store_id: storeId,
        user_id: userId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        old_values: oldValues,
        new_values: newValues,
        ip_address: ipAddress,
        user_agent: userAgent,
        duration_ms: durationMs
      });
    if (error) {
      logger.error('Failed to write audit log to database:', error.message);
    }
  } catch (err) {
    logger.error('Failed to write audit log:', err.message);
  }
}

/**
 * Express middleware to automatically log audit details for mutating actions.
 * Extracts details and tracks execution duration.
 */
function auditMiddleware(action, entityType) {
  return async (req, res, next) => {
    const startTime = Date.now();
    const originalJson = res.json;
    let logged = false;

    res.json = function (body) {
      res.json = originalJson;
      const durationMs = Date.now() - startTime;
      
      if (!logged) {
        logged = true;
        // Run audit in background asynchronously
        logAudit({
          correlationId: req.correlationId || null,
          storeId: req.store?.id || null,
          userId: req.user?.sub || null,
          action: `${action}_${res.statusCode >= 400 ? 'failed' : 'success'}`,
          entityType,
          entityId: req.params?.id || req.body?.id || 'none',
          oldValues: {},
          newValues: req.method === 'GET' ? {} : (req.body || {}),
          ipAddress: req.ip || req.socket?.remoteAddress || '',
          userAgent: req.headers['user-agent'] || '',
          durationMs
        }).catch(err => logger.error('Audit logger middleware err:', err));
      }

      return originalJson.apply(this, arguments);
    };

    next();
  };
}

module.exports = { logAudit, auditMiddleware };
