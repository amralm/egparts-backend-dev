const jwt = require('jsonwebtoken');

class SupabaseTokenVerifier {
  constructor() {
    this.secret = process.env.SUPABASE_JWT_SECRET;
    if (!this.secret) {
      throw new Error('❌ SUPABASE_JWT_SECRET is missing from environment variables');
    }
  }

  verify(token) {
    return jwt.verify(token, this.secret);
  }
}

module.exports = new SupabaseTokenVerifier();
