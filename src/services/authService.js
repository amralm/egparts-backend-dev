import { supabase } from '../lib/supabase';

/**
 * Ensures a user profile exists in user_profiles table.
 * Does NOT overwrite existing data if the profile already exists.
 * @param {object} user - The Supabase user object from session
 */
export const syncUserProfile = async (user, storeId) => {
  if (!user) return null;
  const targetStoreId = storeId || '00000000-0000-0000-0000-000000000000';

  try {
    // 1. Check if profile exists for this user and store
    const { data: profile, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', user.id)
      .eq('store_id', targetStoreId)
      .maybeSingle();

    if (!profile) {
      // 2. Profile missing -> Create initial defaults scoped to this store
      const { data: newProfile, error: insertError } = await supabase
        .from('user_profiles')
        .insert({
          user_id: user.id,
          store_id: targetStoreId,
          full_name: user.user_metadata?.full_name || user.user_metadata?.name || '',
          email: user.email,
          phone: user.user_metadata?.phone || '',
          role: 'user',
          is_email_verified: user.app_metadata?.provider === 'google' || user.email_confirmed_at ? true : false,
          created_at: new Date().toISOString()
        })
        .select()
        .single();

      if (insertError) throw insertError;
      return newProfile;
    }

    return profile;
  } catch (err) {
    console.error('Error in syncUserProfile:', err);
    return null;
  }
};
