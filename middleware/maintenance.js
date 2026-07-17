const { supabase } = require('../services/supabase');
const tokenVerifier = require('../utils/tokenVerifier');
const logger = require('../utils/logger');

let maintenanceModeCached = null;
let lastMaintenanceCheck = 0;

async function checkMaintenanceMode() {
  const now = Date.now();
  // Cache the settings lookup for 5 seconds to reduce DB query load
  if (maintenanceModeCached !== null && (now - lastMaintenanceCheck) < 5000) {
    return maintenanceModeCached;
  }
  
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'maintenance_mode')
      .maybeSingle();

    if (!error && data) {
      maintenanceModeCached = (data.value === 'true');
    } else {
      maintenanceModeCached = false;
    }
  } catch (e) {
    logger.error('Error checking maintenance mode status:', e.message);
    maintenanceModeCached = false; // Fallback to false on database error to avoid platform lockout
  }
  
  lastMaintenanceCheck = now;
  return maintenanceModeCached;
}

module.exports = async function maintenanceMiddleware(req, res, next) {
  try {
    const path = req.path.toLowerCase();
    
    // 1. Bypass check for health check, platform management, auth endpoints, and blocked IPs page
    if (
      path.startsWith('/health') || path.startsWith('/api/health') ||
      path.startsWith('/platform') || path.startsWith('/api/platform') ||
      path.startsWith('/auth') || path.startsWith('/api/auth') ||
      path.startsWith('/blocked') || path.startsWith('/api/blocked')
    ) {
      return next();
    }

    // 2. Check if maintenance mode is enabled
    const isMaintenance = await checkMaintenanceMode();
    if (!isMaintenance) {
      return next();
    }

    // 3. Allow Super Admins to bypass maintenance checks
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = tokenVerifier.verify(token);
        
        if (decoded && decoded.sub) {
          const { data: superAdmin } = await supabase
            .from('super_admins')
            .select('user_id')
            .eq('user_id', decoded.sub)
            .maybeSingle();

          if (superAdmin) {
            return next(); // Bypassed successfully for Super Admin
          }
        }
      } catch (err) {
        // Ignore token verification errors (treat as guest)
      }
    }

    // 4. Return 503 Service Unavailable for all blocked endpoints
    return res.status(503).json({
      error: 'الموقع تحت الصيانة حالياً. سنعود قريباً.',
      is_maintenance: true
    });
  } catch (err) {
    logger.error('Maintenance middleware error:', err.message);
    next();
  }
};
