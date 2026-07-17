const supabase = require('../supabase');

class IdentityResolver {
  /**
   * Resolves the global identity from a provided JWT token.
   * @param {string} token - The Bearer token
   * @returns {Promise<Object>} The Identity object (auth.users)
   */
  async resolve(token) {
    if (!token) {
      const err = new Error('No authorization token provided');
      err.statusCode = 401;
      throw err;
    }

    const cleanToken = token.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(cleanToken);

    if (error || !user) {
      const err = new Error('Invalid or expired token');
      err.statusCode = 401;
      throw err;
    }

    // Identify is the global `auth.users` record
    return {
      id: user.id,
      phone: user.phone,
      email: user.email,
      metadata: user.app_metadata,
      raw_user_meta_data: user.user_metadata,
    };
  }
}

module.exports = new IdentityResolver();
