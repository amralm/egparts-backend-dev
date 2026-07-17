const supabase = require('../supabase');

class MembershipResolver {
  /**
   * Resolves or lazily initializes the Membership (user_profiles) for the store.
   * @param {string} identityId - The global identity UUID
   * @param {string} storeId - The store UUID
   * @param {Object} identityMeta - The identity object to grab defaults (name, phone)
   * @returns {Promise<Object>} The Membership object (user_profiles + roles)
   */
  async resolve(identityId, storeId, identityMeta) {
    if (!identityId || !storeId) {
      throw new Error('identityId and storeId are required to resolve membership');
    }

    // 1. Attempt to fetch existing membership
    const { data: existingProfile, error: profileErr } = await supabase
      .from('user_profiles')
      .select('id, user_id, store_id, full_name, email, phone, created_at')
      .eq('user_id', identityId)
      .eq('store_id', storeId)
      .maybeSingle();

    if (profileErr) {
      throw new Error(`Failed to fetch membership: ${profileErr.message}`);
    }

    if (existingProfile) {
      // Fetch roles
      const { data: roles } = await supabase
        .from('user_roles')
        .select('role_id, store_roles(name, code)')
        .eq('user_id', identityId)
        .eq('store_id', storeId);

      return {
        profile: existingProfile,
        roles: roles || []
      };
    }

    // 2. Lazily Initialize Membership if it doesn't exist
    // Extract name from identity metadata if available
    let fullName = null;
    if (identityMeta && identityMeta.raw_user_meta_data) {
      fullName = identityMeta.raw_user_meta_data.full_name || identityMeta.raw_user_meta_data.name;
    }

    const { data: newProfile, error: insertErr } = await supabase
      .from('user_profiles')
      .insert({
        user_id: identityId,
        store_id: storeId,
        phone: identityMeta.phone || null,
        email: identityMeta.email || null,
        full_name: fullName,
      })
      .select('id, user_id, store_id, full_name, email, phone, created_at')
      .single();

    if (insertErr) {
      // Handle edge case where it was inserted concurrently
      if (insertErr.code === '23505') { // Unique violation
        return this.resolve(identityId, storeId, identityMeta);
      }
      throw new Error(`Failed to initialize membership: ${insertErr.message}`);
    }

    // 3. Assign Default Role (Customer)
    // Find the 'Customer' role ID for this store
    const { data: customerRole } = await supabase
      .from('store_roles')
      .select('id, name, code')
      .eq('store_id', storeId)
      .eq('code', 'customer')
      .maybeSingle();

    let assignedRoles = [];
    if (customerRole) {
      await supabase
        .from('user_roles')
        .insert({
          user_id: identityId,
          store_id: storeId,
          role_id: customerRole.id
        });
        
      assignedRoles.push({
        role_id: customerRole.id,
        store_roles: { name: customerRole.name, code: customerRole.code }
      });
    }

    return {
      profile: newProfile,
      roles: assignedRoles
    };
  }
}

module.exports = new MembershipResolver();
