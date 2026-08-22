const { apiError } = require('../utils/apiError');
const { sendSuccess } = require('../utils/apiResponse');
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { S3Client, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { supabase } = require('../services/supabase');
const { verifyPlatformAdmin, verifyPlatformPermission } = require('../middleware/platformAdmin');
const logger = require('../utils/logger');
const { z } = require('zod');
const { validateBody, validateParams } = require('../middleware/requestValidation');
const { managerInviteCreateSchema, invitationIdParamSchema } = require('../schemas/platformSchemas');
const { sanitizeIlikeTerm } = require('../utils/postgrest');
const subscriptionLimitService = require('../services/subscriptionLimitService');
const whatsappPoolService = require('../services/whatsappPoolService');

const SUPPORTED_PLAN_FEATURE_KEYS = new Set([
  'products', 'categories', 'brands', 'product_images', 'product_variants', 'attributes',
  'branches', 'warehouses', 'shelves', 'employees', 'roles', 'customers', 'suppliers',
  'orders', 'orders_per_month', 'active_orders', 'coupons', 'discount_campaigns', 'return_requests',
  'storage_bytes', 'uploaded_images', 'uploaded_files', 'uploads', 'banner_images', 'logos',
  'whatsapp_enabled', 'whatsapp_accounts_max', 'whatsapp_messages_month', 'whatsapp_concurrency',
  'otp_messages_month', 'email_messages_month', 'push_notifications_month', 'custom_domains',
  'api_keys', 'webhooks', 'integrations', 'payment_gateways', 'ai_requests_month', 'forecast_jobs',
  'report_generation', 'analytics_exports', 'api_requests_day', 'export_formats', 'copilot_messages_day',
  'staff_users', 'r2_storage', 'platform_billing', 'whatsapp_notifications', 'custom_domain',
  'whatsapp_customer_notifications'
]);
const FEATURE_KEY_ALIASES = {
  staff_users: 'employees',
  custom_domain: 'custom_domains',
  whatsapp_notifications: 'whatsapp_enabled'
};

const planPayloadSchema = z.object({
  code: z.string().trim().min(1).max(80).regex(/^[a-z0-9_-]+$/i),
  display_name: z.string().trim().min(1).max(160),
  price_monthly: z.number().finite().min(0).max(1_000_000).optional().default(0),
  price_yearly: z.number().finite().min(0).max(10_000_000).optional().default(0),
  trial_days: z.number().int().min(0).max(365).optional().default(0),
  trial_enabled: z.boolean().optional().default(false),
  sort_order: z.number().int().min(0).max(10000).optional().default(0),
  features: z.array(z.object({
    key: z.string().trim().min(1).max(100).regex(/^[a-z0-9_]+$/i),
    display_name: z.string().trim().max(160).optional().default(''),
    limits: z.array(z.object({
      limit_type: z.enum(['count', 'boolean', 'unlimited', 'disabled', 'storage', 'amount', 'export_formats']),
      limit_config: z.record(z.string(), z.any()).default({})
    }).strict()).max(8).optional().default([])
  }).strict()).max(200).optional().default([])
}).strict();

const platformSettingsSchema = z.object({
  settings: z.record(
    z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/),
    z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])
  ).refine((value) => Object.keys(value).length <= 100, 'Too many settings in one request')
}).strict();

const smtpTestSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535).default(587),
  secure: z.union([z.boolean(), z.string().regex(/^(true|false)$/i)]).default(false),
  user: z.string().trim().min(1).max(320),
  pass: z.string().min(1).max(1024),
  recipient: z.string().trim().email().max(320)
}).strict();

const platformStoreCreateSchema = z.object({
  name: z.string().trim().min(1).max(160),
  subdomain: z.string().trim().min(1).max(63).regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i),
  custom_domain: z.string().trim().max(253).nullable().optional(),
  subscription_expires_at: z.string().datetime({ offset: true }),
  is_active: z.boolean().optional().default(true),
  plan_id: z.string().uuid().nullable().optional()
}).strict();

const platformStoreUpdateSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  custom_domain: z.string().trim().max(253).nullable().optional(),
  subscription_expires_at: z.string().datetime({ offset: true }).optional(),
  is_active: z.boolean().optional(),
  plan_id: z.string().uuid().nullable().optional(),
  status: z.string().trim().min(1).max(40).optional()
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one store field is required');

const proofRetentionSchema = z.object({
  retention_days: z.union([z.number().int().min(0).max(3650), z.string().regex(/^\\d+$/).transform(Number), z.null()])
}).strict();
const { encryptCredentials, decryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');
const { sanitizeThemeOverrides } = require('../services/themeSettingsService');
const { tenantCache } = require('../utils/cache');

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function emptyS3Directory(bucket, dir) {
  const listParams = { Bucket: bucket, Prefix: dir };
  let listedObjects;
  let deletedCount = 0;
  let deletedBytes = 0;
  do {
    listedObjects = await s3Client.send(new ListObjectsV2Command(listParams));
    if (listedObjects.Contents?.length > 0) {
      const deleteParams = { Bucket: bucket, Delete: { Objects: [] } };
      listedObjects.Contents.forEach(({ Key, Size = 0 }) => {
        deleteParams.Delete.Objects.push({ Key });
        deletedCount += 1;
        deletedBytes += Number(Size) || 0;
      });
      await s3Client.send(new DeleteObjectsCommand(deleteParams));
    }
    listParams.ContinuationToken = listedObjects.NextContinuationToken;
  } while (listedObjects.IsTruncated);
  return { deletedCount, deletedBytes };
}

async function listS3Objects(bucket, prefix) {
  const objects = [];
  let continuationToken;
  do {
    const result = await s3Client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken
    }));
    for (const object of result.Contents || []) {
      objects.push({
        key: object.Key,
        size: Number(object.Size) || 0,
        lastModified: object.LastModified || null
      });
    }
    continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

function buildStorageTree(objects, prefix) {
  const folders = new Map();
  const files = [];
  for (const object of objects) {
    const relative = object.key.slice(prefix.length);
    const parts = relative.split('/').filter(Boolean);
    if (parts.length <= 1) {
      files.push(object);
      continue;
    }
    const folder = parts[0];
    const current = folders.get(folder) || { name: folder, prefix: `${prefix}${folder}/`, files: 0, bytes: 0 };
    current.files += 1;
    current.bytes += object.size;
    folders.set(folder, current);
  }
  return { folders: [...folders.values()].sort((a, b) => a.name.localeCompare(b.name)), files };
}

router.use(verifyPlatformPermission('platform.access'));

function normalizeThemePayload(body = {}) {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 120) : '';
  if (!name) {
    const error = new Error('Theme name is required.');
    error.statusCode = 400;
    throw error;
  }
  const lightTokens = sanitizeThemeOverrides(body.light_tokens);
  const darkTokens = sanitizeThemeOverrides(body.dark_tokens);
  if (Object.keys(lightTokens).length === 0 || Object.keys(darkTokens).length === 0) {
    const error = new Error('Light and dark theme tokens are required.');
    error.statusCode = 400;
    throw error;
  }
  return {
    name,
    name_en: typeof body.name_en === 'string' ? body.name_en.trim().slice(0, 120) || null : null,
    description: typeof body.description === 'string' ? body.description.trim().slice(0, 500) || null : null,
    is_published: Boolean(body.is_published),
    sort_order: Number.isInteger(Number(body.sort_order)) ? Number(body.sort_order) : 0,
    light_tokens: lightTokens,
    dark_tokens: darkTokens
  };
}

// Theme administration. These explicit endpoints match the platform UI and
// keep all writes behind the verified platform context above.
router.get('/themes/all', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('platform_themes')
      .select('*')
      .order('sort_order', { ascending: true });
    if (error) throw error;
    sendSuccess(res, { items: data || [] });
  } catch (err) {
    logger.error('Platform themes load failed:', err.message);
    apiError(res, 500, 'Unable to load platform themes.', `HTTP_500`);
  }
});

router.post('/themes', async (req, res) => {
  try {
    const payload = normalizeThemePayload(req.body);
    const { data, error } = await supabase.from('platform_themes').insert(payload).select().single();
    if (error) throw error;
    await auditPlatform(req, 'platform.themes.create', 'platform_theme', data.id, {}, data);
    sendSuccess(res, { item: data }, { status: 201 });
  } catch (err) {
    logger.error('Platform theme create failed:', err.message);
    apiError(res, err.statusCode || 500, err.statusCode ? err.message : 'Unable to create platform theme.', 'PLATFORM_THEME_CREATE_FAILED');
  }
});

router.put('/themes/:id', async (req, res) => {
  try {
    const payload = normalizeThemePayload(req.body);
    const { data: before, error: beforeError } = await supabase.from('platform_themes').select('*').eq('id', req.params.id).maybeSingle();
    if (beforeError) throw beforeError;
    if (!before) return apiError(res, 404, 'Theme not found.', `HTTP_404`);
    const { data, error } = await supabase.from('platform_themes').update(payload).eq('id', req.params.id).select().single();
    if (error) throw error;
    await auditPlatform(req, 'platform.themes.update', 'platform_theme', data.id, before, data);
    sendSuccess(res, { item: data });
  } catch (err) {
    logger.error('Platform theme update failed:', err.message);
    apiError(res, err.statusCode || 500, err.statusCode ? err.message : 'Unable to update platform theme.', 'PLATFORM_THEME_UPDATE_FAILED');
  }
});

router.post('/themes/:id/toggle-publish', async (req, res) => {
  try {
    const { data: before, error: beforeError } = await supabase.from('platform_themes').select('*').eq('id', req.params.id).maybeSingle();
    if (beforeError) throw beforeError;
    if (!before) return apiError(res, 404, 'Theme not found.', `HTTP_404`);
    const { data, error } = await supabase.from('platform_themes').update({ is_published: !before.is_published }).eq('id', req.params.id).select().single();
    if (error) throw error;
    await auditPlatform(req, 'platform.themes.publish', 'platform_theme', data.id, before, data);
    sendSuccess(res, { item: data });
  } catch (err) {
    logger.error('Platform theme publish toggle failed:', err.message);
    apiError(res, 500, 'Unable to update platform theme.', `HTTP_500`);
  }
});

router.delete('/themes/:id', async (req, res) => {
  try {
    const { data: before, error: beforeError } = await supabase.from('platform_themes').select('*').eq('id', req.params.id).maybeSingle();
    if (beforeError) throw beforeError;
    if (!before) return apiError(res, 404, 'Theme not found.', `HTTP_404`);
    const { error } = await supabase.from('platform_themes').delete().eq('id', req.params.id);
    if (error) throw error;
    await auditPlatform(req, 'platform.themes.delete', 'platform_theme', req.params.id, before, {});
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Platform theme delete failed:', err.message);
    apiError(res, 500, 'Unable to delete platform theme.', `HTTP_500`);
  }
});

const IMPERSONATION_TTL_SECONDS = 60 * 60;

function canonicalDomain() {
  return process.env.PRIMARY_DOMAIN || 'egparts.store';
}

function normalizeDomain(domain) {
  return (domain || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');
}

async function auditPlatform(req, action, entityType, entityId, oldValues = {}, newValues = {}, storeId = null) {
  try {
    await supabase.from('audit_logs').insert([{
      correlation_id: req.correlationId || crypto.randomUUID(),
      store_id: storeId,
      user_id: req.user?.sub || null,
      action,
      entity_type: entityType,
      entity_id: entityId || 'none',
      old_values: oldValues,
      new_values: newValues,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'] || null
    }]);
  } catch (err) {
    logger.warn(`Platform audit failed for ${action}: ${err.message}`);
  }
}

async function ensureOwnerTemplateRole() {
  const { data: existing, error: existingError } = await supabase
    .from('roles')
    .select('id')
    .eq('name', 'owner')
    .eq('role_type', 'tenant_template')
    .is('store_id', null)
    .limit(1)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing) return existing.id;

  const { data: role, error } = await supabase
    .from('roles')
    .upsert({
      store_id: null,
      name: 'owner',
      display_name: 'Owner',
      priority: 1,
      system_role: true,
      editable: false,
      role_type: 'tenant_template',
      description: 'Tenant owner with full store administration permissions'
    }, { onConflict: 'store_id,name' })
    .select('id')
    .single();

  if (error) throw error;
  return role.id;
}

async function getDefaultPlanId() {
  const { data: freePlan } = await supabase
    .from('plans')
    .select('id')
    .eq('code', 'free')
    .maybeSingle();
  if (freePlan?.id) return freePlan.id;

  const { data: firstPlan } = await supabase
    .from('plans')
    .select('id')
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle();
  return firstPlan?.id || null;
}

const platformResourceTables = {
  feature_flags: 'feature_flags',
  apps: 'platform_apps',
  themes: 'platform_themes',
  role_templates: 'platform_role_templates',
  suspensions: 'platform_suspensions'
};

router.get('/resources/:resource', verifyPlatformAdmin, async (req, res) => {
  const table = platformResourceTables[req.params.resource];
  if (!table) return apiError(res, 404, 'Unknown platform resource', `HTTP_404`);

  try {
    let query = supabase.from(table).select('*').order('created_at', { ascending: false });
    if (req.params.resource === 'suspensions') {
      query = supabase.from(table).select('*, store:stores(name)').order('created_at', { ascending: false });
    }
    const { data, error } = await query;
    if (error) throw error;
    sendSuccess(res, { items: data || [] });
  } catch (err) {
    logger.error(`Platform resource load failed (${req.params.resource}):`, err.message);
    apiError(res, 500, 'Unable to load platform resource', `HTTP_500`);
  }
});

router.post('/resources/:resource', verifyPlatformAdmin, async (req, res) => {
  // This was an untyped generic write endpoint. It accepted arbitrary client
  // keys and forwarded them directly to Supabase, which made it a legacy
  // contract and a schema-drift/privilege risk. No frontend consumer exists;
  // resource administration must use the typed endpoints below/alongside the
  // dedicated platform pages.
  return apiError(res, 410, 'This legacy resource endpoint is disabled. Use the typed platform resource API.', 'LEGACY_RESOURCE_ENDPOINT_DISABLED');
});

router.patch('/resources/:resource/:id', verifyPlatformAdmin, async (req, res) => {
  return apiError(res, 410, 'This legacy resource endpoint is disabled. Use the typed platform resource API.', 'LEGACY_RESOURCE_ENDPOINT_DISABLED');
});

router.delete('/resources/:resource/:id', verifyPlatformAdmin, async (req, res) => {
  const table = platformResourceTables[req.params.resource];
  if (!table) return apiError(res, 404, 'Unknown platform resource', `HTTP_404`);

  try {
    const { data: oldData } = await supabase.from(table).select('*').eq('id', req.params.id).maybeSingle();
    const { error } = await supabase.from(table).delete().eq('id', req.params.id);
    if (error) throw error;
    await auditPlatform(req, `platform.${req.params.resource}.delete`, req.params.resource, req.params.id, oldData);
    sendSuccess(res, {});
  } catch (err) {
    logger.error(`Platform resource delete failed (${req.params.resource}):`, err.message);
    apiError(res, 500, 'Unable to delete platform resource', `HTTP_500`);
  }
});

router.get('/orders/:orderId/customer-address', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .select('id, store_id, user_id')
      .eq('id', req.params.orderId)
      .maybeSingle();

    if (orderError) throw orderError;
    if (!order) return apiError(res, 404, 'Order not found', `HTTP_404`);
    if (!order.user_id) return sendSuccess(res, { address: null });

    let { data, error } = await supabase
      .from('user_addresses')
      .select('title, phone, city, address, is_default')
      .eq('store_id', order.store_id)
      .eq('user_id', order.user_id)
      .eq('is_default', true)
      .limit(1);

    if (error) throw error;

    if (!data || data.length === 0) {
      const fallback = await supabase
        .from('user_addresses')
        .select('title, phone, city, address, is_default')
        .eq('store_id', order.store_id)
        .eq('user_id', order.user_id)
        .order('created_at', { ascending: false })
        .limit(1);
      if (fallback.error) throw fallback.error;
      data = fallback.data;
    }

    sendSuccess(res, { address: data?.[0] || null });
  } catch (err) {
    logger.error(`Platform order address load failed (${req.params.orderId}):`, err.message);
    apiError(res, 500, 'Unable to load customer address', `HTTP_500`);
  }
});

// 1. GET /api/platform/settings - Retrieve global settings
router.get('/settings', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('system_settings').select('*');
    if (error) throw error;
    
    // Map to a key-value object
    const settings = {};
    if (data) {
      data.forEach(item => {
        settings[item.key] = item.value;
      });
    }
    sendSuccess(res, settings);
  } catch (err) {
    logger.error('Failed to get system settings:', err.message);
    apiError(res, 500, 'Failed to retrieve system settings', `HTTP_500`);
  }
});

// 2. POST /api/platform/settings - Update global settings
router.post('/settings', verifyPlatformAdmin, validateBody(platformSettingsSchema), async (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return apiError(res, 400, 'settings object is required', `HTTP_400`);
  }

  if (settings.payment_proof_retention_default_days !== undefined) {
    const retentionDays = Number(settings.payment_proof_retention_default_days);
    if (!Number.isInteger(retentionDays) || retentionDays < 0 || retentionDays > 3650) {
      return apiError(res, 400, 'payment_proof_retention_default_days must be an integer between 0 and 3650', `HTTP_400`);
    }
  }

  try {
    const requestedKeys = Object.keys(settings);
    const { data: previousRows, error: previousError } = await supabase
      .from('system_settings')
      .select('key, value')
      .in('key', requestedKeys);
    if (previousError) throw previousError;
    const previous = Object.fromEntries((previousRows || []).map(row => [row.key, row.value]));

    const upserts = Object.keys(settings).map(key => ({
      key,
      value: settings[key] === null ? '' : String(settings[key]),
      updated_at: new Date().toISOString()
    }));

    const { error } = await supabase.from('system_settings').upsert(upserts, { onConflict: 'key' });
    if (error) throw error;

    await auditPlatform(req, 'platform.settings.update', 'system_setting', 'global', previous, settings, null);

    if (settings.dev_mode_enabled !== undefined) {
      const isDev = settings.dev_mode_enabled === 'true' || settings.dev_mode_enabled === true;
      global.DEV_MODE_ENABLED = isDev;
      logger.level = isDev ? 'debug' : 'info';

      // Cloudflare Bot Automation (Environment Option)
      if (process.env.CLOUDFLARE_ZONE_ID && process.env.CLOUDFLARE_API_TOKEN) {
        try {
          const zone = process.env.CLOUDFLARE_ZONE_ID;
          const token = process.env.CLOUDFLARE_API_TOKEN;
          const botStatus = !isDev; // Off when dev mode is on
          const secLevel = isDev ? 'essentially_off' : 'medium'; // essentially_off when dev mode is on

          // Toggle Bot Fight Mode
          fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/bot_management`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ fight_mode: botStatus })
          }).catch(err => logger.error('Cloudflare Bot API error:', err));

          // Toggle WAF Security Level
          fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/settings/security_level`, {
            method: 'PATCH',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: secLevel })
          }).catch(err => logger.error('Cloudflare Security Level API error:', err));

          logger.info(`Requested Cloudflare automation: Bot Fight Mode -> ${botStatus}, Security Level -> ${secLevel}`);
        } catch (e) {
          logger.error('Failed to trigger Cloudflare API automation:', e.message);
        }
      }
    }

    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to update system settings:', err.message);
    apiError(res, 500, 'Failed to update settings', `HTTP_500`);
  }
});

// Payment-proof retention controls. The platform default lives in
// system_settings; this endpoint manages an explicit per-store exception.
router.get('/stores/:id/proof-retention', verifyPlatformAdmin, async (req, res) => {
  try {
    const [{ data: store, error: storeError }, { data: setting, error: settingError }, { data: globalSetting, error: globalError }] = await Promise.all([
      supabase.from('stores').select('id, name').eq('id', req.params.id).maybeSingle(),
      supabase.from('site_settings').select('proof_retention_days').eq('store_id', req.params.id).maybeSingle(),
      supabase.from('system_settings').select('value').eq('key', 'payment_proof_retention_default_days').maybeSingle(),
    ]);
    if (storeError || settingError || globalError) throw storeError || settingError || globalError;
    if (!store) return apiError(res, 404, 'Store not found', `HTTP_404`);

    const override = setting?.proof_retention_days;
    const defaultDays = Number.isInteger(Number(globalSetting?.value)) ? Number(globalSetting.value) : 30;
    sendSuccess(res, {
      store: { id: store.id, name: store.name },
      default_days: defaultDays,
      override_days: override === null || override === undefined ? null : Number(override),
      effective_days: override === null || override === undefined ? defaultDays : Number(override),
      source: override === null || override === undefined ? 'platform_default' : 'store_override',
    });
  } catch (err) {
    logger.error('Failed to load store proof retention:', err.message);
    apiError(res, 500, 'Failed to load proof retention settings', `HTTP_500`);
  }
});

router.patch('/stores/:id/proof-retention', verifyPlatformAdmin, validateBody(proofRetentionSchema), async (req, res) => {
  const value = req.body?.retention_days;
  const clearOverride = value === null || value === undefined || value === '';
  const days = clearOverride ? null : Number(value);
  if (!clearOverride && (!Number.isInteger(days) || days < 0 || days > 3650)) {
    return apiError(res, 400, 'retention_days must be an integer between 0 and 3650, or null to use the platform default', `HTTP_400`);
  }

  try {
    const { data: store } = await supabase.from('stores').select('id, name').eq('id', req.params.id).maybeSingle();
    if (!store) return apiError(res, 404, 'Store not found', `HTTP_404`);
    const { data: before } = await supabase.from('site_settings').select('proof_retention_days').eq('store_id', store.id).maybeSingle();
    const { error } = await supabase.from('site_settings').upsert({
      store_id: store.id,
      proof_retention_days: days,
    }, { onConflict: 'store_id' });
    if (error) throw error;

    await auditPlatform(req, 'platform.store.proof_retention.update', 'store_settings', store.id,
      { proof_retention_days: before?.proof_retention_days ?? null },
      { proof_retention_days: days }, store.id);
    sendSuccess(res, { store_id: store.id, override_days: days });
  } catch (err) {
    logger.error('Failed to update store proof retention:', err.message);
    apiError(res, 500, 'Failed to update store proof retention', `HTTP_500`);
  }
});

router.get('/payment-proofs/retention-health', verifyPlatformAdmin, async (req, res) => {
  try {
    const now = new Date().toISOString();
    const statuses = ['active', 'deletion_pending', 'deletion_failed', 'deleted'];
    const counts = {};
    for (const status of statuses) {
      const { count, error } = await supabase
        .from('payment_proof_retention')
        .select('id', { count: 'exact', head: true })
        .eq('status', status);
      if (error) throw error;
      counts[status] = count || 0;
    }
    const { count: overdue, error: overdueError } = await supabase
      .from('payment_proof_retention')
      .select('id', { count: 'exact', head: true })
      .in('status', ['active', 'deletion_pending', 'deletion_failed'])
      .lte('expires_at', now);
    if (overdueError) throw overdueError;

    sendSuccess(res, { checked_at: now,
      counts,
      overdue: overdue || 0,
      scheduler: 'external_render_cron_required', });
  } catch (err) {
    logger.error('Failed to load payment proof retention health:', err.message);
    apiError(res, 500, 'Failed to load payment proof retention health', `HTTP_500`);
  }
});

// 2.5. POST /api/platform/settings/test-smtp - Test SMTP configuration
router.post('/settings/test-smtp', verifyPlatformAdmin, validateBody(smtpTestSchema), async (req, res) => {
  try {
    const { host, port, secure, user, pass, recipient } = req.body;
    if (!host || !user || !pass || !recipient) {
      return apiError(res, 400, 'Missing required SMTP parameters', `HTTP_400`);
    }
    
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host,
      port: port || 587,
      secure: secure === true || secure === 'true',
      auth: {
        user,
        pass
      }
    });

    await transporter.sendMail({
      from: user,
      to: recipient,
      subject: 'EGParts SMTP Test',
      text: 'This is a test email from the EGParts platform to verify SMTP settings.',
    });

    sendSuccess(res, { message: 'Test email sent successfully' });
  } catch (err) {
    logger.error('Failed to send test email:', err.message);
    apiError(res, 500, 'Failed to send test email: ' + err.message, 'TEST_EMAIL_FAILED');
  }
});

// 3. GET /api/platform/plans - Retrieve plans, features, and limits
router.get('/plans', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data: plans, error: planErr } = await supabase
      .from('plans')
      .select(`
        *,
        plan_features (
          id,
          features (
            id,
            key,
            display_name
          ),
          feature_limits (
            id,
            limit_type,
            limit_config
          )
        )
      `)
      .order('sort_order', { ascending: true });

    if (planErr) throw planErr;
    sendSuccess(res, plans);
  } catch (err) {
    logger.error('Failed to retrieve plans:', err.message);
    apiError(res, 500, 'Failed to retrieve plans', `HTTP_500`);
  }
});

// 4. POST /api/platform/plans - Create or update subscription plan and limits
router.post('/plans', verifyPlatformAdmin, validateBody(planPayloadSchema), async (req, res) => {
  const { code, display_name, price_monthly, price_yearly, trial_days, trial_enabled, sort_order, features } = req.body;
  const unsupportedFeature = (features || []).find((feature) => !SUPPORTED_PLAN_FEATURE_KEYS.has(feature.key.toLowerCase()));
  if (unsupportedFeature) return apiError(res, 400, `Unsupported plan feature: ${unsupportedFeature.key}`, `HTTP_400`);
  const normalizedFeatures = (features || []).reduce((items, feature) => {
    const key = FEATURE_KEY_ALIASES[feature.key.toLowerCase()] || feature.key.toLowerCase();
    if (!items.some((item) => item.key === key)) items.push({ ...feature, key });
    return items;
  }, []);

  // Validate every limit before touching the plan. Previously one hidden or
  // unsupported feature could make the request fail after earlier limits had
  // already been deleted. -1 is the only allowed negative value and means
  // unlimited.
  for (const feature of normalizedFeatures) {
    for (const limit of feature.limits || []) {
      if (!Object.prototype.hasOwnProperty.call(limit.limit_config || {}, 'max_value')) continue;
      const value = Number(limit.limit_config.max_value);
      if (!Number.isInteger(value) || (value < 0 && value !== -1)) {
        return apiError(res, 400, `Invalid limit for feature ${feature.key}`, 'INVALID_FEATURE_LIMIT');
      }
      limit.limit_config.max_value = value;
    }
  }

  try {
    const { data: plan, error: planErr } = await supabase
      .from('plans')
      .upsert({
        code,
        display_name,
        price_monthly: price_monthly || 0,
        price_yearly: price_yearly || 0,
        trial_days: trial_days || 0,
        trial_enabled: !!trial_enabled,
        sort_order: sort_order || 0
      }, { onConflict: 'code' })
      .select()
      .single();

    if (planErr) throw planErr;

    if (normalizedFeatures.length > 0) {
      for (const feat of normalizedFeatures) {
        const { data: dbFeat, error: featErr } = await supabase
          .from('features')
          .upsert({ key: feat.key, display_name: feat.display_name }, { onConflict: 'key' })
          .select()
          .single();

        if (featErr) throw featErr;

        const { data: planFeat, error: mappingErr } = await supabase
          .from('plan_features')
          .upsert({ plan_id: plan.id, feature_id: dbFeat.id }, { onConflict: 'plan_id,feature_id' })
          .select()
          .single();

        if (mappingErr) throw mappingErr;

        // Replace limits only after the complete request passed schema validation.
        const { error: delErr } = await supabase.from('feature_limits').delete().eq('plan_feature_id', planFeat.id);
        if (delErr) throw delErr;

        if (feat.limits && Array.isArray(feat.limits)) {
          for (const lim of feat.limits) {
            const config = { ...(lim.limit_config || {}) };
            if (Object.prototype.hasOwnProperty.call(config, 'max_value')) {
              const value = Number(config.max_value);
              if (!Number.isInteger(value) || (value < 0 && value !== -1)) {
                throw new Error(`Invalid limit for feature ${feat.key}`);
              }
              config.max_value = value;
            }
            const { error: limitErr } = await supabase
              .from('feature_limits')
              .upsert({
                plan_feature_id: planFeat.id,
                limit_type: lim.limit_type,
                limit_config: config
              }, { onConflict: 'plan_feature_id,limit_type' });

            if (limitErr) throw limitErr;
          }
        }
      }
    }

    await auditPlatform(req, 'platform.plan.update', 'plan', plan.id, null, { code, display_name, features }, null);
    await subscriptionLimitService.clearStoreCache(null);

    sendSuccess(res, { plan });
  } catch (err) {
    logger.error('Failed to save SaaS plan:', err);
    apiError(res, 500, 'Failed to save plan', `HTTP_500`);
  }
});

// 5. POST /api/platform/stores/subscription - Update specific store plan
router.get('/stores', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data: stores, error } = await supabase
      .from('stores')
      .select(`
        id, name, subdomain, custom_domain, is_active, status, subscription_expires_at, created_at, updated_at,
        store_subscriptions (
          plan_id,
          status
        )
      `)
      .order('name', { ascending: true });

    if (error) throw error;

    const formatted = (stores || []).map(s => ({
      ...s,
      plan_id: s.store_subscriptions?.plan_id || null,
      subscription_status: s.store_subscriptions?.status || null
    }));

    sendSuccess(res, formatted);
  } catch (err) {
    logger.error('Failed to retrieve platform stores:', err.message);
    apiError(res, 500, 'Failed to retrieve stores', `HTTP_500`);
  }
});

router.post('/stores', verifyPlatformAdmin, validateBody(platformStoreCreateSchema), async (req, res) => {
  const { name, subdomain, custom_domain, subscription_expires_at, is_active = true, plan_id } = req.body;
  const cleanSubdomain = (subdomain || '').trim().toLowerCase();
  const cleanDomain = normalizeDomain(custom_domain);

  if (!name?.trim() || !cleanSubdomain || !subscription_expires_at) {
    return apiError(res, 400, 'name, subdomain, and subscription_expires_at are required', `HTTP_400`);
  }

  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(cleanSubdomain)) {
    return apiError(res, 400, 'Invalid subdomain format', `HTTP_400`);
  }

  try {
    const { data: existingStore } = await supabase
      .from('stores')
      .select('id')
      .eq('subdomain', cleanSubdomain)
      .maybeSingle();

    if (existingStore) {
      return apiError(res, 409, 'Subdomain is already assigned to another store', `HTTP_409`);
    }

    if (cleanDomain) {
      const { data: existingDomain } = await supabase
        .from('custom_domains')
        .select('id, store_id')
        .eq('domain', cleanDomain)
        .maybeSingle();

      if (existingDomain) {
        return apiError(res, 409, 'Custom domain is already assigned to another tenant', `HTTP_409`);
      }
    }

    const expiryIso = new Date(subscription_expires_at).toISOString();
    const { data: store, error: storeError } = await supabase
      .from('stores')
      .insert([{
        name: name.trim(),
        subdomain: cleanSubdomain,
        custom_domain: cleanDomain || null,
        subscription_expires_at: expiryIso,
        is_active: !!is_active,
        status: is_active ? 'active' : 'suspended'
      }])
      .select()
      .single();

    if (storeError) throw storeError;

    const settingsPayload = {
      store_id: store.id,
      brand_name: name.trim(),
      store_description: 'واجهة احترافية لعرض المنتجات والخدمات وإدارة الطلبات بسهولة.',
      theme_colors: {
        primary: '#dc2626',
        primary_hover: '#b91c1c',
        primary_foreground: '#ffffff',
        secondary: '#1e293b',
        secondary_foreground: '#f8fafc'
      }
    };

    const { error: settingsError } = await supabase
      .from('site_settings')
      .upsert(settingsPayload, { onConflict: 'store_id' });

    if (settingsError) throw settingsError;

    const targetPlanId = (plan_id && plan_id !== 'null' && plan_id !== '') ? plan_id : await getDefaultPlanId();
    if (targetPlanId) {
      const { error: subscriptionError } = await supabase
        .from('store_subscriptions')
        .upsert({
          store_id: store.id,
          plan_id: targetPlanId,
          status: is_active ? 'active' : 'suspended',
          expires_at: expiryIso,
          updated_at: new Date().toISOString()
        }, { onConflict: 'store_id' });

      if (subscriptionError) throw subscriptionError;
    }

    if (cleanDomain) {
      const verificationToken = crypto.randomBytes(16).toString('hex');
      const { error: domainError } = await supabase
        .from('custom_domains')
        .insert([{
          store_id: store.id,
          domain: cleanDomain,
          is_primary: true,
          status: 'pending_verification',
          verification_token: verificationToken
        }]);

      if (domainError) throw domainError;
    }

    await ensureOwnerTemplateRole();
    await auditPlatform(req, 'platform.store.create', 'store', store.id, {}, store, store.id);
    sendSuccess(res, { store }, { status: 201 });
  } catch (err) {
    logger.error('Failed to create platform store:', err);
    apiError(res, 500, err.message || 'Failed to create store', 'STORE_CREATE_FAILED');
  }
});

router.patch('/stores/:id', verifyPlatformAdmin, validateBody(platformStoreUpdateSchema), async (req, res) => {
  const { id } = req.params;
  const { name, custom_domain, subscription_expires_at, is_active, plan_id, status } = req.body;
  const cleanDomain = normalizeDomain(custom_domain);

  try {
    const { data: oldStore, error: oldError } = await supabase
      .from('stores')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (oldError || !oldStore) return apiError(res, 404, 'Store not found', `HTTP_404`);

    if (cleanDomain && cleanDomain !== normalizeDomain(oldStore.custom_domain)) {
      const { data: existingDomain } = await supabase
        .from('custom_domains')
        .select('id, store_id')
        .eq('domain', cleanDomain)
        .neq('store_id', id)
        .maybeSingle();
      if (existingDomain) return apiError(res, 409, 'Custom domain is already assigned to another tenant', `HTTP_409`);
    }

    const payload = {
      updated_at: new Date().toISOString()
    };
    if (name !== undefined) payload.name = name.trim();
    if (custom_domain !== undefined) payload.custom_domain = cleanDomain || null;
    if (subscription_expires_at) payload.subscription_expires_at = new Date(subscription_expires_at).toISOString();
    if (is_active !== undefined) {
      payload.is_active = !!is_active;
      payload.status = is_active ? 'active' : 'suspended';
    }

    const { data: store, error } = await supabase
      .from('stores')
      .update(payload)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    // Handle store_subscriptions updates/upserts
    if (plan_id !== undefined || status !== undefined || subscription_expires_at) {
      const { data: currentSub } = await supabase
        .from('store_subscriptions')
        .select('*')
        .eq('store_id', id)
        .maybeSingle();

      const newPlanId = (plan_id && plan_id !== 'null' && plan_id !== '') ? plan_id : (currentSub?.plan_id || await getDefaultPlanId());
      const newStatus = status !== undefined ? status : (is_active !== undefined ? (is_active ? 'active' : 'suspended') : (currentSub?.status || 'active'));
      const newExpiresAt = subscription_expires_at ? new Date(subscription_expires_at).toISOString() : (currentSub?.expires_at || store.subscription_expires_at);

      const { error: subErr } = await supabase
        .from('store_subscriptions')
        .upsert({
          store_id: id,
          plan_id: newPlanId,
          status: newStatus,
          expires_at: newExpiresAt,
          updated_at: new Date().toISOString()
        }, { onConflict: 'store_id' });

      if (subErr) throw subErr;
    }

    // Invalidate cache so changes (like subscription expiry) reflect instantly
    if (store.subdomain) tenantCache.delete(store.subdomain);
    if (store.custom_domain) tenantCache.delete(store.custom_domain);

    await auditPlatform(req, 'platform.store.update', 'store', id, oldStore, store, id);
    sendSuccess(res, { store });
  } catch (err) {
    logger.error('Failed to update platform store:', err);
    apiError(res, 500, 'Failed to update store', `HTTP_500`);
  }
});

router.post('/stores/:id/suspend', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const reason = req.body?.reason || 'Suspended by Platform Owner';
  try {
    const { data: oldStore } = await supabase.from('stores').select('*').eq('id', id).maybeSingle();
    if (!oldStore) return apiError(res, 404, 'Store not found', `HTTP_404`);

    const { data: store, error } = await supabase
      .from('stores')
      .update({ is_active: false, status: 'suspended', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    await supabase.from('store_subscriptions').update({ status: 'suspended', updated_at: new Date().toISOString() }).eq('store_id', id);
    
    if (store.subdomain) tenantCache.delete(store.subdomain);
    if (store.custom_domain) tenantCache.delete(store.custom_domain);

    await auditPlatform(req, 'platform.store.suspend', 'store', id, oldStore, { ...store, reason }, id);
    sendSuccess(res, { store });
  } catch (err) {
    logger.error('Failed to suspend store:', err.message);
    apiError(res, 500, 'Failed to suspend store', `HTTP_500`);
  }
});

router.post('/stores/:id/recover', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: oldStore } = await supabase.from('stores').select('*').eq('id', id).maybeSingle();
    if (!oldStore) return apiError(res, 404, 'Store not found', `HTTP_404`);

    const { data: store, error } = await supabase
      .from('stores')
      .update({ is_active: true, status: 'active', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    await supabase.from('store_subscriptions').update({ status: 'active', updated_at: new Date().toISOString() }).eq('store_id', id);

    if (store.subdomain) tenantCache.delete(store.subdomain);
    if (store.custom_domain) tenantCache.delete(store.custom_domain);

    await auditPlatform(req, 'platform.store.recover', 'store', id, oldStore, store, id);
    sendSuccess(res, { store });
  } catch (err) {
    logger.error('Failed to recover store:', err.message);
    apiError(res, 500, 'Failed to recover store', `HTTP_500`);
  }
});

// Lightweight, searchable store directory for selectors. Never force an admin
// page to download the entire tenant table just to render a dropdown.
router.get('/stores/options', verifyPlatformAdmin, async (req, res) => {
  try {
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 5), 50) : 25;
    const search = sanitizeIlikeTerm(req.query.search);
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : '';
    let query = supabase
      .from('stores')
      .select('id,name,subdomain,custom_domain,is_active,status')
      .order('name', { ascending: true })
      .limit(limit + 1);
    if (search) query = query.or(`name.ilike.%${search}%,subdomain.ilike.%${search}%,custom_domain.ilike.%${search}%`);
    if (cursor) query = query.gt('name', cursor);
    const { data, error } = await query;
    if (error) throw error;
    const rows = data || [];
    const items = rows.slice(0, limit);
    sendSuccess(res, { items, nextCursor: rows.length > limit ? items[items.length - 1]?.name || null : null });
  } catch (err) {
    logger.error('Failed to retrieve store options:', err.message);
    apiError(res, 500, 'Failed to retrieve store options', `HTTP_500`);
  }
});

// Super Admin storage explorer. R2 is the source of truth because older uploads
// may predate platform_storage_objects tracking. Keys are always constrained to
// the selected tenant prefix; a client can never browse or delete another scope.
router.get('/storage', verifyPlatformAdmin, async (req, res) => {
  try {
    if (!process.env.R2_BUCKET_NAME || !process.env.R2_ACCOUNT_ID) {
      return apiError(res, 503, 'R2 storage is not configured.', `HTTP_503`);
    }
    const selectedId = typeof req.query.store_id === 'string' ? req.query.store_id : null;
    if (!selectedId) return sendSuccess(res, { stores: [], selected: null, tree: null });
    const { data: selected, error } = await supabase
      .from('stores')
      .select('id,name,subdomain,status,is_active')
      .eq('id', selectedId)
      .maybeSingle();
    if (error) throw error;
    if (!selected) return apiError(res, 404, 'Store not found', `HTTP_404`);

    const rootPrefix = `stores/${selected.id}/`;
    const requestedPrefix = typeof req.query.prefix === 'string' ? req.query.prefix.trim() : rootPrefix;
    if (!requestedPrefix.startsWith(rootPrefix) || !requestedPrefix.endsWith('/') || requestedPrefix.includes('..')) {
      return apiError(res, 400, 'Invalid storage folder.', `HTTP_400`);
    }
    const prefix = requestedPrefix;
    const objects = await listS3Objects(process.env.R2_BUCKET_NAME, prefix);
    const tree = buildStorageTree(objects, prefix);
    sendSuccess(res, { stores: [selected],
      selected,
      prefix,
      totals: { files: objects.length, bytes: objects.reduce((sum, item) => sum + item.size, 0) },
      tree });
  } catch (err) {
    logger.error('Platform storage listing failed:', err.message);
    apiError(res, 500, 'Unable to load platform storage.', `HTTP_500`);
  }
});

router.delete('/storage/object', verifyPlatformAdmin, async (req, res) => {
  try {
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    const storeId = typeof req.body?.store_id === 'string' ? req.body.store_id : '';
    if (!key || !storeId || !key.startsWith(`stores/${storeId}/`) || key.includes('..')) {
      return apiError(res, 400, 'A valid store-scoped object key is required.', `HTTP_400`);
    }
    const { data: store } = await supabase.from('stores').select('id').eq('id', storeId).maybeSingle();
    if (!store) return apiError(res, 404, 'Store not found.', `HTTP_404`);
    await s3Client.send(new DeleteObjectsCommand({ Bucket: process.env.R2_BUCKET_NAME, Delete: { Objects: [{ Key: key }] } }));
    await auditPlatform(req, 'platform.storage.object_delete', 'storage_object', key, { store_id: storeId }, null, storeId);
    sendSuccess(res, { key });
  } catch (err) {
    logger.error('Platform storage object deletion failed:', err.message);
    apiError(res, 500, 'Unable to delete storage object.', `HTTP_500`);
  }
});

router.delete('/storage/folder', verifyPlatformAdmin, async (req, res) => {
  try {
    const storeId = typeof req.body?.store_id === 'string' ? req.body.store_id : '';
    const requestedPrefix = typeof req.body?.prefix === 'string' ? req.body.prefix.trim() : '';
    const root = `stores/${storeId}/`;
    if (!storeId || !requestedPrefix || !requestedPrefix.startsWith(root) || !requestedPrefix.endsWith('/') || requestedPrefix.includes('..')) {
      return apiError(res, 400, 'A valid store-scoped folder is required.', `HTTP_400`);
    }
    const { data: store } = await supabase.from('stores').select('id').eq('id', storeId).maybeSingle();
    if (!store) return apiError(res, 404, 'Store not found.', `HTTP_404`);
    const result = await emptyS3Directory(process.env.R2_BUCKET_NAME, requestedPrefix);
    await auditPlatform(req, 'platform.storage.folder_delete', 'storage_folder', requestedPrefix, { store_id: storeId }, result, storeId);
    sendSuccess(res, { prefix: requestedPrefix, ...result });
  } catch (err) {
    logger.error('Platform storage folder deletion failed:', err.message);
    apiError(res, 500, 'Unable to delete storage folder.', `HTTP_500`);
  }
});

router.delete('/stores/:id', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: oldStore } = await supabase.from('stores').select('*').eq('id', id).maybeSingle();
    if (!oldStore) return apiError(res, 404, 'Store not found', `HTTP_404`);

    const confirmation = typeof req.body?.confirmation === 'string' ? req.body.confirmation.trim() : '';
    if (!confirmation || confirmation !== oldStore.name) {
      return apiError(res, 409, 'Type the exact store name to confirm permanent deletion.', 'DELETE_CONFIRMATION_REQUIRED');
    }

    // 1. Wipe all files associated with the store from R2
    let storageResult = { deletedCount: 0, deletedBytes: 0 };
    if (process.env.R2_BUCKET_NAME) {
      storageResult = await emptyS3Directory(process.env.R2_BUCKET_NAME, `stores/${id}/`);
    }

    // 2. Hard delete the store from database (Cascades to products, orders, etc.)
    const { error } = await supabase
      .from('stores')
      .delete()
      .eq('id', id);

    if (error) throw error;

    await auditPlatform(req, 'platform.store.delete_hard', 'store', id, oldStore, { storageResult }, id);
    sendSuccess(res, { message: 'Store completely deleted.', storage: storageResult });
  } catch (err) {
    logger.error('Failed to hard delete store:', err.message);
    apiError(res, 500, 'Failed to delete store', `HTTP_500`);
  }
});

router.get('/tenants/metrics', verifyPlatformAdmin, async (req, res) => {
  try {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const { data: stores, error: storesError } = await supabase
      .from('stores')
      .select(`
        id, name, subdomain, custom_domain, is_active, status, subscription_expires_at,
        store_subscriptions (
          status,
          plan_id,
          plans ( id, code, display_name )
        )
      `)
      .order('created_at', { ascending: false });
    if (storesError) throw storesError;

    const metrics = [];
    for (const store of stores || []) {
      const [ordersRes, deliveredRes, productsRes, otpRes] = await Promise.all([
        supabase.from('orders').select('total', { count: 'exact' }).eq('store_id', store.id).gte('created_at', monthStart.toISOString()),
        supabase.from('orders').select('id', { count: 'exact', head: true }).eq('store_id', store.id).eq('status', 'delivered').gte('created_at', monthStart.toISOString()),
        supabase.from('products').select('id', { count: 'exact', head: true }).eq('store_id', store.id),
        supabase.from('feature_usage').select('usage_count').eq('store_id', store.id).eq('feature_key', 'otp_messages_month').gte('period_start', monthStart.toISOString())
      ]);

      metrics.push({
        ...store,
        orders_this_month: ordersRes.count || 0,
        delivered_this_month: deliveredRes.count || 0,
        sales_this_month: (ordersRes.data || []).reduce((sum, order) => sum + Number(order.total || 0), 0),
        products_count: productsRes.count || 0,
        otp_usage_this_month: (otpRes.data || []).reduce((sum, row) => sum + Number(row.usage_count || 0), 0),
        plan: store.store_subscriptions?.plans || null,
        plan_id: store.store_subscriptions?.plan_id || null,
        subscription_status: store.store_subscriptions?.status || null
      });
    }

    sendSuccess(res, metrics);
  } catch (err) {
    logger.error('Failed to retrieve tenant metrics:', err.message);
    apiError(res, 500, 'Failed to retrieve tenant metrics', `HTTP_500`);
  }
});

router.get('/users', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data: profiles, error } = await supabase
      .from('user_profiles')
      .select('*, stores(id, name, subdomain)')
      .order('created_at', { ascending: false });

    if (error) throw error;

    // Group by user_id — one row per store, so we merge stores and pick the newest profile
    const userMap = new Map();

    (profiles || []).forEach((row) => {
      if (!row.user_id) return;

      if (!userMap.has(row.user_id)) {
        // First occurrence — use it as the base profile, start store list
        userMap.set(row.user_id, {
          ...row,
          stores: row.stores ? [row.stores] : [],
        });
      } else {
        // Duplicate user_id from a different store — just add the store
        const existing = userMap.get(row.user_id);
        if (row.stores && !existing.stores.some(s => s.id === row.stores.id)) {
          existing.stores.push(row.stores);
        }
        // Keep the most recently updated profile data
        if (new Date(row.updated_at) > new Date(existing.updated_at)) {
          const stores = existing.stores;
          userMap.set(row.user_id, { ...row, stores });
        }
      }
    });

    const allUserIds = Array.from(userMap.keys());

    // Enrich with names from orders and additional store memberships from user_roles
    if (allUserIds.length > 0) {
      const [ordersRes, rolesRes] = await Promise.all([
        supabase.from('orders').select('user_id, store_id, full_name, stores(id, name, subdomain)').in('user_id', allUserIds),
        supabase.from('user_roles').select('user_id, store_id, stores(id, name, subdomain)').in('user_id', allUserIds),
      ]);

      // Add names from orders
      (ordersRes.data || []).forEach((order) => {
        const user = userMap.get(order.user_id);
        if (user && order.full_name && !user.full_name) {
          user.full_name = order.full_name;
        }
        if (user && order.stores && !user.stores.some(s => s.id === order.store_id)) {
          user.stores.push(order.stores);
        }
      });

      // Add stores from user_roles (admin memberships)
      (rolesRes.data || []).forEach((ur) => {
        const user = userMap.get(ur.user_id);
        if (user && ur.stores && !user.stores.some(s => s.id === ur.store_id)) {
          user.stores.push(ur.stores);
        }
      });
    }

    const users = Array.from(userMap.values());

    sendSuccess(res, { users });
  } catch (err) {
    logger.error('Platform users list failed:', err.message);
    apiError(res, 500, 'Failed to load users', `HTTP_500`);
  }
});


// GET /api/platform/admin-users - List users with admin roles (super_admins + user_roles)
router.get('/admin-users', verifyPlatformAdmin, async (req, res) => {
  try {
    const [{ data: userRoles }, { data: superAdmins }] = await Promise.all([
      supabase.from('user_roles').select(`
        *,
        roles (id, name, display_name, role_type),
        stores (id, name, subdomain)
      `),
      supabase.from('super_admins').select('user_id, created_at')
    ]);

    const allUserIds = [...new Set([
      ...(userRoles || []).map(ur => ur.user_id),
      ...(superAdmins || []).map(sa => sa.user_id)
    ])];

    let profileMap = {};
    if (allUserIds.length > 0) {
      const { data: profiles } = await supabase
        .from('user_profiles')
        .select('*')
        .in('user_id', allUserIds);
      (profiles || []).forEach(p => { profileMap[p.user_id] = p; });
    }

    const adminUsers = [];
    const seen = new Set();

    (superAdmins || []).forEach(sa => {
      if (seen.has(sa.user_id)) return;
      seen.add(sa.user_id);
      const p = profileMap[sa.user_id] || {};
      adminUsers.push({
        user_id: sa.user_id,
        full_name: p.full_name || '',
        email: p.email || '',
        phone: p.phone || '',
        avatar_url: p.avatar_url || null,
        is_banned: p.is_banned || false,
        ban_reason: p.ban_reason || null,
        created_at: sa.created_at || p.created_at,
        roles: [{ role: 'super_admin', display_name: 'Super Admin', store_name: null, store_id: null }],
        stores: []
      });
    });

    (userRoles || []).forEach(ur => {
      const p = profileMap[ur.user_id] || {};
      if (!seen.has(ur.user_id)) {
        seen.add(ur.user_id);
        adminUsers.push({
          user_id: ur.user_id,
          full_name: p.full_name || '',
          email: p.email || '',
          phone: p.phone || '',
          avatar_url: p.avatar_url || null,
          is_banned: p.is_banned || false,
          ban_reason: p.ban_reason || null,
          created_at: p.created_at,
          roles: [],
          stores: []
        });
      }
      const entry = adminUsers.find(u => u.user_id === ur.user_id);
      if (!entry) return;
      entry.roles.push({
        role: ur.roles?.name || 'unknown',
        display_name: ur.roles?.display_name || ur.roles?.name || 'Unknown Role',
        store_name: ur.stores?.name || null,
        store_id: ur.store_id
      });
      if (ur.store_id && !entry.stores.find(s => s.id === ur.store_id)) {
        entry.stores.push({
          id: ur.store_id,
          name: ur.stores?.name || 'Unknown Store',
          subdomain: ur.stores?.subdomain || null
        });
      }
    });

    adminUsers.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    sendSuccess(res, { users: adminUsers });
  } catch (err) {
    logger.error('Platform admin users list failed:', err.message);
    apiError(res, 500, 'Failed to load admin users', `HTTP_500`);
  }
});

router.get('/users/:user_id/addresses', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_addresses')
      .select('*')
      .eq('user_id', req.params.user_id);

    if (error) throw error;
    sendSuccess(res, { addresses: data || [] });
  } catch (err) {
    logger.error('Platform user addresses failed:', err.message);
    apiError(res, 500, 'Failed to load user addresses', `HTTP_500`);
  }
});

router.post('/users/:user_id/ban', verifyPlatformAdmin, async (req, res) => {
  const userId = req.params.user_id;
  const reason = req.body?.reason || 'Policy violation';
  const scope = req.body?.ban_scope || req.body?.scope || 'ALL';
  const adminId = req.user.sub;

  try {
    const { error: logError } = await supabase
      .from('ban_logs')
      .insert([{
        user_id: userId,
        ban_scope: scope,
        ban_type: req.body?.ban_type || 'Custom',
        reason,
        created_by: adminId
      }]);

    if (logError) throw logError;

    const { error } = await supabase
      .from('user_profiles')
      .update({ is_banned: true, ban_reason: reason })
      .eq('user_id', userId);

    if (error) throw error;
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Platform user ban failed:', err.message);
    apiError(res, 500, 'Failed to ban user', `HTTP_500`);
  }
});

router.post('/users/:user_id/unban', verifyPlatformAdmin, async (req, res) => {
  const userId = req.params.user_id;
  const adminId = req.user.sub;

  try {
    const { error: logError } = await supabase
      .from('ban_logs')
      .update({
        lifted_at: new Date().toISOString(),
        lifted_by: adminId,
        is_active: false
      })
      .eq('user_id', userId)
      .eq('is_active', true);

    if (logError) throw logError;

    const { error } = await supabase
      .from('user_profiles')
      .update({ is_banned: false, ban_reason: null })
      .eq('user_id', userId);

    if (error) throw error;
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Platform user unban failed:', err.message);
    apiError(res, 500, 'Failed to unban user', `HTTP_500`);
  }
});

router.post('/users/:user_id/reset-link', verifyPlatformAdmin, async (req, res) => {
  const userId = req.params.user_id;
  const { phone } = req.body;

  try {
    const { data: userAuth, error: authError } = await supabase.auth.admin.getUserById(userId);

    if (authError || !userAuth?.user?.email) {
      return apiError(res, 404, 'User not found or has no email address', `HTTP_404`);
    }

    const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email: userAuth.user.email,
      options: {
        redirectTo: `${process.env.FRONTEND_URL || 'https://egparts.store'}/reset-password`
      }
    });

    if (linkError) {
      throw linkError;
    }

    const resetLink = linkData.properties.action_link;

    await auditPlatform(req, 'platform.users.reset_link', 'user', userId, null, null);

    // Send reset link via WhatsApp if phone is provided
    if (phone && phone.trim()) {
      const { sendNotification } = require('../services/notificationEngine');
      sendNotification({
        templateCode: 'platform_password_reset',
        recipient: phone.trim(),
        language: 'ar',
        variables: {
          reset_link: resetLink,
          idempotency_key: `platform-reset-${userId}`
        }
      }).catch(err => {
        logger.error(`Failed to send WhatsApp reset link to ${phone}: ${err.message}`);
      });
    }

    sendSuccess(res, { link: resetLink });
  } catch (err) {
    logger.error('Failed to generate reset link:', err.message);
    apiError(res, 500, 'Failed to generate reset link', `HTTP_500`);
  }
});

// GET /api/platform/users/:user_id/details - Get platform user detail
router.get('/users/:user_id/details', verifyPlatformAdmin, async (req, res) => {
  try {
    const { user_id } = req.params;

    const { data: profileList, error: profileErr } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', user_id)
      .limit(1);

    if (profileErr) throw profileErr;
    if (!profileList || profileList.length === 0) {
      return apiError(res, 404, 'User not found', `HTTP_404`);
    }
    const profile = profileList[0];

    let store_name = null;
    if (profile.store_id) {
      const { data: storeData } = await supabase
        .from('stores')
        .select('name')
        .eq('id', profile.store_id)
        .maybeSingle();
      if (storeData) {
        store_name = storeData.name;
      }
    } else {
      // Try to get first store from user_roles
      const { data: roleData } = await supabase
        .from('user_roles')
        .select('stores(name)')
        .eq('user_id', user_id)
        .limit(1)
        .maybeSingle();
      if (roleData && roleData.stores) {
        store_name = roleData.stores.name;
      }
    }

    let account_status = 'active';
    if (profile.is_banned) {
      account_status = 'banned';
    } else if (profile.is_suspended) {
      account_status = 'suspended';
    }

    const { data: ordersData, error: ordersErr } = await supabase
      .from('orders')
      .select('total_amount, created_at')
      .eq('user_id', user_id)
      .neq('status', 'cancelled');

    let total_orders = 0;
    let total_spent = 0;
    let last_order_date = null;

    if (!ordersErr && ordersData) {
      total_orders = ordersData.length;
      total_spent = ordersData.reduce((acc, order) => acc + (Number(order.total_amount) || 0), 0);
      const dates = ordersData.map(o => new Date(o.created_at).getTime());
      if (dates.length > 0) {
        last_order_date = new Date(Math.max(...dates)).toISOString();
      }
    }

    const detail = {
      ...profile,
      store_name,
      account_status,
      total_orders,
      total_spent,
      last_order_date
    };

    sendSuccess(res, { user: detail });
  } catch (err) {
    logger.error('Platform user detail failed:', err.message);
    apiError(res, 500, 'Failed to load user details', `HTTP_500`);
  }
});

// DELETE /api/platform/users/:user_id - Remove admin privileges
router.delete('/users/:user_id', verifyPlatformAdmin, async (req, res) => {
  try {
    const { user_id } = req.params;
    
    // Check if user has roles to audit
    const { data: oldRoles } = await supabase
      .from('user_roles')
      .select('*')
      .eq('user_id', user_id);

    const { error: rolesErr } = await supabase
      .from('user_roles')
      .delete()
      .eq('user_id', user_id);

    if (rolesErr) throw rolesErr;

    const { error: superErr } = await supabase
      .from('super_admins')
      .delete()
      .eq('user_id', user_id);

    if (superErr) throw superErr;

    await auditPlatform(req, 'platform.users.remove_admin', 'user', user_id, oldRoles, null);

    sendSuccess(res, { message: 'Admin privileges removed successfully' });
  } catch (err) {
    logger.error('Platform user admin removal failed:', err.message);
    apiError(res, 500, 'Failed to remove admin privileges', `HTTP_500`);
  }
});

// Impersonation Endpoints
router.post('/impersonate/start', verifyPlatformAdmin, async (req, res) => {
  const { store_id, reason } = req.body;
  if (!store_id || !reason) {
    return apiError(res, 400, 'store_id and reason are required', `HTTP_400`);
  }

  try {
    const admin_id = req.user.sub;
    const expires_at = new Date();
    expires_at.setHours(expires_at.getHours() + 2); // 2 hour duration

    const { data: session, error } = await supabase
      .from('impersonation_sessions')
      .insert([{
        store_id,
        admin_id,
        reason,
        expires_at: expires_at.toISOString(),
        ip_address: req.ip,
        user_agent: req.headers['user-agent']
      }])
      .select()
      .single();

    if (error) throw error;

    await auditPlatform(req, 'platform.impersonate.start', 'store', store_id, null, session, session.id);
    sendSuccess(res, { session_token: session.session_token, store_id });
  } catch (err) {
    logger.error('Failed to start impersonation:', err.message);
    apiError(res, 500, 'Failed to start impersonation', `HTTP_500`);
  }
});

router.post('/impersonate/stop', verifyPlatformAdmin, async (req, res) => {
  const { session_token } = req.body;
  if (!session_token) {
    return apiError(res, 400, 'session_token is required', `HTTP_400`);
  }

  try {
    const { data: session, error } = await supabase
      .from('impersonation_sessions')
      .update({ ended_at: new Date().toISOString(), is_active: false })
      .eq('session_token', session_token)
      .select()
      .single();

    if (error) throw error;

    await auditPlatform(req, 'platform.impersonate.stop', 'store', session.store_id, null, session, session.id);
    sendSuccess(res, { message: 'Impersonation ended successfully' });
  } catch (err) {
    logger.error('Failed to stop impersonation:', err.message);
    apiError(res, 500, 'Failed to stop impersonation', `HTTP_500`);
  }
});

// Scoped Ban Endpoints
router.post('/users/ban', verifyPlatformAdmin, async (req, res) => {
  const { user_id, store_id, ban_scope, ban_type, reason, is_temporary, banned_until } = req.body;
  if (!user_id || !reason) {
    return apiError(res, 400, 'user_id and reason are required', `HTTP_400`);
  }

  try {
    const admin_id = req.user.sub;
    const { data: banLog, error } = await supabase
      .from('ban_logs')
      .insert([{
        user_id,
        store_id: store_id || null,
        ban_scope: ban_scope || 'ALL',
        ban_type: ban_type || 'Custom',
        is_temporary: is_temporary || false,
        banned_until: banned_until || null,
        reason,
        created_by: admin_id
      }])
      .select()
      .single();

    if (error) throw error;

    // Update is_banned in user_profiles as fallback for legacy logic
    if (store_id) {
      await supabase
        .from('user_profiles')
        .update({ is_banned: true, ban_reason: reason })
        .eq('user_id', user_id)
        .eq('store_id', store_id);
    }

    await auditPlatform(req, 'platform.users.ban', 'user', user_id, null, banLog, banLog.id);
    sendSuccess(res, { banLog });
  } catch (err) {
    logger.error('Failed to ban user:', err.message);
    apiError(res, 500, 'Failed to ban user', `HTTP_500`);
  }
});

router.post('/users/unban', verifyPlatformAdmin, async (req, res) => {
  const { ban_log_id, store_id, user_id } = req.body;
  if (!ban_log_id) {
    return apiError(res, 400, 'ban_log_id is required', `HTTP_400`);
  }

  try {
    const admin_id = req.user.sub;
    const { data: banLog, error } = await supabase
      .from('ban_logs')
      .update({
        lifted_at: new Date().toISOString(),
        lifted_by: admin_id,
        is_active: false
      })
      .eq('id', ban_log_id)
      .select()
      .single();

    if (error) throw error;

    // Update is_banned in user_profiles as fallback
    if (store_id && user_id) {
      await supabase
        .from('user_profiles')
        .update({ is_banned: false, ban_reason: null })
        .eq('user_id', user_id)
        .eq('store_id', store_id);
    }

    await auditPlatform(req, 'platform.users.unban', 'user', banLog.user_id, null, banLog, banLog.id);
    sendSuccess(res, { banLog });
  } catch (err) {
    logger.error('Failed to unban user:', err.message);
    apiError(res, 500, 'Failed to unban user', `HTTP_500`);
  }
});

router.post('/impersonation/start', verifyPlatformAdmin, async (req, res) => {
  const { store_id } = req.body;
  if (!store_id) return apiError(res, 400, 'store_id is required', `HTTP_400`);

  try {
    const { data: store, error } = await supabase
      .from('stores')
      .select('id, name, subdomain, custom_domain, is_active, status, subscription_expires_at')
      .eq('id', store_id)
      .maybeSingle();
    if (error || !store) return apiError(res, 404, 'Store not found', `HTTP_404`);

    const auditId = crypto.randomUUID();
    const token = jwt.sign({
      typ: 'platform_impersonation',
      jti: auditId,
      platform_user_id: req.user.sub,
      store_id: store.id
    }, process.env.DATABASE_ENCRYPTION_KEY, { expiresIn: IMPERSONATION_TTL_SECONDS });

    await supabase.from('impersonation_logs').insert([{
      id: auditId,
      super_admin_id: req.user.sub,
      store_id: store.id,
      started_at: new Date().toISOString(),
      ip_address: req.ip,
      user_agent: req.headers['user-agent'] || null
    }]);

    await auditPlatform(req, 'platform.impersonation.start', 'store', store.id, {}, { store_id: store.id, audit_id: auditId }, store.id);
    sendSuccess(res, { token, store, expires_in: IMPERSONATION_TTL_SECONDS, audit_id: auditId });
  } catch (err) {
    logger.error('Failed to start impersonation:', err.message);
    apiError(res, 500, 'Failed to start impersonation', `HTTP_500`);
  }
});

router.post('/impersonation/end', verifyPlatformAdmin, async (req, res) => {
  const { token } = req.body;
  if (!token) return apiError(res, 400, 'token is required', `HTTP_400`);

  try {
    const decoded = jwt.verify(token, process.env.DATABASE_ENCRYPTION_KEY);
    if (decoded.typ !== 'platform_impersonation' || decoded.platform_user_id !== req.user.sub) {
      return apiError(res, 403, 'Invalid impersonation token', `HTTP_403`);
    }

    await supabase
      .from('impersonation_logs')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', decoded.jti)
      .eq('super_admin_id', req.user.sub);

    await auditPlatform(req, 'platform.impersonation.end', 'store', decoded.store_id, {}, { audit_id: decoded.jti }, decoded.store_id);
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to end impersonation:', err.message);
    apiError(res, 400, 'Invalid or expired impersonation token', `HTTP_400`);
  }
});

router.post('/impersonation/session', async (req, res) => {
  const { token } = req.body;
  if (!token) return apiError(res, 400, 'token is required', `HTTP_400`);

  try {
    const decoded = jwt.verify(token, process.env.DATABASE_ENCRYPTION_KEY);
    if (decoded.typ !== 'platform_impersonation') {
      return apiError(res, 403, 'Invalid impersonation token', `HTTP_403`);
    }

    const { data: store, error } = await supabase
      .from('stores')
      .select('*')
      .eq('id', decoded.store_id)
      .maybeSingle();
    if (error || !store) return apiError(res, 404, 'Store not found', `HTTP_404`);

    sendSuccess(res, { store, audit_id: decoded.jti });
  } catch (err) {
    apiError(res, 400, 'Invalid or expired impersonation token', `HTTP_400`);
  }
});


router.post('/stores/subscription', verifyPlatformAdmin, async (req, res) => {
  const { store_id, plan_id, status, expires_at } = req.body;
  if (!store_id || !plan_id || !expires_at) {
    return apiError(res, 400, 'store_id, plan_id, and expires_at are required', `HTTP_400`);
  }

  try {
    // 1. Update store subscription
    const { error: subErr } = await supabase
      .from('store_subscriptions')
      .upsert({
        store_id,
        plan_id,
        status: status || 'active',
        expires_at: new Date(expires_at).toISOString(),
        updated_at: new Date().toISOString()
      }, { onConflict: 'store_id' });

    if (subErr) throw subErr;

    // 2. Sync to stores table subscription_expires_at for legacy domain compatibility
    const { error: storeErr } = await supabase
      .from('stores')
      .update({
        subscription_expires_at: new Date(expires_at).toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', store_id);

    if (storeErr) throw storeErr;

    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to update tenant subscription:', err.message);
    apiError(res, 500, 'Failed to update subscription', `HTTP_500`);
  }
});

// 6. GET /api/platform/audit-logs - Retrieve global audit logs
router.get('/audit-logs', verifyPlatformAdmin, async (req, res) => {
  const { store_id, action, search } = req.query;
  try {
    const parsedLimit = Number.parseInt(req.query.limit, 10);
    const parsedOffset = Number.parseInt(req.query.offset, 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;
    const offset = Number.isFinite(parsedOffset) ? Math.max(parsedOffset, 0) : 0;
    let query = supabase
      .from('audit_logs')
      .select(`
        *,
        stores (
          name,
          subdomain
        )
      `, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (store_id) query = query.eq('store_id', store_id);
    if (action) query = query.ilike('action', `%${String(action).slice(0, 80).replace(/[,*().%]/g, '')}%`);
    if (search) {
      const safeSearch = sanitizeIlikeTerm(search);
      if (safeSearch) {
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(safeSearch);
        const escaped = safeSearch;
        if (isUuid) {
          query = query.or(`ip_address.ilike.%${escaped}%,user_id.eq.${escaped},entity_id.ilike.%${escaped}%,action.ilike.%${escaped}%`);
        } else {
          query = query.or(`ip_address.ilike.%${escaped}%,entity_id.ilike.%${escaped}%,action.ilike.%${escaped}%`);
        }
      }
    }

    const { data: logs, count, error } = await query;
    if (error) throw error;

    sendSuccess(res, { data: logs, total: count || 0 });
  } catch (err) {
    logger.error('Failed to query platform audit logs:', err.message);
    apiError(res, 500, 'Failed to retrieve global audit logs', `HTTP_500`);
  }
});

// DELETE /api/platform/audit-logs - Purge global audit logs
router.delete('/audit-logs', verifyPlatformAdmin, async (req, res) => {
  const { mode, days } = req.body;
  
  try {
    let query = supabase.from('audit_logs').delete();
    
    if (mode === 'older_than' && Number.isInteger(days) && days >= 1 && days <= 3650) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      query = query.lt('created_at', cutoff.toISOString());
    } else if (mode === 'all') {
      query = query.neq('id', '00000000-0000-0000-0000-000000000000'); // Supabase requires a filter for deletes
    } else {
      return apiError(res, 400, 'Invalid purge mode', `HTTP_400`);
    }
    
    const { error } = await query;
    if (error) throw error;
    
    await auditPlatform(req, 'platform.audit_logs.purge', 'system', 'global', null, { mode, days });
    sendSuccess(res, { message: 'تم تنظيف السجلات بنجاح' });
  } catch (err) {
    logger.error('Failed to purge audit logs:', err.message);
    apiError(res, 500, 'Failed to purge audit logs', `HTTP_500`);
  }
});

// ============================================================
// 7. Tenant Invitations Management
// ============================================================

// GET /api/platform/invitations - List all invitations
router.get('/invitations', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data: invitations, error } = await supabase
      .from('tenant_invitations')
      .select(`
        *,
        stores (
          name,
          subdomain
        ),
        roles (
          display_name
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    sendSuccess(res, invitations);
  } catch (err) {
    logger.error('Failed to list invitations:', err.message);
    apiError(res, 500, 'Failed to retrieve invitations', `HTTP_500`);
  }
});

function normalizeInvitationPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = `2${digits}`;
  if (!/^20\d{10}$/.test(digits)) throw new Error('رقم واتساب غير صالح. استخدم رقمًا مصريًا مثل 2010xxxxxxxx');
  return digits;
}

async function sendInvitationWhatsApp({ phone, activationLink, storeName, invitationId, storeId }) {
  const recipient = normalizeInvitationPhone(phone);
  const variables = {
    activation_link: activationLink,
    expires_hours: 48,
    phone: recipient,
    store_name: storeName || 'EG-PARTS Cloud',
    store_id: storeId,
    idempotency_key: `tenant-invitation-${invitationId}`
  };

  const templated = await require('../services/notificationEngine').sendNotification({
    templateCode: 'tenant_invitation',
    channel: 'whatsapp',
    recipient,
    language: 'ar',
    variables
  });
  const templateDelivery = (templated || []).find(result => result.channel === 'whatsapp');
  if (templateDelivery?.status === 'sent') {
    return { status: 'sent', provider: 'template', recipient };
  }

  const body = `مرحباً بك في EG-PARTS Cloud\n\nتمت دعوتك لتصبح مدير متجر${storeName ? ` في متجر ${storeName}` : ''}.\n\nرابط تفعيل الحساب:\n${activationLink}\n\nصلاحية الرابط: 48 ساعة.\n\nإذا لم تطلب هذه الدعوة، تجاهل الرسالة.`;
  const delivery = await whatsappPoolService.sendMessage(recipient, body, {
    idempotencyKey: `tenant-invitation-${invitationId}`
  });
  return { status: delivery ? 'sent' : 'failed', provider: 'pool', recipient };
}

// POST /api/platform/invitations - Create owner invitation (via email/WhatsApp)
router.post('/invitations', verifyPlatformAdmin, validateBody(managerInviteCreateSchema), async (req, res) => {
  const { email, phone, store_id, role_id } = req.body;
  if ((!phone && !email) || !store_id) {
    return apiError(res, 400, 'Please provide either email or phone, and a valid store_id', `HTTP_400`);
  }

  const normalizedEmail = email ? String(email).trim().toLowerCase() : null;
  let normalizedPhone = null;
  if (phone && String(phone).trim()) {
    try {
      normalizedPhone = normalizeInvitationPhone(phone);
    } catch (error) {
      return apiError(res, 400, error.message, 'INVALID_INVITATION_PHONE');
    }
  }

  try {
    // A failed HTTP response must not cause the same invitation to be sent repeatedly.
    // The previous implementation created the row and sent WhatsApp, then crashed later.
    const activeStatuses = ['pending', 'sent'];
    let existingInvitation = null;
    if (normalizedEmail) {
      const { data, error: emailLookupError } = await supabase
        .from('tenant_invitations')
        .select('id, email, phone, store_id, status, expires_at, token')
        .eq('store_id', store_id)
        .eq('email', normalizedEmail)
        .in('status', activeStatuses)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (emailLookupError) throw emailLookupError;
      existingInvitation = data;
    }
    if (!existingInvitation && normalizedPhone) {
      const { data, error: phoneLookupError } = await supabase
        .from('tenant_invitations')
        .select('id, email, phone, store_id, status, expires_at, token')
        .eq('store_id', store_id)
        .eq('phone', normalizedPhone)
        .in('status', activeStatuses)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (phoneLookupError) throw phoneLookupError;
      existingInvitation = data;
    }
    if (existingInvitation) {
      return apiError(res, 409, 'توجد دعوة نشطة بالفعل لهذا البريد أو الرقم. استخدم إعادة الإرسال بدل إنشاء دعوة جديدة.', 'INVITATION_ALREADY_ACTIVE', { invitation: existingInvitation });
    }

    let targetRoleId = role_id;
    if (!targetRoleId) {
      targetRoleId = await ensureOwnerTemplateRole();
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48 hours expiry

    const { data: invitation, error } = await supabase
      .from('tenant_invitations')
      .insert([{
        email: normalizedEmail,
        phone: normalizedPhone,
        store_id,
        role_id: targetRoleId,
        token,
        status: 'pending',
        expires_at: expiresAt,
        invited_by: req.user?.sub || null,
        created_ip: req.ip
      }])
      .select()
      .single();

    if (error) throw error;
    await auditPlatform(req, 'platform.invitation.create', 'tenant_invitation', invitation.id, {}, invitation, store_id);

    let whatsapp = { status: 'not_requested' };
    const { data: storeInfo } = await supabase.from('stores').select('name, subdomain').eq('id', store_id).single();
    const storeSubdomain = storeInfo?.subdomain || 'admin';
    const baseDomain = process.env.PRIMARY_DOMAIN || 'egparts.store';
    const activationLink = `https://${storeSubdomain}.${baseDomain}/accept-invitation?token=${token}`;

    if (email && email.trim()) {
      const { sendNotification } = require('../services/notificationEngine');
      sendNotification({
        templateCode: 'tenant_invitation',
        channel: 'email',
        recipient: normalizedEmail,
        language: 'ar',
        variables: { activation_link: activationLink, expires_hours: 48, store_name: storeInfo?.name || 'EG-PARTS Cloud', store_id }
      }).catch(err => logger.error('Failed to send invitation email:', err));
    }

    if (normalizedPhone) {
      try {
        whatsapp = await sendInvitationWhatsApp({ phone: normalizedPhone, activationLink, storeName: storeInfo?.name, invitationId: invitation.id, storeId: store_id });
      } catch (error) {
        whatsapp = { status: 'failed', message: String(error.message || 'WhatsApp delivery failed').slice(0, 400) };
        logger.error('Failed to send invitation WhatsApp:', error.message);
      }
    }

    sendSuccess(res, { invitation, whatsapp });
  } catch (err) {
    logger.error('Failed to create invitation:', err.message);
    apiError(res, 500, 'Failed to create invitation', `HTTP_500`);
  }
});

// POST /api/platform/invitations/:id/resend - Resend invitation
router.post('/invitations/:id/resend', verifyPlatformAdmin, validateParams(invitationIdParamSchema), async (req, res) => {
  const { id } = req.params;
  try {
    const { data: invite, error: fetchErr } = await supabase
      .from('tenant_invitations')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !invite) {
      return apiError(res, 404, 'Invitation not found', `HTTP_404`);
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const { data: updated, error: updateErr } = await supabase
      .from('tenant_invitations')
      .update({
        token,
        status: 'sent',
        expires_at: expiresAt,
        resent_count: (invite.resent_count || 0) + 1,
        created_ip: req.ip,
        updated_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (updateErr) throw updateErr;

    const { data: storeInfo } = await supabase.from('stores').select('name, subdomain').eq('id', invite.store_id).single();
    const storeSubdomain = storeInfo?.subdomain || 'admin';
    const baseDomain = process.env.PRIMARY_DOMAIN || 'egparts.store';
    const activationLink = `https://${storeSubdomain}.${baseDomain}/accept-invitation?token=${token}`;
    
    let whatsapp = { status: 'not_requested' };
    if (invite.phone) {
      try {
        whatsapp = await sendInvitationWhatsApp({ phone: invite.phone, activationLink, storeName: storeInfo?.name, invitationId: id, storeId: invite.store_id });
      } catch (error) {
        whatsapp = { status: 'failed', message: String(error.message || 'WhatsApp delivery failed').slice(0, 400) };
        logger.error('Failed to resend invitation WhatsApp:', error.message);
      }
    }

    sendSuccess(res, { invitation: updated, whatsapp });
  } catch (err) {
    logger.error('Failed to resend invitation:', err.message);
    apiError(res, 500, 'Failed to resend invitation', `HTTP_500`);
  }
});

// POST /api/platform/invitations/:id/revoke - Revoke invitation
router.post('/invitations/:id/revoke', verifyPlatformAdmin, validateParams(invitationIdParamSchema), async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('tenant_invitations')
      .update({
        status: 'revoked',
        revoked_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    if (error) throw error;
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to revoke invitation:', err.message);
    apiError(res, 500, 'Failed to revoke invitation', `HTTP_500`);
  }
});

// DELETE /api/platform/invitations/cleanup - Delete all revoked or expired invitations
router.delete('/invitations/cleanup', verifyPlatformAdmin, async (req, res) => {
  try {
    const { error, data } = await supabase
      .from('tenant_invitations')
      .delete()
      .in('status', ['revoked', 'expired'])
      .select('id');

    if (error) throw error;
    
    if (data && data.length > 0) {
      await auditPlatform(req, 'platform.invitation.cleanup', 'tenant_invitation', 'bulk', { count: data.length }, null);
    }
    
    sendSuccess(res, { message: `Deleted ${data ? data.length : 0} inactive invitations`, count: data ? data.length : 0 });
  } catch (err) {
    logger.error('Failed to cleanup invitations:', err.message);
    apiError(res, 500, 'Failed to cleanup invitations', `HTTP_500`);
  }
});

// DELETE /api/platform/invitations/:id - Delete invitation completely
router.delete('/invitations/:id', verifyPlatformAdmin, validateParams(invitationIdParamSchema), async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('tenant_invitations')
      .delete()
      .eq('id', id);

    if (error) throw error;
    
    // Optional audit log for complete destruction
    await auditPlatform(req, 'platform.invitation.delete', 'tenant_invitation', id, { id }, null);
    
    sendSuccess(res, { message: 'Invitation deleted permanently' });
  } catch (err) {
    logger.error('Failed to delete invitation:', err.message);
    apiError(res, 500, 'Failed to delete invitation', `HTTP_500`);
  }
});


// ============================================================
// 8. Custom Domains Management
// ============================================================

// GET /api/platform/domains - List custom domains
router.get('/domains', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data: domains, error } = await supabase
      .from('custom_domains')
      .select(`
        *,
        stores (
          name,
          subdomain
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    sendSuccess(res, domains);
  } catch (err) {
    logger.error('Failed to list custom domains:', err.message);
    apiError(res, 500, 'Failed to retrieve custom domains', `HTTP_500`);
  }
});

// POST /api/platform/domains - Create custom domain link
router.post('/domains', verifyPlatformAdmin, async (req, res) => {
  const { store_id, domain, is_primary } = req.body;
  if (!store_id || !domain) {
    return apiError(res, 400, 'store_id and domain are required', `HTTP_400`);
  }

  try {
    const cleanDomain = normalizeDomain(domain);
    const { data: existingDomain } = await supabase
      .from('custom_domains')
      .select('id, store_id')
      .eq('domain', cleanDomain)
      .maybeSingle();

    if (existingDomain) {
      return apiError(res, 409, 'Domain is already assigned to another tenant. Remove the old binding before linking it again.', `HTTP_409`);
    }

    if (!!is_primary) {
      await supabase
        .from('custom_domains')
        .update({ is_primary: false })
        .eq('store_id', store_id);
    }

    const verificationToken = crypto.randomBytes(16).toString('hex');
    const { data: newDomain, error } = await supabase
      .from('custom_domains')
      .insert([{
        store_id,
        domain: cleanDomain,
        is_primary: !!is_primary,
        status: 'pending_verification',
        verification_token: verificationToken
      }])
      .select()
      .single();

    if (error) throw error;

    // Trigger immediate background validation
    const { runDomainCheck } = require('../services/domainValidator');
    setTimeout(() => runDomainCheck(newDomain.id), 1000);

    await auditPlatform(req, 'platform.domain.create', 'custom_domain', newDomain.id, {}, newDomain, store_id);
    sendSuccess(res, { domain: newDomain });
  } catch (err) {
    logger.error('Failed to configure custom domain:', err.message);
    apiError(res, 500, 'Failed to configure custom domain', `HTTP_500`);
  }
});

// PATCH /api/platform/domains/:id/primary - Toggle primary status
router.patch('/domains/:id/primary', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const { is_primary } = req.body;
  
  try {
    const { data: domain } = await supabase
      .from('custom_domains')
      .select('store_id')
      .eq('id', id)
      .single();

    if (!domain) {
      return apiError(res, 404, 'Domain not found', `HTTP_404`);
    }

    if (is_primary) {
      await supabase
        .from('custom_domains')
        .update({ is_primary: false })
        .eq('store_id', domain.store_id);
    }

    const { error } = await supabase
      .from('custom_domains')
      .update({ is_primary: !!is_primary, updated_at: new Date().toISOString() })
      .eq('id', id);

    if (error) throw error;
    
    await auditPlatform(req, 'platform.domain.update_primary', 'custom_domain', id, { is_primary: !is_primary }, { is_primary: !!is_primary }, domain.store_id);
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to update primary domain:', err.message);
    apiError(res, 500, 'Failed to update primary domain', `HTTP_500`);
  }
});

// POST /api/platform/domains/:id/verify - Trigger immediate manual validation
router.post('/domains/:id/verify', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { runDomainCheck } = require('../services/domainValidator');
    await runDomainCheck(id);
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Manual domain check failed:', err.message);
    apiError(res, 500, 'Failed to verify custom domain', `HTTP_500`);
  }
});

// GET /api/platform/domains/:id/logs - Retrieve check logs
router.get('/domains/:id/logs', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: logs, error } = await supabase
      .from('domain_health_checks')
      .select('*')
      .eq('domain_id', id)
      .order('checked_at', { ascending: false })
      .limit(30);

    if (error) throw error;
    sendSuccess(res, logs);
  } catch (err) {
    logger.error('Failed to fetch domain check logs:', err.message);
    apiError(res, 500, 'Failed to retrieve check logs', `HTTP_500`);
  }
});

// DELETE /api/platform/domains/:id - Remove custom domain mapping
router.delete('/domains/:id', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: oldDomain } = await supabase
      .from('custom_domains')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    const { error } = await supabase
      .from('custom_domains')
      .delete()
      .eq('id', id);

    if (error) throw error;
    await auditPlatform(req, 'platform.domain.delete', 'custom_domain', id, oldDomain || {}, {}, oldDomain?.store_id || null);
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to delete custom domain:', err.message);
    apiError(res, 500, 'Failed to delete custom domain', `HTTP_500`);
  }
});


// ============================================================
// 9. Payment Providers & Transactions (Billing Management)
// ============================================================

// GET /api/platform/payment-providers - List configured providers
router.get('/payment-providers', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data: providers, error } = await supabase
      .from('payment_providers')
      .select('*')
      .order('priority', { ascending: true });

    if (error) throw error;

    // Mask sensitive configurations before sending to front-end
    const masked = (providers || []).map(p => {
      let config = {};
      if (p.configuration) {
        try {
          const encryptionKey = getEncryptionKeyForVersion(null);
          const decrypted = decryptCredentials(p.configuration, encryptionKey);
          if (decrypted) {
            config = decrypted;
            // Mask keys
            Object.keys(config).forEach(k => {
              if (k.toLowerCase().includes('secret') || k.toLowerCase().includes('key') || k.toLowerCase().includes('pass')) {
                config[k] = '••••••••••••••••';
              }
            });
          }
        } catch (e) {
          logger.warn('Failed to decrypt masking config for provider:', p.code);
        }
      }
      return {
        ...p,
        configuration: config
      };
    });

    sendSuccess(res, masked);
  } catch (err) {
    logger.error('Failed to list payment providers:', err.message);
    apiError(res, 500, 'Failed to retrieve payment providers', `HTTP_500`);
  }
});

// POST /api/platform/payment-providers - Upsert/Configure provider details
router.post('/payment-providers', verifyPlatformAdmin, async (req, res) => {
  const { code, display_name, enabled, sandbox, configuration, priority } = req.body;
  if (!code || !display_name) {
    return apiError(res, 400, 'code and display_name are required', `HTTP_400`);
  }

  try {
    const payload = {
      code,
      display_name,
      enabled: !!enabled,
      sandbox: !!sandbox,
      priority: priority || 10,
      updated_at: new Date().toISOString()
    };

    if (configuration && typeof configuration === 'object') {
      // If we are editing, check if user kept the masked values, don't overwrite if masked
      const { data: existing } = await supabase
        .from('payment_providers')
        .select('configuration')
        .eq('code', code)
        .maybeSingle();

      let activeConfig = {};
      if (existing?.configuration) {
        try {
          const decrypted = decryptCredentials(existing.configuration, getEncryptionKeyForVersion(null));
          if (decrypted) activeConfig = decrypted;
        } catch (e) {}
      }

      // Merge only changed, non-masked properties
      Object.keys(configuration).forEach(k => {
        if (configuration[k] !== '••••••••••••••••') {
          activeConfig[k] = configuration[k];
        }
      });

      // Encrypt configuration details
      const encryptionKey = getEncryptionKeyForVersion(null);
      const encrypted = encryptCredentials(activeConfig, encryptionKey);
      payload.configuration = JSON.stringify(encrypted);
    }

    const { data: provider, error } = await supabase
      .from('payment_providers')
      .upsert(payload, { onConflict: 'code' })
      .select()
      .single();

    if (error) throw error;
    sendSuccess(res, { provider });
  } catch (err) {
    logger.error('Failed to configure payment provider:', err.message);
    apiError(res, 500, 'Failed to configure payment provider', `HTTP_500`);
  }
});

// GET /api/platform/invoices - List invoices
router.get('/invoices', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data: invoices, error } = await supabase
      .from('invoices')
      .select(`
        *,
        stores (
          name,
          subdomain
        ),
        plans (
          display_name
        )
      `)
      .order('created_at', { ascending: false });

    if (error) throw error;
    sendSuccess(res, invoices);
  } catch (err) {
    logger.error('Failed to query invoices:', err.message);
    apiError(res, 500, 'Failed to retrieve invoices', `HTTP_500`);
  }
});

// GET /api/platform/store-transactions - List all store payment transactions
router.get('/store-transactions', verifyPlatformAdmin, async (req, res) => {
  const { store_id, payment_status, payment_method, limit = 100, offset = 0 } = req.query;
  
  try {
    let query = supabase
      .from('orders')
      .select(`
        id,
        order_number,
        total,
        subtotal,
        discount_amount,
        shipping_fee,
        payment_status,
        payment_method,
        paymob_order_id,
        paymob_transaction_id,
        transaction_id,
        payment_details,
        phone,
        city,
        created_at,
        stores!inner(
          id,
          name,
          subdomain
        )
      `)
      .order('created_at', { ascending: false })
      .range(parseInt(offset, 10), parseInt(offset, 10) + parseInt(limit, 10) - 1);

    if (store_id) query = query.eq('store_id', store_id);
    if (payment_status) query = query.eq('payment_status', payment_status);
    if (payment_method) query = query.eq('payment_method', payment_method);

    const { data: orders, error } = await query;
    if (error) throw error;

    sendSuccess(res, orders || []);
  } catch (err) {
    logger.error('Failed to query store transactions:', err.message);
    apiError(res, 500, 'Failed to retrieve store transactions', `HTTP_500`);
  }
});

// GET /api/platform/platform-billing-analytics - Platform MRR/ARR analytics
router.get('/platform-billing-analytics', verifyPlatformAdmin, async (req, res) => {
  try {
    // 1. Calculate MRR from active subscriptions
    const { data: activeSubs, error: subsErr } = await supabase
      .from('store_subscriptions')
      .select('plans ( price_monthly )')
      .eq('status', 'active');

    if (subsErr) throw subsErr;

    const mrr = (activeSubs || []).reduce((sum, sub) => {
      const price = sub.plans?.price_monthly || 0;
      return sum + parseFloat(price);
    }, 0);

    const arr = mrr * 12;

    // 2. Calculate Total Paid Revenue from invoices
    const { data: paidInvoices, error: invErr } = await supabase
      .from('invoices')
      .select('total')
      .eq('status', 'paid');

    if (invErr) throw invErr;

    const totalPaidRevenue = (paidInvoices || []).reduce((sum, inv) => sum + parseFloat(inv.total || 0), 0);

    sendSuccess(res, {
      mrr,
      arr,
      total_paid_revenue: totalPaidRevenue
    });
  } catch (err) {
    logger.error('Failed to generate platform billing analytics:', err.message);
    apiError(res, 500, 'Failed to generate billing analytics', `HTTP_500`);
  }
});

// GET /api/platform/transactions-analytics - Transaction analytics and metrics
router.get('/transactions-analytics', verifyPlatformAdmin, async (req, res) => {
  try {
    // Total revenue from all stores
    const { data: allOrders } = await supabase
      .from('orders')
      .select('total, payment_status, payment_method, created_at');

    const totalRevenue = (allOrders || [])
      .filter(o => o.payment_status === 'paid')
      .reduce((sum, o) => sum + parseFloat(o.total || 0), 0);
    const totalTransactions = (allOrders || []).length;
    console.log('--- DEBUG transactions-analytics ---');
    console.log('allOrders length:', (allOrders || []).length);
    console.log('totalTransactions:', totalTransactions);
    console.log('totalRevenue:', totalRevenue);

    // This month stats
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const { data: monthOrders } = await supabase
      .from('orders')
      .select('total, payment_status, payment_method')
      .gte('created_at', monthStart.toISOString());

    const monthlyRevenue = (monthOrders || [])
      .filter(o => o.payment_status === 'paid')
      .reduce((sum, o) => sum + parseFloat(o.total || 0), 0);
    const monthlyTransactions = (monthOrders || []).length;

    // Payment methods breakdown
    const paymentMethodsBreakdown = {};
    (allOrders || []).forEach(o => {
      const method = o.payment_method || 'unknown';
      if (!paymentMethodsBreakdown[method]) {
        paymentMethodsBreakdown[method] = { count: 0, revenue: 0 };
      }
      paymentMethodsBreakdown[method].count++;
      if (o.payment_status === 'paid') {
        paymentMethodsBreakdown[method].revenue += parseFloat(o.total || 0);
      }
    });

    // Top stores by revenue
    const { data: storeRevenues } = await supabase
      .from('orders')
      .select(`
        total,
        store_id,
        stores!inner(name, subdomain)
      `)
      .eq('payment_status', 'paid');

    const storeRevenueMap = {};
    (storeRevenues || []).forEach(o => {
      if (!storeRevenueMap[o.store_id]) {
        storeRevenueMap[o.store_id] = {
          store_id: o.store_id,
          store_name: o.stores.name,
          subdomain: o.stores.subdomain,
          revenue: 0,
          transactions: 0
        };
      }
      storeRevenueMap[o.store_id].revenue += parseFloat(o.total || 0);
      storeRevenueMap[o.store_id].transactions++;
    });

    const topStores = Object.values(storeRevenueMap)
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    sendSuccess(res, {
      overview: {
        total_revenue: totalRevenue,
        total_transactions: totalTransactions,
        monthly_revenue: monthlyRevenue,
        monthly_transactions: monthlyTransactions,
        average_order_value: totalTransactions > 0 ? totalRevenue / totalTransactions : 0
      },
      payment_methods: paymentMethodsBreakdown,
      top_stores: topStores
    });
  } catch (err) {
    logger.error('Failed to generate transaction analytics:', err.message);
    apiError(res, 500, 'Failed to generate analytics', `HTTP_500`);
  }
});

// POST /api/platform/invoices/:id/refund - Process manual refund
router.post('/invoices/:id/refund', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const { reason, amount } = req.body;

  try {
    // 1. Fetch invoice and payment
    const { data: invoice, error: invErr } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', id)
      .single();

    if (invErr || !invoice) return apiError(res, 404, 'Invoice not found', `HTTP_404`);
    if (invoice.status !== 'paid') return apiError(res, 400, 'Invoice must be in paid status to refund', `HTTP_400`);

    const { data: payment, error: payErr } = await supabase
      .from('payments')
      .select('*')
      .eq('invoice_id', id)
      .eq('status', 'completed')
      .limit(1)
      .maybeSingle();

    if (payErr || !payment) {
      return apiError(res, 400, 'No active payments found for this invoice', `HTTP_400`);
    }

    const refundAmount = amount === undefined || amount === null || amount === ''
      ? parseFloat(invoice.total)
      : parseFloat(amount);

    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return apiError(res, 400, 'Refund amount must be a positive number', `HTTP_400`);
    }

    const paidAmount = parseFloat(invoice.amount_paid || invoice.total || 0);
    if (refundAmount > paidAmount) {
      return apiError(res, 400, 'Refund amount cannot exceed paid amount', `HTTP_400`);
    }

    // 2. Call strategy gateway
    const { getPaymentAdapter } = require('../services/billingEngine');
    const adapter = await getPaymentAdapter(payment.payment_method);
    
    // Call refund adapter
    const gatewayResult = await adapter.refund(payment.gateway_reference || payment.id, refundAmount, reason);
    if (!gatewayResult.success) {
      return apiError(res, 400, 'Gateway failed to process refund: ' + gatewayResult.errorMsg, 'REFUND_GATEWAY_FAILED');
    }

    // 3. Log refund in database refunds table (Idempotent)
    const { error: refInsErr } = await supabase
      .from('refunds')
      .insert([{
        payment_id: payment.id,
        amount: refundAmount,
        reason: reason || 'Platform Admin Refund'
      }]);

    if (refInsErr) throw refInsErr;

    // 4. Update payments status
    await supabase
      .from('payments')
      .update({ status: 'refunded' })
      .eq('id', payment.id);

    // 5. Update invoices status
    await supabase
      .from('invoices')
      .update({
        status: refundAmount >= paidAmount ? 'refunded' : 'partially_paid',
        amount_paid: Math.max(0, paidAmount - refundAmount),
        updated_at: new Date().toISOString()
      })
      .eq('id', id);

    sendSuccess(res, { message: 'تم استرداد المبلغ بنجاح وتحديث السجلات' });
  } catch (err) {
    logger.error('Failed to refund invoice:', err.message);
    apiError(res, 500, 'Failed to process refund', `HTTP_500`);
  }
});


// ============================================================
// 10. Notification Template Control
// ============================================================

// GET /api/platform/notifications/preferences - Order/payment WhatsApp switches
router.get('/notifications/preferences', verifyPlatformAdmin, async (req, res) => {
  const storeId = String(req.query.store_id || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) return apiError(res, 400, 'store_id is required', `HTTP_400`);
  try {
    const { data, error } = await supabase
      .from('notification_preferences')
      .select('store_id, event_key, display_name, whatsapp_enabled, email_enabled, updated_at')
      .eq('store_id', storeId)
      .order('event_key');
    if (error) throw error;
    sendSuccess(res, data || []);
  } catch (err) {
    logger.error('Failed to load notification preferences:', err.message);
    apiError(res, 500, 'Failed to retrieve notification preferences', `HTTP_500`);
  }
});

// PATCH /api/platform/notifications/preferences/:eventKey - Toggle channels
router.patch('/notifications/preferences/:eventKey', verifyPlatformAdmin, async (req, res) => {
  const eventKey = String(req.params.eventKey || '').trim();
  const storeId = String(req.body?.store_id || '').trim();
  if (!/^[a-z0-9_]+$/.test(eventKey)) return apiError(res, 400, 'Invalid notification event', `HTTP_400`);
  if (!/^[0-9a-f-]{36}$/i.test(storeId)) return apiError(res, 400, 'store_id is required', `HTTP_400`);
  const payload = {};
  if (typeof req.body?.whatsapp_enabled === 'boolean') payload.whatsapp_enabled = req.body.whatsapp_enabled;
  if (typeof req.body?.email_enabled === 'boolean') payload.email_enabled = req.body.email_enabled;
  if (Object.keys(payload).length === 0) return apiError(res, 400, 'No channel setting provided', `HTTP_400`);
  payload.updated_at = new Date().toISOString();

  try {
    const { data, error } = await supabase
      .from('notification_preferences')
      .update(payload)
      .eq('store_id', storeId)
      .eq('event_key', eventKey)
      .select('store_id, event_key, display_name, whatsapp_enabled, email_enabled, updated_at')
      .maybeSingle();
    if (error) throw error;
    if (!data) return apiError(res, 404, 'Notification event not found. Apply migration 48 first.', `HTTP_404`);
    await auditPlatform(req, 'platform.notification_preference.update', 'notification_preference', eventKey, {}, data);
    sendSuccess(res, data);
  } catch (err) {
    logger.error('Failed to update notification preference:', err.message);
    apiError(res, 500, 'Failed to update notification preference', `HTTP_500`);
  }
});

// GET /api/platform/notifications/templates - List templates
router.get('/notifications/templates', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notification_templates')
      .select(`
        *,
        notification_layouts (
          id,
          name
        )
      `)
      .order('code', { ascending: true });

    if (error) throw error;
    sendSuccess(res, data);
  } catch (err) {
    logger.error('Failed to list templates:', err.message);
    apiError(res, 500, 'Failed to retrieve notification templates', `HTTP_500`);
  }
});

// POST /api/platform/notifications/templates - Save template details
router.post('/notifications/templates', verifyPlatformAdmin, async (req, res) => {
  const { id, code, channel, language, subject, body_html, body_text, layout_id, is_active } = req.body;
  if (!code || !channel || !body_html) {
    return apiError(res, 400, 'code, channel, and body_html are required', `HTTP_400`);
  }

  try {
    const payload = {
      code,
      channel,
      language: language || 'ar',
      subject,
      body_html,
      body_text,
      layout_id: layout_id || null,
      is_active: is_active !== undefined ? !!is_active : true,
      updated_at: new Date().toISOString()
    };

    let query;
    if (id) {
      query = supabase.from('notification_templates').update(payload).eq('id', id);
    } else {
      query = supabase.from('notification_templates').insert([payload]);
    }

    const { error } = await query;
    if (error) throw error;

    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to save notification template:', err.message);
    apiError(res, 500, 'Failed to save template', `HTTP_500`);
  }
});

// DELETE /api/platform/notifications/templates/:id - Delete a template
router.delete('/notifications/templates/:id', verifyPlatformAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('notification_templates').delete().eq('id', id);
    if (error) throw error;
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to delete notification template:', err.message);
    apiError(res, 500, 'Failed to delete template', `HTTP_500`);
  }
});

// GET /api/platform/notifications/layouts - List notification layouts
router.get('/notifications/layouts', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notification_layouts')
      .select('*')
      .order('name');

    if (error) throw error;
    sendSuccess(res, data);
  } catch (err) {
    logger.error('Failed to list layouts:', err.message);
    apiError(res, 500, 'Failed to retrieve notification layouts', `HTTP_500`);
  }
});

// POST /api/platform/notifications/layouts - Save layout
router.post('/notifications/layouts', verifyPlatformAdmin, async (req, res) => {
  const { id, name, header_html, footer_html, css } = req.body;
  if (!name) return apiError(res, 400, 'name is required', `HTTP_400`);

  try {
    const payload = {
      name,
      header_html,
      footer_html,
      css,
      updated_at: new Date().toISOString()
    };

    let query;
    if (id) {
      query = supabase.from('notification_layouts').update(payload).eq('id', id).select();
    } else {
      query = supabase.from('notification_layouts').insert([payload]).select();
    }

    const { data, error } = await query.single();
    if (error) throw error;

    sendSuccess(res, { id: data.id });
  } catch (err) {
    logger.error('Failed to save notification layout:', err.message);
    apiError(res, 500, 'Failed to save layout', `HTTP_500`);
  }
});

// DELETE /api/platform/notifications/layouts/:id - Delete a layout
router.delete('/notifications/layouts/:id', verifyPlatformAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('notification_layouts').delete().eq('id', id);
    if (error) throw error;
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to delete notification layout:', err.message);
    apiError(res, 500, 'Failed to delete layout', `HTTP_500`);
  }
});

// POST /api/platform/notifications/test-send - Test sending templates
router.post('/notifications/test-send', verifyPlatformAdmin, async (req, res) => {
  const { template_code, recipient, language, variables } = req.body;
  if (!template_code || !recipient) {
    return apiError(res, 400, 'template_code and recipient are required', `HTTP_400`);
  }

  try {
    const { sendNotification } = require('../services/notificationEngine');
    const results = await sendNotification({
      templateCode: template_code,
      recipient,
      language: language || 'ar',
      variables: variables || {}
    });

    sendSuccess(res, { results });
  } catch (err) {
    logger.error('Test notification delivery failed:', err.message);
    apiError(res, 500, 'Delivery test failed', `HTTP_500`);
  }
});

// GET /api/platform/notifications/history - List recent notification history
router.get('/notifications/history', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('notification_history')
      .select(`
        id,
        recipient,
        channel,
        status,
        provider,
        error_message,
        sent_at,
        notification_templates(code)
      `)
      .order('sent_at', { ascending: false })
      .limit(100);

    if (error) throw error;
    sendSuccess(res, data);
  } catch (err) {
    logger.error('Failed to list notification history:', err.message);
    apiError(res, 500, 'Failed to retrieve notification history', `HTTP_500`);
  }
});

// ============================================================
// 12. Login Logs & Blocked IPs
// ============================================================

// GET /api/platform/login-logs
router.get('/login-logs', verifyPlatformAdmin, async (req, res) => {
  try {
    const requestedPage = Number.parseInt(req.query.page, 10);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const page = Number.isFinite(requestedPage) ? Math.max(requestedPage, 1) : 1;
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 20;
    const filter = req.query.filter || 'all';
    const store_id = req.query.store_id;
    const search = sanitizeIlikeTerm(req.query.search);

    let query = supabase
      .from('user_login_logs')
      .select('*, stores(name)', { count: 'exact' });

    if (store_id) {
      query = query.eq('store_id', store_id);
    }

    if (filter === 'guest') {
      query = query.eq('login_method', 'guest');
    } else if (filter === 'registered') {
      query = query.neq('login_method', 'guest');
    }
    if (search) query = query.or(`email.ilike.%${search}%,ip_address.ilike.%${search}%,user_id.ilike.%${search}%`);

    const { data: logs, count, error } = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    const formattedLogs = logs.map(log => ({
      ...log,
      store_name: log.stores?.name || 'Platform'
    }));

    sendSuccess(res, { logs: formattedLogs, total: count || 0 });
  } catch (err) {
    logger.error('Failed to fetch login logs:', err.message);
    apiError(res, 500, 'Failed to fetch login logs', `HTTP_500`);
  }
});

// DELETE /api/platform/login-logs/:id
router.delete('/login-logs/:id', verifyPlatformAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('user_login_logs').delete().eq('id', req.params.id);
    if (error) throw error;
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to delete login log:', err.message);
    apiError(res, 500, 'Failed to delete log', `HTTP_500`);
  }
});

// DELETE /api/platform/login-logs
router.delete('/login-logs', verifyPlatformAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('user_login_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw error;
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to clear login logs:', err.message);
    apiError(res, 500, 'Failed to clear logs', `HTTP_500`);
  }
});

// GET /api/platform/blocked-ips
router.get('/blocked-ips', verifyPlatformAdmin, async (req, res) => {
  try {
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const requestedOffset = Number.parseInt(req.query.offset, 10);
    const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
    const offset = Number.isFinite(requestedOffset) ? Math.max(requestedOffset, 0) : 0;
    let query = supabase.from('blocked_ips').select('*', { count: 'exact' }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
    if (typeof req.query.search === 'string' && req.query.search.trim()) {
      const search = sanitizeIlikeTerm(req.query.search);
      query = query.ilike('ip_address', `%${search}%`);
    }
    const { data: ips, count, error } = await query;
    if (error) throw error;
    sendSuccess(res, { ips: ips || [], total: count || 0, limit, offset });
  } catch (err) {
    logger.error('Failed to fetch blocked IPs:', err.message);
    apiError(res, 500, 'Failed to fetch blocked IPs', `HTTP_500`);
  }
});

// POST /api/platform/blocked-ips/block
router.post('/blocked-ips/block', verifyPlatformAdmin, async (req, res) => {
  try {
    const ip_address = typeof req.body?.ip_address === 'string' ? req.body.ip_address.trim() : '';
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    if (!ip_address) return apiError(res, 400, 'IP is required', `HTTP_400`);
    const ipPattern = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9a-f:]+)(?:\/\d{1,3})?$/i;
    if (!ipPattern.test(ip_address)) return apiError(res, 400, 'Invalid IP address', `HTTP_400`);

    const { data: existing } = await supabase.from('blocked_ips').select('id').eq('ip_address', ip_address).maybeSingle();
    const { error } = existing
      ? await supabase.from('blocked_ips').update({ reason: reason || 'Blocked by platform admin', blocked_by: req.user.sub }).eq('id', existing.id)
      : await supabase.from('blocked_ips').insert({
      ip_address,
      reason: reason || 'Blocked by platform admin',
      blocked_by: req.user.sub
    });

    if (error) throw error;
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to block IP:', err.message);
    apiError(res, 500, 'Failed to block IP', `HTTP_500`);
  }
});

// POST /api/platform/blocked-ips/unblock
router.post('/blocked-ips/unblock', verifyPlatformAdmin, async (req, res) => {
  try {
    const ip_address = typeof req.body?.ip_address === 'string' ? req.body.ip_address.trim() : '';
    if (!ip_address) return apiError(res, 400, 'IP is required', `HTTP_400`);

    const { error } = await supabase.from('blocked_ips').delete().eq('ip_address', ip_address);
    if (error) throw error;
    sendSuccess(res, {});
  } catch (err) {
    logger.error('Failed to unblock IP:', err.message);
    apiError(res, 500, 'Failed to unblock IP', `HTTP_500`);
  }
});

module.exports = router;
