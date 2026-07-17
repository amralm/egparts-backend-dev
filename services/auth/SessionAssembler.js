const crypto = require('crypto');
const { resolveStorePermissions } = require('../../middleware/auth');

class SessionAssembler {
  /**
   * Assembles the final session context payload to return to the client.
   *
   * @param {Object} identity     - The global identity (auth.users)
   * @param {Object} membership   - The store membership and roles (user_profiles + user_roles)
   * @param {Object} store        - The store context
   * @param {Object} entitlements - The calculated entitlements (plan limits/features)
   * @returns {Promise<Object>}   The complete session context payload
   */
  async assemble(identity, membership, store, entitlements) {
    const sessionId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();

    // Map roles to a simple array of role codes for the frontend
    const roles = (membership.roles || [])
      .map((r) => r.store_roles?.code)
      .filter(Boolean);

    // ✅ Resolve real permissions from the Membership layer.
    // Previously this was always []. Now we fetch actual granted permissions
    // for this user in this store so the frontend can gate UI correctly.
    let permissions = [];
    try {
      if (identity.id && store.id) {
        permissions = await resolveStorePermissions(identity.id, store.id);
      }
    } catch (err) {
      // Non-fatal: log and continue with empty permissions (fail-safe, not fail-open)
      console.error('[SessionAssembler] Failed to resolve permissions:', err.message);
    }

    return {
      session: {
        identity: {
          id: identity.id,
          phone: identity.phone,
          email: identity.email,
          fullName: identity.raw_user_meta_data?.full_name || identity.raw_user_meta_data?.name,
        },
        membership: {
          id: membership.profile.id,
          fullName: membership.profile.full_name,
          createdAt: membership.profile.created_at,
        },
      },
      authorization: {
        roles,
        permissions, // ✅ Now populated with real permission names
      },
      entitlements,
      metadata: {
        session_id: sessionId,
        correlation_id: correlationId,
        request_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
      },
    };
  }
}

module.exports = new SessionAssembler();
