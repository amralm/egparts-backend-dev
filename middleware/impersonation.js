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
      return res.status(401).json({ error: 'Invalid or expired impersonation session.' });
    }

    if (!session.is_active) {
      return res.status(401).json({ error: 'Impersonation session has expired or ended.' });
    }

    // Optional security: Ensure the person making the request matches the session's admin_id
    // This requires req.user to be set prior by Auth middleware
    if (req.user && req.user.id !== session.admin_id) {
       return res.status(403).json({ error: 'Session belongs to a different admin.' });
    }

    // Override the store context
    // We fetch the store details to inject into req.store
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .select('*')
      .eq('id', session.store_id)
      .single();

    if (storeError || !store) {
      return res.status(404).json({ error: 'Impersonated store not found.' });
    }

    // Overwrite standard context
    req.store = store;
    req.isImpersonated = true;
    req.impersonatorId = session.admin_id;

    next();
  } catch (err) {
    console.error('[ImpersonationMiddleware] Error:', err);
    res.status(500).json({ error: 'Internal server error processing impersonation.' });
  }
};
