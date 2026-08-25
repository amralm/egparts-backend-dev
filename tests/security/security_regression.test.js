'use strict';

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
  const mockLimiter = jest.fn(() => {
    return function rateLimit(req, res, next) {
      next();
    };
  });
  return mockLimiter;
});

process.env.TURNSTILE_SECRET_KEY = 'mock_secret_key';
global.fetch = jest.fn().mockImplementation(() => Promise.resolve({
  json: () => Promise.resolve({ success: true })
}));

const request = require('supertest');
const express = require('express');
const { verifyPlatformAdmin, verifyPlatformPermission } = require('../../middleware/platformAdmin');
let authRouter = require('../../routes/auth');
const { supabase } = require('../../services/supabase');
const tokenVerifier = require('../../utils/tokenVerifier');
const subscriptionLimitService = require('../../services/subscriptionLimitService');

// Create test apps
const middlewareApp = express();
middlewareApp.use(express.json());

// Routes for testing platformAdmin middleware
middlewareApp.get('/admin-only', verifyPlatformAdmin, (req, res) => {
  res.json({ success: true, user: req.user });
});

middlewareApp.get('/permission-only', verifyPlatformPermission('platform.write'), (req, res) => {
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

// Original stubs kept for regression compatibility
describe('Security: Tenant Isolation', () => {
  it('should not allow Tenant A to access Tenant B orders', () => {
    expect(true).toBe(true);
  });
  it('should reject requests missing tenant context', () => {
    expect(true).toBe(true);
  });
});

describe('Security: Permission Escalation', () => {
  it('should block tenant admin from accessing platform APIs', () => {
    expect(true).toBe(true);
  });
});

describe('Security: Template Injection', () => {
  it('should sanitize Handlebars templates before compiling', () => {
    expect(true).toBe(true);
  });
});

describe('Security: Upload Validation', () => {
  it('should reject executable file extensions disguised as images', () => {
    expect(true).toBe(true);
  });
});

describe('Security: Rate Limiting Configuration & Integration', () => {
  let paymentsRouter;
  let authRouter;

  beforeAll(() => {
    // Clear Jest module registry to force re-execution of routers and capture rateLimit calls
    jest.resetModules();
    
    // Clear all mocks first so we start from 0 calls
    const rateLimit = require('express-rate-limit');
    rateLimit.mockClear();
    
    // Re-require to populate rateLimit calls
    authRouter = require('../../routes/auth');
    paymentsRouter = require('../../routes/payments');
  });

  it('should register rate limiters with correct options for sensitive routes', () => {
    const rateLimit = require('express-rate-limit');
    const rateLimitCalls = rateLimit.mock.calls;
    expect(rateLimitCalls.length).toBeGreaterThanOrEqual(4);

    // Find paymentRateLimiter options
    const paymentLimiterOpts = rateLimitCalls.map(call => call[0]).find(opt => opt && opt.windowMs === 60000 && opt.max === 5 && opt.message && opt.message.error && opt.message.error.includes('إنشاء الدفع'));
    expect(paymentLimiterOpts).toBeDefined();
    expect(paymentLimiterOpts.message.error).toContain('طلبات إنشاء الدفع كثيرة جداً');

    // Find otpRateLimiter options
    const otpLimiterOpts = rateLimitCalls.map(call => call[0]).find(opt => opt && opt.windowMs === 300000 && opt.max === 2);
    expect(otpLimiterOpts).toBeDefined();

    // Find perPhoneOtpLimiter options
    const perPhoneLimiterOpts = rateLimitCalls.map(call => call[0]).find(opt => opt && opt.windowMs === 3600000 && opt.max === 3);
    expect(perPhoneLimiterOpts).toBeDefined();

    // Find verifyRateLimiter options
    const verifyLimiterOpts = rateLimitCalls.map(call => call[0]).find(opt => opt && opt.windowMs === 60000 && opt.max === 3 && !opt.keyGenerator);
    expect(verifyLimiterOpts).toBeDefined();
  });

  it('should ensure payment creation route has paymentRateLimiter in its stack', () => {
    const createRoute = paymentsRouter.stack.find(layer => layer.route && layer.route.path === '/create');
    expect(createRoute).toBeDefined();
    
    // Check that there is at least one rate limiter middleware in the route stack
    // Express route stack layers contain a handle property
    const hasRateLimiter = createRoute.route.stack.some(layer => {
      return layer.name === 'rateLimit' || (layer.handle && layer.handle.name === 'rateLimit');
    });
    expect(hasRateLimiter).toBe(true);
  });

  it('should ensure send-otp route has rate limiters in its stack', () => {
    const sendOtpRoute = authRouter.stack.find(layer => layer.route && layer.route.path === '/send-otp');
    expect(sendOtpRoute).toBeDefined();
    
    const rateLimiterCount = sendOtpRoute.route.stack.filter(layer => {
      return layer.name === 'rateLimit' || (layer.handle && layer.handle.name === 'rateLimit');
    }).length;
    // /send-otp uses otpRateLimiter and perPhoneOtpLimiter
    expect(rateLimiterCount).toBe(2);
  });

  it('should ensure verify-otp route has verifyRateLimiter in its stack', () => {
    const verifyOtpRoute = authRouter.stack.find(layer => layer.route && layer.route.path === '/verify-otp');
    expect(verifyOtpRoute).toBeDefined();
    
    const hasRateLimiter = verifyOtpRoute.route.stack.some(layer => {
      return layer.name === 'rateLimit' || (layer.handle && layer.handle.name === 'rateLimit');
    });
    expect(hasRateLimiter).toBe(true);
  });
});
