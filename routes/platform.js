const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { supabase } = require('../services/supabase');
const { verifyPlatformAdmin, verifyPlatformPermission } = require('../middleware/platformAdmin');
const logger = require('../utils/logger');
const { encryptCredentials, decryptCredentials, getEncryptionKeyForVersion } = require('../utils/crypto');
const { sanitizeThemeOverrides } = require('../services/themeSettingsService');

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
    res.json({ success: true, items: data || [] });
  } catch (err) {
    logger.error('Platform themes load failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to load platform themes.' });
  }
});

router.post('/themes', async (req, res) => {
  try {
    const payload = normalizeThemePayload(req.body);
    const { data, error } = await supabase.from('platform_themes').insert(payload).select().single();
    if (error) throw error;
    await auditPlatform(req, 'platform.themes.create', 'platform_theme', data.id, {}, data);
    res.status(201).json({ success: true, item: data });
  } catch (err) {
    logger.error('Platform theme create failed:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.statusCode ? err.message : 'Unable to create platform theme.' });
  }
});

router.put('/themes/:id', async (req, res) => {
  try {
    const payload = normalizeThemePayload(req.body);
    const { data: before, error: beforeError } = await supabase.from('platform_themes').select('*').eq('id', req.params.id).maybeSingle();
    if (beforeError) throw beforeError;
    if (!before) return res.status(404).json({ success: false, error: 'Theme not found.' });
    const { data, error } = await supabase.from('platform_themes').update(payload).eq('id', req.params.id).select().single();
    if (error) throw error;
    await auditPlatform(req, 'platform.themes.update', 'platform_theme', data.id, before, data);
    res.json({ success: true, item: data });
  } catch (err) {
    logger.error('Platform theme update failed:', err.message);
    res.status(err.statusCode || 500).json({ success: false, error: err.statusCode ? err.message : 'Unable to update platform theme.' });
  }
});

router.post('/themes/:id/toggle-publish', async (req, res) => {
  try {
    const { data: before, error: beforeError } = await supabase.from('platform_themes').select('*').eq('id', req.params.id).maybeSingle();
    if (beforeError) throw beforeError;
    if (!before) return res.status(404).json({ success: false, error: 'Theme not found.' });
    const { data, error } = await supabase.from('platform_themes').update({ is_published: !before.is_published }).eq('id', req.params.id).select().single();
    if (error) throw error;
    await auditPlatform(req, 'platform.themes.publish', 'platform_theme', data.id, before, data);
    res.json({ success: true, item: data });
  } catch (err) {
    logger.error('Platform theme publish toggle failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to update platform theme.' });
  }
});

router.delete('/themes/:id', async (req, res) => {
  try {
    const { data: before, error: beforeError } = await supabase.from('platform_themes').select('*').eq('id', req.params.id).maybeSingle();
    if (beforeError) throw beforeError;
    if (!before) return res.status(404).json({ success: false, error: 'Theme not found.' });
    const { error } = await supabase.from('platform_themes').delete().eq('id', req.params.id);
    if (error) throw error;
    await auditPlatform(req, 'platform.themes.delete', 'platform_theme', req.params.id, before, {});
    res.json({ success: true });
  } catch (err) {
    logger.error('Platform theme delete failed:', err.message);
    res.status(500).json({ success: false, error: 'Unable to delete platform theme.' });
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
  if (!table) return res.status(404).json({ success: false, error: 'Unknown platform resource' });

  try {
    let query = supabase.from(table).select('*').order('created_at', { ascending: false });
    if (req.params.resource === 'suspensions') {
      query = supabase.from(table).select('*, store:stores(name)').order('created_at', { ascending: false });
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, items: data || [] });
  } catch (err) {
    logger.error(`Platform resource load failed (${req.params.resource}):`, err.message);
    res.status(500).json({ success: false, error: 'Unable to load platform resource' });
  }
});

router.post('/resources/:resource', verifyPlatformAdmin, async (req, res) => {
  const table = platformResourceTables[req.params.resource];
  if (!table) return res.status(404).json({ success: false, error: 'Unknown platform resource' });

  try {
    const { data, error } = await supabase.from(table).insert([req.body]).select();
    if (error) throw error;
    await auditPlatform(req, `platform.${req.params.resource}.create`, req.params.resource, data?.[0]?.id);
    res.json({ success: true, item: data?.[0] || null });
  } catch (err) {
    logger.error(`Platform resource create failed (${req.params.resource}):`, err.message);
    res.status(500).json({ success: false, error: 'Unable to create platform resource' });
  }
});

router.patch('/resources/:resource/:id', verifyPlatformAdmin, async (req, res) => {
  const table = platformResourceTables[req.params.resource];
  if (!table) return res.status(404).json({ success: false, error: 'Unknown platform resource' });

  try {
    const { data: oldData } = await supabase.from(table).select('*').eq('id', req.params.id).maybeSingle();
    const { data, error } = await supabase.from(table).update(req.body).eq('id', req.params.id).select();
    if (error) throw error;
    await auditPlatform(req, `platform.${req.params.resource}.update`, req.params.resource, req.params.id, oldData, data?.[0]);
    res.json({ success: true, item: data?.[0] || null });
  } catch (err) {
    logger.error(`Platform resource update failed (${req.params.resource}):`, err.message);
    res.status(500).json({ success: false, error: 'Unable to update platform resource' });
  }
});

router.delete('/resources/:resource/:id', verifyPlatformAdmin, async (req, res) => {
  const table = platformResourceTables[req.params.resource];
  if (!table) return res.status(404).json({ success: false, error: 'Unknown platform resource' });

  try {
    const { data: oldData } = await supabase.from(table).select('*').eq('id', req.params.id).maybeSingle();
    const { error } = await supabase.from(table).delete().eq('id', req.params.id);
    if (error) throw error;
    await auditPlatform(req, `platform.${req.params.resource}.delete`, req.params.resource, req.params.id, oldData);
    res.json({ success: true });
  } catch (err) {
    logger.error(`Platform resource delete failed (${req.params.resource}):`, err.message);
    res.status(500).json({ success: false, error: 'Unable to delete platform resource' });
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
    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    if (!order.user_id) return res.json({ success: true, address: null });

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

    res.json({ success: true, address: data?.[0] || null });
  } catch (err) {
    logger.error(`Platform order address load failed (${req.params.orderId}):`, err.message);
    res.status(500).json({ success: false, error: 'Unable to load customer address' });
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
    res.json(settings);
  } catch (err) {
    logger.error('Failed to get system settings:', err.message);
    res.status(500).json({ error: 'Failed to retrieve system settings' });
  }
});

// 2. POST /api/platform/settings - Update global settings
router.post('/settings', verifyPlatformAdmin, async (req, res) => {
  const { settings } = req.body;
  if (!settings || typeof settings !== 'object') {
    return res.status(400).json({ error: 'settings object is required' });
  }

  try {
    const upserts = Object.keys(settings).map(key => ({
      key,
      value: settings[key].toString(),
      updated_at: new Date().toISOString()
    }));

    const { error } = await supabase.from('system_settings').upsert(upserts, { onConflict: 'key' });
    if (error) throw error;

    await auditPlatform(req, 'platform.settings.update', 'system_setting', 'global', null, settings, null);

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

    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to update system settings:', err.message);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// 2.5. POST /api/platform/settings/test-smtp - Test SMTP configuration
router.post('/settings/test-smtp', verifyPlatformAdmin, async (req, res) => {
  try {
    const { host, port, secure, user, pass, recipient } = req.body;
    if (!host || !user || !pass || !recipient) {
      return res.status(400).json({ error: 'Missing required SMTP parameters' });
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

    res.json({ success: true, message: 'Test email sent successfully' });
  } catch (err) {
    logger.error('Failed to send test email:', err.message);
    res.status(500).json({ success: false, error: 'Failed to send test email: ' + err.message });
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
    res.json(plans);
  } catch (err) {
    logger.error('Failed to retrieve plans:', err.message);
    res.status(500).json({ error: 'Failed to retrieve plans' });
  }
});

// 4. POST /api/platform/plans - Create or update subscription plan and limits
router.post('/plans', verifyPlatformAdmin, async (req, res) => {
  const { code, display_name, price_monthly, price_yearly, trial_days, trial_enabled, sort_order, features } = req.body;
  if (!code || !display_name) {
    return res.status(400).json({ error: 'code and display_name are required' });
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

    if (features && Array.isArray(features)) {
      for (const feat of features) {
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

        // Wipe old limits to prevent orphans when types change
        await supabase.from('feature_limits').delete().eq('plan_feature_id', planFeat.id);

        if (feat.limits && Array.isArray(feat.limits)) {
          for (const lim of feat.limits) {
            const { error: limitErr } = await supabase
              .from('feature_limits')
              .upsert({
                plan_feature_id: planFeat.id,
                limit_type: lim.limit_type,
                limit_config: lim.limit_config
              }, { onConflict: 'plan_feature_id,limit_type' });

            if (limitErr) throw limitErr;
          }
        }
      }
    }

    await auditPlatform(req, 'platform.plan.update', 'plan', plan.id, null, { code, display_name, features }, null);

    res.json({ success: true, plan });
  } catch (err) {
    logger.error('Failed to save SaaS plan:', err);
    res.status(500).json({ error: 'Failed to save plan' });
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

    res.json(formatted);
  } catch (err) {
    logger.error('Failed to retrieve platform stores:', err.message);
    res.status(500).json({ error: 'Failed to retrieve stores' });
  }
});

router.post('/stores', verifyPlatformAdmin, async (req, res) => {
  const { name, subdomain, custom_domain, subscription_expires_at, is_active = true, plan_id } = req.body;
  const cleanSubdomain = (subdomain || '').trim().toLowerCase();
  const cleanDomain = normalizeDomain(custom_domain);

  if (!name?.trim() || !cleanSubdomain || !subscription_expires_at) {
    return res.status(400).json({ error: 'name, subdomain, and subscription_expires_at are required' });
  }

  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(cleanSubdomain)) {
    return res.status(400).json({ error: 'Invalid subdomain format' });
  }

  try {
    const { data: existingStore } = await supabase
      .from('stores')
      .select('id')
      .eq('subdomain', cleanSubdomain)
      .maybeSingle();

    if (existingStore) {
      return res.status(409).json({ error: 'Subdomain is already assigned to another store' });
    }

    if (cleanDomain) {
      const { data: existingDomain } = await supabase
        .from('custom_domains')
        .select('id, store_id')
        .eq('domain', cleanDomain)
        .maybeSingle();

      if (existingDomain) {
        return res.status(409).json({ error: 'Custom domain is already assigned to another tenant' });
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
      store_description: 'New tenant store on EGParts Cloud',
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
    res.status(201).json({ success: true, store });
  } catch (err) {
    logger.error('Failed to create platform store:', err);
    res.status(500).json({ error: 'Failed to create store' });
  }
});

router.patch('/stores/:id', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, custom_domain, subscription_expires_at, is_active, plan_id, status } = req.body;
  const cleanDomain = normalizeDomain(custom_domain);

  try {
    const { data: oldStore, error: oldError } = await supabase
      .from('stores')
      .select('*')
      .eq('id', id)
      .maybeSingle();
    if (oldError || !oldStore) return res.status(404).json({ error: 'Store not found' });

    if (cleanDomain && cleanDomain !== normalizeDomain(oldStore.custom_domain)) {
      const { data: existingDomain } = await supabase
        .from('custom_domains')
        .select('id, store_id')
        .eq('domain', cleanDomain)
        .neq('store_id', id)
        .maybeSingle();
      if (existingDomain) return res.status(409).json({ error: 'Custom domain is already assigned to another tenant' });
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

    await auditPlatform(req, 'platform.store.update', 'store', id, oldStore, store, id);
    res.json({ success: true, store });
  } catch (err) {
    logger.error('Failed to update platform store:', err);
    res.status(500).json({ error: 'Failed to update store' });
  }
});

router.post('/stores/:id/suspend', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const reason = req.body?.reason || 'Suspended by Platform Owner';
  try {
    const { data: oldStore } = await supabase.from('stores').select('*').eq('id', id).maybeSingle();
    if (!oldStore) return res.status(404).json({ error: 'Store not found' });

    const { data: store, error } = await supabase
      .from('stores')
      .update({ is_active: false, status: 'suspended', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    await supabase.from('store_subscriptions').update({ status: 'suspended', updated_at: new Date().toISOString() }).eq('store_id', id);
    await auditPlatform(req, 'platform.store.suspend', 'store', id, oldStore, { ...store, reason }, id);
    res.json({ success: true, store });
  } catch (err) {
    logger.error('Failed to suspend store:', err.message);
    res.status(500).json({ error: 'Failed to suspend store' });
  }
});

router.post('/stores/:id/recover', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: oldStore } = await supabase.from('stores').select('*').eq('id', id).maybeSingle();
    if (!oldStore) return res.status(404).json({ error: 'Store not found' });

    const { data: store, error } = await supabase
      .from('stores')
      .update({ is_active: true, status: 'active', updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    await supabase.from('store_subscriptions').update({ status: 'active', updated_at: new Date().toISOString() }).eq('store_id', id);
    await auditPlatform(req, 'platform.store.recover', 'store', id, oldStore, store, id);
    res.json({ success: true, store });
  } catch (err) {
    logger.error('Failed to recover store:', err.message);
    res.status(500).json({ error: 'Failed to recover store' });
  }
});

router.delete('/stores/:id', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: oldStore } = await supabase.from('stores').select('*').eq('id', id).maybeSingle();
    if (!oldStore) return res.status(404).json({ error: 'Store not found' });

    const { data: store, error } = await supabase
      .from('stores')
      .update({ is_active: false, status: 'deleted', deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;

    await auditPlatform(req, 'platform.store.delete_soft', 'store', id, oldStore, store, id);
    res.json({ success: true, store });
  } catch (err) {
    logger.error('Failed to delete store:', err.message);
    res.status(500).json({ error: 'Failed to delete store' });
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
        supabase.from('feature_usage').select('used').eq('store_id', store.id).eq('feature_key', 'otp.whatsapp.monthly').gte('period_start', monthStart.toISOString())
      ]);

      metrics.push({
        ...store,
        orders_this_month: ordersRes.count || 0,
        delivered_this_month: deliveredRes.count || 0,
        sales_this_month: (ordersRes.data || []).reduce((sum, order) => sum + Number(order.total || 0), 0),
        products_count: productsRes.count || 0,
        otp_usage_this_month: (otpRes.data || []).reduce((sum, row) => sum + Number(row.used || 0), 0),
        plan: store.store_subscriptions?.plans || null,
        plan_id: store.store_subscriptions?.plan_id || null,
        subscription_status: store.store_subscriptions?.status || null
      });
    }

    res.json(metrics);
  } catch (err) {
    logger.error('Failed to retrieve tenant metrics:', err.message);
    res.status(500).json({ error: 'Failed to retrieve tenant metrics' });
  }
});

router.get('/users', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data: profiles, error } = await supabase
      .from('user_profiles')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;

    const allUserIds = (profiles || []).map(u => u.user_id).filter(Boolean);

    let userStoresMap = new Map();
    let namesByUserId = new Map();

    if (allUserIds.length > 0) {
      // Get orders to extract names and customer store associations
      const { data: orders } = await supabase
        .from('orders')
        .select('user_id, store_id, full_name, stores(id, name)')
        .in('user_id', allUserIds);

      (orders || []).forEach((order) => {
        if (order.user_id) {
          if (order.full_name && !namesByUserId.has(order.user_id)) {
            namesByUserId.set(order.user_id, order.full_name);
          }
          if (order.store_id && order.stores) {
            if (!userStoresMap.has(order.user_id)) {
              userStoresMap.set(order.user_id, new Map());
            }
            // Use store_id as map key to ensure uniqueness
            userStoresMap.get(order.user_id).set(order.store_id, order.stores);
          }
        }
      });

      // Get user_roles to capture admin/staff store associations
      const { data: userRoles } = await supabase
        .from('user_roles')
        .select('user_id, store_id, stores(id, name)')
        .in('user_id', allUserIds);
      
      (userRoles || []).forEach((ur) => {
        if (ur.user_id && ur.store_id && ur.stores) {
          if (!userStoresMap.has(ur.user_id)) {
            userStoresMap.set(ur.user_id, new Map());
          }
          userStoresMap.get(ur.user_id).set(ur.store_id, ur.stores);
        }
      });
    }

    const users = (profiles || []).map((user) => {
      const storesMap = userStoresMap.get(user.user_id);
      const stores = storesMap ? Array.from(storesMap.values()) : [];
      return {
        ...user,
        full_name: user.full_name || namesByUserId.get(user.user_id) || user.full_name,
        stores
      };
    });

    res.json({ success: true, users });
  } catch (err) {
    logger.error('Platform users list failed:', err.message);
    res.status(500).json({ error: 'Failed to load users' });
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

    res.json({ success: true, users: adminUsers });
  } catch (err) {
    logger.error('Platform admin users list failed:', err.message);
    res.status(500).json({ error: 'Failed to load admin users' });
  }
});

router.get('/users/:user_id/addresses', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('user_addresses')
      .select('*')
      .eq('user_id', req.params.user_id);

    if (error) throw error;
    res.json({ success: true, addresses: data || [] });
  } catch (err) {
    logger.error('Platform user addresses failed:', err.message);
    res.status(500).json({ error: 'Failed to load user addresses' });
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
    res.json({ success: true });
  } catch (err) {
    logger.error('Platform user ban failed:', err.message);
    res.status(500).json({ error: 'Failed to ban user' });
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
    res.json({ success: true });
  } catch (err) {
    logger.error('Platform user unban failed:', err.message);
    res.status(500).json({ error: 'Failed to unban user' });
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
      return res.status(404).json({ error: 'User not found' });
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

    res.json({ success: true, user: detail });
  } catch (err) {
    logger.error('Platform user detail failed:', err.message);
    res.status(500).json({ error: 'Failed to load user details' });
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

    res.json({ success: true, message: 'Admin privileges removed successfully' });
  } catch (err) {
    logger.error('Platform user admin removal failed:', err.message);
    res.status(500).json({ error: 'Failed to remove admin privileges' });
  }
});

// Impersonation Endpoints
router.post('/impersonate/start', verifyPlatformAdmin, async (req, res) => {
  const { store_id, reason } = req.body;
  if (!store_id || !reason) {
    return res.status(400).json({ error: 'store_id and reason are required' });
  }

  try {
    const admin_id = req.user.id;
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
    res.json({ success: true, session_token: session.session_token, store_id });
  } catch (err) {
    logger.error('Failed to start impersonation:', err.message);
    res.status(500).json({ error: 'Failed to start impersonation' });
  }
});

router.post('/impersonate/stop', verifyPlatformAdmin, async (req, res) => {
  const { session_token } = req.body;
  if (!session_token) {
    return res.status(400).json({ error: 'session_token is required' });
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
    res.json({ success: true, message: 'Impersonation ended successfully' });
  } catch (err) {
    logger.error('Failed to stop impersonation:', err.message);
    res.status(500).json({ error: 'Failed to stop impersonation' });
  }
});

// Scoped Ban Endpoints
router.post('/users/ban', verifyPlatformAdmin, async (req, res) => {
  const { user_id, store_id, ban_scope, ban_type, reason, is_temporary, banned_until } = req.body;
  if (!user_id || !reason) {
    return res.status(400).json({ error: 'user_id and reason are required' });
  }

  try {
    const admin_id = req.user.id;
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
    res.json({ success: true, banLog });
  } catch (err) {
    logger.error('Failed to ban user:', err.message);
    res.status(500).json({ error: 'Failed to ban user' });
  }
});

router.post('/users/unban', verifyPlatformAdmin, async (req, res) => {
  const { ban_log_id, store_id, user_id } = req.body;
  if (!ban_log_id) {
    return res.status(400).json({ error: 'ban_log_id is required' });
  }

  try {
    const admin_id = req.user.id;
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
    res.json({ success: true, banLog });
  } catch (err) {
    logger.error('Failed to unban user:', err.message);
    res.status(500).json({ error: 'Failed to unban user' });
  }
});

router.post('/impersonation/start', verifyPlatformAdmin, async (req, res) => {
  const { store_id } = req.body;
  if (!store_id) return res.status(400).json({ error: 'store_id is required' });

  try {
    const { data: store, error } = await supabase
      .from('stores')
      .select('id, name, subdomain, custom_domain, is_active, status, subscription_expires_at')
      .eq('id', store_id)
      .maybeSingle();
    if (error || !store) return res.status(404).json({ error: 'Store not found' });

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
    res.json({ success: true, token, store, expires_in: IMPERSONATION_TTL_SECONDS, audit_id: auditId });
  } catch (err) {
    logger.error('Failed to start impersonation:', err.message);
    res.status(500).json({ error: 'Failed to start impersonation' });
  }
});

router.post('/impersonation/end', verifyPlatformAdmin, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });

  try {
    const decoded = jwt.verify(token, process.env.DATABASE_ENCRYPTION_KEY);
    if (decoded.typ !== 'platform_impersonation' || decoded.platform_user_id !== req.user.sub) {
      return res.status(403).json({ error: 'Invalid impersonation token' });
    }

    await supabase
      .from('impersonation_logs')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', decoded.jti)
      .eq('super_admin_id', req.user.sub);

    await auditPlatform(req, 'platform.impersonation.end', 'store', decoded.store_id, {}, { audit_id: decoded.jti }, decoded.store_id);
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to end impersonation:', err.message);
    res.status(400).json({ error: 'Invalid or expired impersonation token' });
  }
});

router.post('/impersonation/session', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });

  try {
    const decoded = jwt.verify(token, process.env.DATABASE_ENCRYPTION_KEY);
    if (decoded.typ !== 'platform_impersonation') {
      return res.status(403).json({ error: 'Invalid impersonation token' });
    }

    const { data: store, error } = await supabase
      .from('stores')
      .select('*')
      .eq('id', decoded.store_id)
      .maybeSingle();
    if (error || !store) return res.status(404).json({ error: 'Store not found' });

    res.json({ success: true, store, audit_id: decoded.jti });
  } catch (err) {
    res.status(400).json({ error: 'Invalid or expired impersonation token' });
  }
});


router.post('/stores/subscription', verifyPlatformAdmin, async (req, res) => {
  const { store_id, plan_id, status, expires_at } = req.body;
  if (!store_id || !plan_id || !expires_at) {
    return res.status(400).json({ error: 'store_id, plan_id, and expires_at are required' });
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

    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to update tenant subscription:', err.message);
    res.status(500).json({ error: 'Failed to update subscription' });
  }
});

// 6. GET /api/platform/audit-logs - Retrieve global audit logs
router.get('/audit-logs', verifyPlatformAdmin, async (req, res) => {
  const { store_id, action, search, limit = 50, offset = 0 } = req.query;
  try {
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
      .range(parseInt(offset, 10), parseInt(offset, 10) + parseInt(limit, 10) - 1);

    if (store_id) query = query.eq('store_id', store_id);
    if (action) query = query.eq('action', action);
    if (search) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(search);
      if (isUuid) {
        query = query.or(`ip_address.ilike.%${search}%,user_id.eq.${search},entity_id.eq.${search}`);
      } else {
        query = query.or(`ip_address.ilike.%${search}%,entity_id.ilike.%${search}%`);
      }
    }

    const { data: logs, count, error } = await query;
    if (error) throw error;

    res.json({ data: logs, total: count || 0 });
  } catch (err) {
    logger.error('Failed to query platform audit logs:', err.message);
    res.status(500).json({ error: 'Failed to retrieve global audit logs' });
  }
});

// DELETE /api/platform/audit-logs - Purge global audit logs
router.delete('/audit-logs', verifyPlatformAdmin, async (req, res) => {
  const { mode, days } = req.body;
  
  try {
    let query = supabase.from('audit_logs').delete();
    
    if (mode === 'older_than' && typeof days === 'number') {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      query = query.lt('created_at', cutoff.toISOString());
    } else if (mode === 'all') {
      query = query.neq('id', '00000000-0000-0000-0000-000000000000'); // Supabase requires a filter for deletes
    } else {
      return res.status(400).json({ error: 'Invalid purge mode' });
    }
    
    const { error } = await query;
    if (error) throw error;
    
    await auditPlatform(req, 'platform.audit_logs.purge', 'system', 'global', null, { mode, days });
    res.json({ success: true, message: 'تم تنظيف السجلات بنجاح' });
  } catch (err) {
    logger.error('Failed to purge audit logs:', err.message);
    res.status(500).json({ error: 'Failed to purge audit logs' });
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
    res.json(invitations);
  } catch (err) {
    logger.error('Failed to list invitations:', err.message);
    res.status(500).json({ error: 'Failed to retrieve invitations' });
  }
});

// POST /api/platform/invitations - Create owner invitation (via email/WhatsApp)
router.post('/invitations', verifyPlatformAdmin, async (req, res) => {
  const { email, phone, store_id, role_id } = req.body;
  if ((!phone && !email) || !store_id) {
    return res.status(400).json({ error: 'Please provide either email or phone, and a valid store_id' });
  }

  try {
    let targetRoleId = role_id;
    if (!targetRoleId) {
      targetRoleId = await ensureOwnerTemplateRole();
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48 hours expiry

    const { data: invitation, error } = await supabase
      .from('tenant_invitations')
      .insert([{
        email: email ? email.trim().toLowerCase() : null,
        phone: phone ? phone.trim() : null,
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

    // Send invitation link via WhatsApp if phone is provided
    if (phone && phone.trim()) {
      const { sendNotification } = require('../services/notificationEngine');
      const activationLink = `${process.env.FRONTEND_URL || 'https://egparts.store'}/accept-invitation?token=${token}`;

      sendNotification({
        channel: 'whatsapp',
        recipient: phone.trim(),
        variables: {
          activation_link: activationLink,
          expires_hours: 48,
          phone: phone.trim()
        },
        bodyText: `مرحباً!\n\nتم دعوتك لتصبح مدير متجر على منصة EG-PARTS Cloud.\n\nرابط التفعيل:\n${activationLink}\n\nصلاحية الرابط: 48 ساعة\n\nEG-PARTS Cloud`
      }).catch(err => logger.error('Failed to send invitation WhatsApp in background:', err));
    }

    res.json({ success: true, invitation });
  } catch (err) {
    logger.error('Failed to create invitation:', err.message);
    res.status(500).json({ error: 'Failed to create invitation' });
  }
});

// POST /api/platform/invitations/:id/resend - Resend invitation
router.post('/invitations/:id/resend', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { data: invite, error: fetchErr } = await supabase
      .from('tenant_invitations')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchErr || !invite) {
      return res.status(404).json({ error: 'Invitation not found' });
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

    const { sendNotification } = require('../services/notificationEngine');
    const activationLink = `${process.env.FRONTEND_URL || 'https://egparts.store'}/accept-invitation?token=${token}`;
    
    // Run in background - send via WhatsApp to phone
    sendNotification({
      channel: 'whatsapp',
      recipient: invite.phone,
      variables: {
        activation_link: activationLink,
        expires_hours: 48,
        phone: invite.phone
      },
      bodyText: `مرحباً!\n\nتم إعادة إرسال دعوتك لتصبح مدير متجر على منصة EG-PARTS Cloud.\n\nرابط التفعيل:\n${activationLink}\n\nصلاحية الرابط: 48 ساعة\n\nEG-PARTS Cloud`
    }).catch(err => logger.error('Failed to resend invitation WhatsApp in background:', err));

    res.json({ success: true, invitation: updated });
  } catch (err) {
    logger.error('Failed to resend invitation:', err.message);
    res.status(500).json({ error: 'Failed to resend invitation' });
  }
});

// POST /api/platform/invitations/:id/revoke - Revoke invitation
router.post('/invitations/:id/revoke', verifyPlatformAdmin, async (req, res) => {
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
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to revoke invitation:', err.message);
    res.status(500).json({ error: 'Failed to revoke invitation' });
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
    
    res.json({ success: true, message: `Deleted ${data ? data.length : 0} inactive invitations`, count: data ? data.length : 0 });
  } catch (err) {
    logger.error('Failed to cleanup invitations:', err.message);
    res.status(500).json({ error: 'Failed to cleanup invitations' });
  }
});

// DELETE /api/platform/invitations/:id - Delete invitation completely
router.delete('/invitations/:id', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { error } = await supabase
      .from('tenant_invitations')
      .delete()
      .eq('id', id);

    if (error) throw error;
    
    // Optional audit log for complete destruction
    await auditPlatform(req, 'platform.invitation.delete', 'tenant_invitation', id, { id }, null);
    
    res.json({ success: true, message: 'Invitation deleted permanently' });
  } catch (err) {
    logger.error('Failed to delete invitation:', err.message);
    res.status(500).json({ error: 'Failed to delete invitation' });
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
    res.json(domains);
  } catch (err) {
    logger.error('Failed to list custom domains:', err.message);
    res.status(500).json({ error: 'Failed to retrieve custom domains' });
  }
});

// POST /api/platform/domains - Create custom domain link
router.post('/domains', verifyPlatformAdmin, async (req, res) => {
  const { store_id, domain, is_primary } = req.body;
  if (!store_id || !domain) {
    return res.status(400).json({ error: 'store_id and domain are required' });
  }

  try {
    const cleanDomain = normalizeDomain(domain);
    const { data: existingDomain } = await supabase
      .from('custom_domains')
      .select('id, store_id')
      .eq('domain', cleanDomain)
      .maybeSingle();

    if (existingDomain) {
      return res.status(409).json({ error: 'Domain is already assigned to another tenant. Remove the old binding before linking it again.' });
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
    res.json({ success: true, domain: newDomain });
  } catch (err) {
    logger.error('Failed to configure custom domain:', err.message);
    res.status(500).json({ error: 'Failed to configure custom domain' });
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
      return res.status(404).json({ error: 'Domain not found' });
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
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to update primary domain:', err.message);
    res.status(500).json({ error: 'Failed to update primary domain' });
  }
});

// POST /api/platform/domains/:id/verify - Trigger immediate manual validation
router.post('/domains/:id/verify', verifyPlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { runDomainCheck } = require('../services/domainValidator');
    await runDomainCheck(id);
    res.json({ success: true });
  } catch (err) {
    logger.error('Manual domain check failed:', err.message);
    res.status(500).json({ error: 'Failed to verify custom domain' });
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
    res.json(logs);
  } catch (err) {
    logger.error('Failed to fetch domain check logs:', err.message);
    res.status(500).json({ error: 'Failed to retrieve check logs' });
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
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete custom domain:', err.message);
    res.status(500).json({ error: 'Failed to delete custom domain' });
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

    res.json(masked);
  } catch (err) {
    logger.error('Failed to list payment providers:', err.message);
    res.status(500).json({ error: 'Failed to retrieve payment providers' });
  }
});

// POST /api/platform/payment-providers - Upsert/Configure provider details
router.post('/payment-providers', verifyPlatformAdmin, async (req, res) => {
  const { code, display_name, enabled, sandbox, configuration, priority } = req.body;
  if (!code || !display_name) {
    return res.status(400).json({ error: 'code and display_name are required' });
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
    res.json({ success: true, provider });
  } catch (err) {
    logger.error('Failed to configure payment provider:', err.message);
    res.status(500).json({ error: 'Failed to configure payment provider' });
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
    res.json(invoices);
  } catch (err) {
    logger.error('Failed to query invoices:', err.message);
    res.status(500).json({ error: 'Failed to retrieve invoices' });
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

    res.json(orders || []);
  } catch (err) {
    logger.error('Failed to query store transactions:', err.message);
    res.status(500).json({ error: 'Failed to retrieve store transactions' });
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

    res.json({
      mrr,
      arr,
      total_paid_revenue: totalPaidRevenue
    });
  } catch (err) {
    logger.error('Failed to generate platform billing analytics:', err.message);
    res.status(500).json({ error: 'Failed to generate billing analytics' });
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

    res.json({
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
    res.status(500).json({ error: 'Failed to generate analytics' });
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

    if (invErr || !invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'paid') return res.status(400).json({ error: 'Invoice must be in paid status to refund' });

    const { data: payment, error: payErr } = await supabase
      .from('payments')
      .select('*')
      .eq('invoice_id', id)
      .eq('status', 'completed')
      .limit(1)
      .maybeSingle();

    if (payErr || !payment) {
      return res.status(400).json({ error: 'No active payments found for this invoice' });
    }

    const refundAmount = amount === undefined || amount === null || amount === ''
      ? parseFloat(invoice.total)
      : parseFloat(amount);

    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({ error: 'Refund amount must be a positive number' });
    }

    const paidAmount = parseFloat(invoice.amount_paid || invoice.total || 0);
    if (refundAmount > paidAmount) {
      return res.status(400).json({ error: 'Refund amount cannot exceed paid amount' });
    }

    // 2. Call strategy gateway
    const { getPaymentAdapter } = require('../services/billingEngine');
    const adapter = await getPaymentAdapter(payment.payment_method);
    
    // Call refund adapter
    const gatewayResult = await adapter.refund(payment.gateway_reference || payment.id, refundAmount, reason);
    if (!gatewayResult.success) {
      return res.status(400).json({ error: 'Gateway failed to process refund: ' + gatewayResult.errorMsg });
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

    res.json({ success: true, message: 'تم استرداد المبلغ بنجاح وتحديث السجلات' });
  } catch (err) {
    logger.error('Failed to refund invoice:', err.message);
    res.status(500).json({ error: 'Failed to process refund' });
  }
});


// ============================================================
// 10. Notification Template Control
// ============================================================

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
    res.json(data);
  } catch (err) {
    logger.error('Failed to list templates:', err.message);
    res.status(500).json({ error: 'Failed to retrieve notification templates' });
  }
});

// POST /api/platform/notifications/templates - Save template details
router.post('/notifications/templates', verifyPlatformAdmin, async (req, res) => {
  const { id, code, channel, language, subject, body_html, body_text, layout_id, is_active } = req.body;
  if (!code || !channel || !body_html) {
    return res.status(400).json({ error: 'code, channel, and body_html are required' });
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

    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to save notification template:', err.message);
    res.status(500).json({ error: 'Failed to save template' });
  }
});

// DELETE /api/platform/notifications/templates/:id - Delete a template
router.delete('/notifications/templates/:id', verifyPlatformAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('notification_templates').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete notification template:', err.message);
    res.status(500).json({ error: 'Failed to delete template' });
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
    res.json(data);
  } catch (err) {
    logger.error('Failed to list layouts:', err.message);
    res.status(500).json({ error: 'Failed to retrieve notification layouts' });
  }
});

// POST /api/platform/notifications/layouts - Save layout
router.post('/notifications/layouts', verifyPlatformAdmin, async (req, res) => {
  const { id, name, header_html, footer_html, css } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

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

    res.json({ success: true, id: data.id });
  } catch (err) {
    logger.error('Failed to save notification layout:', err.message);
    res.status(500).json({ error: 'Failed to save layout' });
  }
});

// DELETE /api/platform/notifications/layouts/:id - Delete a layout
router.delete('/notifications/layouts/:id', verifyPlatformAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('notification_layouts').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete notification layout:', err.message);
    res.status(500).json({ error: 'Failed to delete layout' });
  }
});

// POST /api/platform/notifications/test-send - Test sending templates
router.post('/notifications/test-send', verifyPlatformAdmin, async (req, res) => {
  const { template_code, recipient, language, variables } = req.body;
  if (!template_code || !recipient) {
    return res.status(400).json({ error: 'template_code and recipient are required' });
  }

  try {
    const { sendNotification } = require('../services/notificationEngine');
    const results = await sendNotification({
      templateCode: template_code,
      recipient,
      language: language || 'ar',
      variables: variables || {}
    });

    res.json({ success: true, results });
  } catch (err) {
    logger.error('Test notification delivery failed:', err.message);
    res.status(500).json({ error: 'Delivery test failed' });
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
    res.json(data);
  } catch (err) {
    logger.error('Failed to list notification history:', err.message);
    res.status(500).json({ error: 'Failed to retrieve notification history' });
  }
});

// ============================================================
// 12. Login Logs & Blocked IPs
// ============================================================

// GET /api/platform/login-logs
router.get('/login-logs', verifyPlatformAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const filter = req.query.filter || 'all';
    const store_id = req.query.store_id;

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

    const { data: logs, count, error } = await query
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (error) throw error;

    const formattedLogs = logs.map(log => ({
      ...log,
      store_name: log.stores?.name || 'Platform'
    }));

    res.json({ logs: formattedLogs, total: count || 0 });
  } catch (err) {
    logger.error('Failed to fetch login logs:', err.message);
    res.status(500).json({ error: 'Failed to fetch login logs' });
  }
});

// DELETE /api/platform/login-logs/:id
router.delete('/login-logs/:id', verifyPlatformAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('user_login_logs').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to delete login log:', err.message);
    res.status(500).json({ error: 'Failed to delete log' });
  }
});

// DELETE /api/platform/login-logs
router.delete('/login-logs', verifyPlatformAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('user_login_logs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to clear login logs:', err.message);
    res.status(500).json({ error: 'Failed to clear logs' });
  }
});

// GET /api/platform/blocked-ips
router.get('/blocked-ips', verifyPlatformAdmin, async (req, res) => {
  try {
    const { data: ips, error } = await supabase.from('blocked_ips').select('*').order('created_at', { ascending: false });
    if (error) throw error;
    res.json({ ips: ips || [] });
  } catch (err) {
    logger.error('Failed to fetch blocked IPs:', err.message);
    res.status(500).json({ error: 'Failed to fetch blocked IPs' });
  }
});

// POST /api/platform/blocked-ips/block
router.post('/blocked-ips/block', verifyPlatformAdmin, async (req, res) => {
  try {
    const { ip_address, reason } = req.body;
    if (!ip_address) return res.status(400).json({ error: 'IP is required' });

    const { error } = await supabase.from('blocked_ips').insert([{
      ip_address,
      reason: reason || 'Blocked by platform admin',
      blocked_by: req.user.id
    }]);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to block IP:', err.message);
    res.status(500).json({ error: 'Failed to block IP' });
  }
});

// POST /api/platform/blocked-ips/unblock
router.post('/blocked-ips/unblock', verifyPlatformAdmin, async (req, res) => {
  try {
    const { ip_address } = req.body;
    if (!ip_address) return res.status(400).json({ error: 'IP is required' });

    const { error } = await supabase.from('blocked_ips').delete().eq('ip_address', ip_address);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to unblock IP:', err.message);
    res.status(500).json({ error: 'Failed to unblock IP' });
  }
});

module.exports = router;
