class TenantContext {
    /**
     * @param {Object} params
     * @param {string} params.userId - The authenticated user's ID
     * @param {string} params.storeId - The store being accessed
     * @param {string} params.membershipId - The membership record ID connecting user to store
     * @param {string} params.role - The user's role in this store (e.g. 'owner', 'manager')
     * @param {Array<string>} params.permissions - The explicit permissions granted to this membership
     */
    constructor({ userId, storeId, membershipId, role, permissions = [] }) {
        if (!userId) throw new Error('TenantContext requires a userId');
        if (!storeId) throw new Error('TenantContext requires a storeId');

        this.userId = userId;
        this.storeId = storeId;
        this.membershipId = membershipId;
        this.role = role;
        this.permissions = permissions;
    }

    hasPermission(permission) {
        // Super admins or owners might bypass explicit permission checks depending on policy
        if (this.role === 'super_admin' || this.role === 'owner') return true;
        return this.permissions.includes(permission);
    }
}

module.exports = TenantContext;
