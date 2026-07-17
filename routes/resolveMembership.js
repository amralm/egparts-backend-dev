const express = require('express');
const router = express.Router();
const IdentityResolver = require('../services/auth/IdentityResolver');
const ContextBuilder = require('../services/auth/ContextBuilder');
const MembershipResolver = require('../services/auth/MembershipResolver');
const EntitlementsEngine = require('../services/auth/EntitlementsEngine');
const SessionAssembler = require('../services/auth/SessionAssembler');

/**
 * POST /api/auth/resolve-membership
 * Resolves the global identity, extracts store context from the host, 
 * lazily initializes membership, calculates entitlements, and returns the session payload.
 */
router.post('/resolve-membership', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    
    // 1. Resolve Identity
    const identity = await IdentityResolver.resolve(authHeader);
    
    // 2. Resolve Store Context (from Host)
    const store = await ContextBuilder.build(req);
    
    // 3. Resolve Membership
    const membership = await MembershipResolver.resolve(identity.id, store.id, identity);
    
    // 4. Calculate Entitlements
    const entitlements = await EntitlementsEngine.calculate(store, membership);
    
    // 5. Assemble Session Context
    const sessionContext = SessionAssembler.assemble(identity, membership, store, entitlements);
    
    res.json(sessionContext);
    
  } catch (error) {
    console.error('Resolve Membership Error:', error);
    res.status(error.statusCode || 500).json({ error: error.message || 'Internal Server Error' });
  }
});

module.exports = router;
