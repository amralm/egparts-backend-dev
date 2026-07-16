const jwt = require('jsonwebtoken');

const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

if (!SUPABASE_JWT_SECRET) {
  console.error('❌ SUPABASE_JWT_SECRET is missing from environment variables');
}

/**
 * Verify Supabase JWT Token
 * The decoded token contains:
 *   sub      → user ID (UUID)
 *   email    → user email
 *   role     → "authenticated" for regular users
 *   app_metadata.role → "admin" for admins (set manually in Supabase)
 *   user_metadata → name, phone, etc.
 */
const verifyUser = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, SUPABASE_JWT_SECRET);
    req.user = decoded; // decoded.sub = userId, decoded.email, decoded.app_metadata.role
    next();
  } catch (error) {
    console.error('JWT Verification Error:', error.message);
    return res.status(401).json({ error: 'Unauthorized: Invalid or expired token' });
  }
};

/**
 * Admin check — role must be set in Supabase app_metadata
 * Run in Supabase SQL Editor to set admin role:
 *   UPDATE auth.users
 *   SET raw_app_meta_data = raw_app_meta_data || '{"role": "admin"}'
 *   WHERE id = 'your-admin-user-id';
 */
const verifyAdmin = (req, res, next) => {
  verifyUser(req, res, () => {
    const role = req.user?.app_metadata?.role;
    if (role === 'admin') {
      next();
    } else {
      return res.status(403).json({ error: 'Forbidden: Admin access required' });
    }
  });
};

/**
 * Optional Auth — allows Guest Checkout
 * If token is present and valid → req.user = decoded
 * If no token or invalid → req.user = null (guest)
 * Use for endpoints that work for both logged-in and guest users
 */
const optionalAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    req.user = null;
    return next();
  }

  try {
    const token = authHeader.split(' ')[1];
    req.user = jwt.verify(token, SUPABASE_JWT_SECRET);
  } catch {
    req.user = null; // Invalid token = treat as guest
  }

  next();
};

module.exports = { verifyUser, verifyAdmin, optionalAuth };
