// Mock dependencies before importing routes/middlewares
jest.mock('../../services/supabase', () => ({
  supabase: {
    from: jest.fn()
  }
}));

jest.mock('../../utils/tokenVerifier', () => ({
  verify: jest.fn()
}));

jest.mock('../../services/subscriptionLimitService', () => ({
  reserveFeatureUsage: jest.fn(),
  commitFeatureUsage: jest.fn(),
  rollbackFeatureUsage: jest.fn()
}));

jest.mock('../../services/otpService', () => ({
  sendOTP: jest.fn(),
  verifyOTP: jest.fn()
}));

jest.mock('../../services/whatsappService', () => ({
  getStatus: jest.fn().mockReturnValue('connected'),
  initialize: jest.fn().mockResolvedValue(true)
}));

jest.mock('express-rate-limit', () => {
  return jest.fn(() => (req, res, next) => next());
});

const request = require('supertest');
const express = require('express');
const { verifyPlatformAdmin, verifyPlatformPermission } = require('../../middleware/platformAdmin');
const authRouter = require('../../routes/auth');
const { supabase } = require('../../services/supabase');
const tokenVerifier = require('../../utils/tokenVerifier');
const subscriptionLimitService = require('../../services/subscriptionLimitService');

// Create test apps
const middlewareApp = express();
const permissionApp = express();
middlewareApp.use(express.json());
permissionApp.use(express.json());

// Set up env and fetch mocks for Turnstile verification
beforeAll(() => {
  process.env.TURNSTILE_SECRET_KEY = 'mock_secret_key';
  global.fetch = jest.fn().mockImplementation(() =>
    Promise.resolve({
      json: () => Promise.resolve({ success: true })
    })
  );
});


// Routes for testing platformAdmin middleware
middlewareApp.get('/admin-only', verifyPlatformAdmin, (req, res) => {
  res.json({ success: true, user: req.user });
});

permissionApp.get('/permission-only', verifyPlatformPermission('platform.write'), (req, res) => {
  res.json({ success: true });
});

const authApp = express();
authApp.use(express.json());
authApp.use((req, res, next) => {
  req.store = { id: 'store-123' };
  next();
});
authApp.use('/auth', authRouter);

describe('Security: Platform Admin Middleware', () => {
  let mockMaybeSingle;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMaybeSingle = jest.fn();
    supabase.from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: mockMaybeSingle,
      is: jest.fn().mockReturnThis()
    });
  });

  it('should fail-closed if no token is provided', async () => {
    const res = await request(middlewareApp).get('/admin-only');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Unauthorized');
  });

  it('should fail-closed if token verifier throws', async () => {
    tokenVerifier.verify.mockImplementationOnce(() => {
      throw new Error('JWT verify failed');
    });
    const res = await request(middlewareApp)
      .get('/admin-only')
      .set('Authorization', 'Bearer invalidtoken');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Unauthorized');
  });

  it('should fail-closed if user is not in super_admins table', async () => {
    tokenVerifier.verify.mockReturnValueOnce({ sub: 'user-123' });
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await request(middlewareApp)
      .get('/admin-only')
      .set('Authorization', 'Bearer validtoken');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden');
  });

  it('should fail-closed if database check fails with error', async () => {
    tokenVerifier.verify.mockReturnValueOnce({ sub: 'user-123' });
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: new Error('Database connection lost') });

    const res = await request(middlewareApp)
      .get('/admin-only')
      .set('Authorization', 'Bearer validtoken');
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Internal Server Error');
  });

  it('should pass-through if user is super admin', async () => {
    tokenVerifier.verify.mockReturnValueOnce({ sub: 'user-123' });
    mockMaybeSingle.mockResolvedValueOnce({ data: { user_id: 'user-123' }, error: null });

    const res = await request(middlewareApp)
      .get('/admin-only')
      .set('Authorization', 'Bearer validtoken');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Security: verifyPlatformPermission Middleware', () => {
  let mockMaybeSingle;
  let mockSelect;
  let mockEq;
  let mockIs;

  beforeEach(() => {
    jest.clearAllMocks();
    mockMaybeSingle = jest.fn();
    mockSelect = jest.fn();
    mockEq = jest.fn();
    mockIs = jest.fn();

    // Mock for loadPlatformUser check (the first supabase call inside verifyPlatformPermission via loadPlatformUser)
    // and mock for the roles checks.
    supabase.from.mockImplementation((table) => {
      if (table === 'super_admins') {
        return {
          select: jest.fn().mockReturnThis(),
          eq: jest.fn().mockReturnThis(),
          maybeSingle: mockMaybeSingle
        };
      }
      if (table === 'roles') {
        return {
          select: mockSelect
        };
      }
      return {};
    });

    mockSelect.mockReturnValue({
      eq: mockEq
    });
    mockEq.mockReturnValue({
      eq: mockEq,
      is: mockIs
    });
    mockIs.mockReturnValue({
      // roles query resolved value
      then: jest.fn()
    });
  });

  it('should fail-closed if the database lookup fails with an error', async () => {
    // 1. Mock loadPlatformUser to succeed (super admin exists)
    tokenVerifier.verify.mockReturnValueOnce({ sub: 'admin-user' });
    mockMaybeSingle.mockResolvedValueOnce({ data: { user_id: 'admin-user' }, error: null });

    // 2. Mock roles lookup to return error
    mockIs.mockResolvedValueOnce({ data: null, error: new Error('Roles table scan failure') });

    const res = await request(permissionApp)
      .get('/permission-only')
      .set('Authorization', 'Bearer validtoken');

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Unable to verify permissions');
  });

  it('should fail-closed if roles configurations are empty (no roles found)', async () => {
    tokenVerifier.verify.mockReturnValueOnce({ sub: 'admin-user' });
    mockMaybeSingle.mockResolvedValueOnce({ data: { user_id: 'admin-user' }, error: null });

    // Return empty roles array
    mockIs.mockResolvedValueOnce({ data: [], error: null });

    const res = await request(permissionApp)
      .get('/permission-only')
      .set('Authorization', 'Bearer validtoken');

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden: Insufficient permissions');
  });

  it('should fail-closed if roles configurations are empty (roles is null)', async () => {
    tokenVerifier.verify.mockReturnValueOnce({ sub: 'admin-user' });
    mockMaybeSingle.mockResolvedValueOnce({ data: { user_id: 'admin-user' }, error: null });

    // Return null data for roles
    mockIs.mockResolvedValueOnce({ data: null, error: null });

    const res = await request(permissionApp)
      .get('/permission-only')
      .set('Authorization', 'Bearer validtoken');

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden: Insufficient permissions');
  });

  it('should fail-closed if user does not have the required permission', async () => {
    tokenVerifier.verify.mockReturnValueOnce({ sub: 'admin-user' });
    mockMaybeSingle.mockResolvedValueOnce({ data: { user_id: 'admin-user' }, error: null });

    // Return role but with a different permission
    mockIs.mockResolvedValueOnce({
      data: [{
        id: 'role-1',
        role_permissions: [
          {
            permissions: {
              name: 'platform.read',
              is_deprecated: false
            }
          }
        ]
      }],
      error: null
    });

    const res = await request(permissionApp)
      .get('/permission-only')
      .set('Authorization', 'Bearer validtoken');

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden: Insufficient permissions');
  });

  it('should fail-closed if the required permission is deprecated', async () => {
    tokenVerifier.verify.mockReturnValueOnce({ sub: 'admin-user' });
    mockMaybeSingle.mockResolvedValueOnce({ data: { user_id: 'admin-user' }, error: null });

    // Return role with the correct name but is_deprecated = true
    mockIs.mockResolvedValueOnce({
      data: [{
        id: 'role-1',
        role_permissions: [
          {
            permissions: {
              name: 'platform.write',
              is_deprecated: true
            }
          }
        ]
      }],
      error: null
    });

    const res = await request(permissionApp)
      .get('/permission-only')
      .set('Authorization', 'Bearer validtoken');

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden: Insufficient permissions');
  });

  it('should allow access if user is super admin with the required non-deprecated permission', async () => {
    tokenVerifier.verify.mockReturnValueOnce({ sub: 'admin-user' });
    mockMaybeSingle.mockResolvedValueOnce({ data: { user_id: 'admin-user' }, error: null });

    // Return role with matching permission
    mockIs.mockResolvedValueOnce({
      data: [{
        id: 'role-1',
        role_permissions: [
          {
            permissions: {
              name: 'platform.write',
              is_deprecated: false
            }
          }
        ]
      }],
      error: null
    });

    const res = await request(permissionApp)
      .get('/permission-only')
      .set('Authorization', 'Bearer validtoken');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('Security: Quota Reservation Fail-Closed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    supabase.from.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null })
    });
  });

  it('should block send-otp if quota limit is exceeded', async () => {
    subscriptionLimitService.reserveFeatureUsage.mockResolvedValueOnce(false);

    const res = await request(authApp)
      .post('/auth/send-otp')
      .send({ phone: '+1234567890', turnstileToken: 'token' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_LIMIT_EXCEEDED');
  });

  it('should fail-closed if quota reservation throws error', async () => {
    subscriptionLimitService.reserveFeatureUsage.mockRejectedValueOnce(new Error('Redis connection failed'));

    const res = await request(authApp)
      .post('/auth/send-otp')
      .send({ phone: '+1234567890', turnstileToken: 'token' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('Unable to verify quota limits');
  });
});
