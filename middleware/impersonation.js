const { apiError } = require('../utils/apiError');
const { supabase } = require('../services/supabase');

module.exports = async function impersonationMiddleware(req, res, next) {
  try {
    const sessionToken = req.headers['x-impersonate-session'];
    
    if (!sessionToken) {
      return next(); // Proceed normally
    }

    // Verify session
    const { data: session, error } = await supabase
      .from('impersonation_sessions')
      .select('store_id, admin_id, is_active')
      .eq('session_token', sessionToken)
      .single();

    if (error || !session) {
      return apiError(res, 401, 'Invalid or expired impersonation session.', `HTTP_401`);
    }

    if (!session.is_active) {
      return apiError(res, 401, 'Impersonation session has expired or ended.', `HTTP_401`);
    }

    // Optional security: Ensure the person making the request matches the session's admin_id
    // This requires req.user to be set prior by Auth middleware
    if (!req.user?.sub || req.user.sub !== session.admin_id) {
       return apiError(res, 403, 'Session belongs to a different admin.', `HTTP_403`);
    }

    // Override the store context
    // We fetch the store details to inject into req.store
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('*')
      .eq('id', session.store_id)
      .single();

    if (storeError || !store) {
      return apiError(res, 404, 'Impersonated store not found.', `HTTP_404`);
    }

    // Overwrite standard context
    req.store = store;
    req.isImpersonated = true;
    req.impersonatorId = session.admin_id;

    next();
  } catch (err) {
    console.error('[ImpersonationMiddleware] Error:', err);
    apiError(res, 500, 'Internal server error processing impersonation.', `HTTP_500`);
  }
};
