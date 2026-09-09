'use strict';

const express = require('express');
const router = express.Router();
const { z } = require('zod');
const crypto = require('crypto');
const { supabase } = require('../services/supabase');
const { verifyPermission } = require('../middleware/auth');
const subscriptionLimitService = require('../services/subscriptionLimitService');
const { sendSuccess } = require('../utils/apiResponse');
const { apiError } = require('../utils/apiError');
const logger = require('../utils/logger');

// Input validation schemas
const inviteStaffSchema = z.object({
  email: z.string().email('البريد الإلكتروني للموظف غير صالح'),
  role_name: z.enum(['cashier', 'store_manager', 'inventory']).default('cashier'),
  password: z.string().min(6, 'كلمة المرور يجب أن لا تقل عن 6 أحرف').optional(),
  name: z.string().min(2, 'اسم الموظف مطلوب').optional()
});

const toggleStaffSchema = z.object({
  is_active: z.boolean()
});

// ── GET /api/staff ──
// List all store staff and current plan usage
router.get('/', verifyPermission(['staff.read', 'tenant.owner', 'settings.view', 'settings.read']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  try {
    // 1. Fetch staff members
    const { data: staffList, error: staffErr } = await supabase
      .from('store_staff')
      .select('id, store_id, user_id, role_name, invited_email, is_active, created_at, updated_at')
      .eq('store_id', req.store.id)
      .order('created_at', { ascending: false });

    if (staffErr) throw staffErr;

    // 2. Fetch limit state
    const limitState = await subscriptionLimitService.checkFeatureLimit(req.store.id, 'employees', 0).catch(() => ({
      allowed: true,
      limit: null,
      usage: staffList?.length || 0,
      is_unlimited: true
    }));

    const activeCount = (staffList || []).filter(s => s.is_active).length;

    sendSuccess(res, {
      staff: staffList || [],
      quota: {
        active_count: activeCount,
        total_count: staffList?.length || 0,
        limit: limitState.is_unlimited ? null : (limitState.limit ?? null),
        remaining: limitState.remaining ?? null,
        is_unlimited: Boolean(limitState.is_unlimited),
        plan_name: limitState.plan?.name || 'الباقة الحالية'
      },
      count: activeCount,
      limit: limitState.is_unlimited ? null : (limitState.limit ?? null),
      is_unlimited: Boolean(limitState.is_unlimited),
      plan: limitState.plan
    });
  } catch (err) {
    logger.error('[staff] List staff failed:', err.message);
    apiError(res, 500, 'فشل جلب قائمة الموظفين', 'HTTP_500');
  }
});

// ── POST /api/staff/invite ──
// Secure controlled employee creation with atomic server-side quota enforcement
router.post('/invite', verifyPermission(['staff.write', 'tenant.owner', 'settings.update', 'settings.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = inviteStaffSchema.safeParse(req.body);
  if (!parseResult.success) {
    const errorMsg = parseResult.error?.issues?.[0]?.message || 'بيانات الموظف غير صالحة';
    return apiError(res, 400, errorMsg, 'VALIDATION_ERROR');
  }

  const { email, role_name, password, name } = parseResult.data;
  const normalizedEmail = email.toLowerCase().trim();

  try {
    // 1. Find or create user in Supabase Auth via admin API
    let authUserId = null;
    const { data: existingUsers, error: searchErr } = await supabase.auth.admin.listUsers();
    
    if (!searchErr && existingUsers?.users) {
      const found = existingUsers.users.find(u => u.email?.toLowerCase() === normalizedEmail);
      if (found) authUserId = found.id;
    }

    if (!authUserId) {
      // Create user securely. If no password provided, generate secure random password
      const securePassword = password || crypto.randomBytes(12).toString('base64url');
      const { data: newUser, error: createAuthErr } = await supabase.auth.admin.createUser({
        email: normalizedEmail,
        password: securePassword,
        email_confirm: true,
        user_metadata: {
          full_name: name || (role_name === 'cashier' ? 'كاشير' : 'موظف'),
          store_id: req.store.id,
          role: role_name
        }
      });

      if (createAuthErr) {
        logger.error('[staff] Create auth user failed:', createAuthErr.message);
        return apiError(res, 400, `تعذر إنشاء حساب الموظف: ${createAuthErr.message}`, 'AUTH_CREATION_FAILED');
      }

      authUserId = newUser.user.id;
    }

    // 2. Execute Atomic Quota Check & Staff Registration RPC
    const { data: rpcResult, error: rpcError } = await supabase.rpc('create_store_staff_atomic', {
      p_store_id: req.store.id,
      p_user_id: authUserId,
      p_email: normalizedEmail,
      p_role_name: role_name
    });

    if (rpcError) {
      if (rpcError.message.includes('PLAN_LIMIT_REACHED')) {
        return apiError(
          res,
          403,
          rpcError.message.replace('PLAN_LIMIT_REACHED: ', ''),
          'PLAN_LIMIT_REACHED'
        );
      }
      logger.error('[staff] Atomic staff RPC failed:', rpcError.message);
      return apiError(res, 400, rpcError.message || 'تعذر إضافة الموظف إلى المتجر', 'STAFF_CREATION_FAILED');
    }

    sendSuccess(res, {
      staff: rpcResult,
      message: `تم إضافة الموظف بنجاح وتعيينه بدور (${role_name === 'cashier' ? 'كاشير' : role_name})`
    });
  } catch (err) {
    logger.error('[staff] Invite staff exception:', err.message);
    apiError(res, 500, err.message || 'حدث خطأ أثناء إضافة الموظف', 'HTTP_500');
  }
});

// ── PUT /api/staff/:id/toggle ──
// Toggle staff member active status
router.put('/:id/toggle', verifyPermission(['staff.write', 'tenant.owner', 'settings.update', 'settings.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const parseResult = toggleStaffSchema.safeParse(req.body);
  if (!parseResult.success) {
    return apiError(res, 400, 'حالة التفعيل مطلوبة', 'VALIDATION_ERROR');
  }

  const { is_active } = parseResult.data;
  const staffId = req.params.id;

  try {
    const { data: staff, error: fetchErr } = await supabase
      .from('store_staff')
      .select('id, user_id, store_id, role_id, is_active')
      .eq('id', staffId)
      .eq('store_id', req.store.id)
      .single();

    if (fetchErr || !staff) {
      return apiError(res, 404, 'الموظف غير موجود', 'STAFF_NOT_FOUND');
    }

    if (is_active) {
      // Re-activating: check quota
      const limitState = await subscriptionLimitService.checkFeatureLimit(req.store.id, 'employees', 1);
      if (!limitState.allowed && !limitState.is_unlimited) {
        return apiError(res, 403, 'لا يمكن تفعيل الموظف لتجاوز الحد الأقصى للموظفين في الباقة الحالية', 'PLAN_LIMIT_REACHED');
      }

      // Re-grant role in user_roles
      if (staff.user_id && staff.role_id) {
        await supabase.from('user_roles').upsert({
          user_id: staff.user_id,
          store_id: req.store.id,
          role_id: staff.role_id
        }, { onConflict: 'user_id,store_id,role_id', ignoreDuplicates: true });
      }
    } else {
      // Deactivating: revoke role in user_roles
      if (staff.user_id) {
        await supabase.from('user_roles').delete()
          .eq('user_id', staff.user_id)
          .eq('store_id', req.store.id);
      }
    }

    const { data: updated, error: updateErr } = await supabase
      .from('store_staff')
      .update({ is_active, updated_at: new Date().toISOString() })
      .eq('id', staffId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    sendSuccess(res, {
      staff: updated,
      message: is_active ? 'تم تفعيل حساب الموظف بنجاح' : 'تم تجميد حساب الموظف بنجاح'
    });
  } catch (err) {
    logger.error('[staff] Toggle staff failed:', err.message);
    apiError(res, 500, 'فشل تعديل حالة الموظف', 'HTTP_500');
  }
});

// ── DELETE /api/staff/:id ──
// Delete a staff member from store
router.delete('/:id', verifyPermission(['staff.write', 'tenant.owner', 'settings.update', 'settings.write']), async (req, res) => {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_REQUIRED');

  const staffId = req.params.id;

  try {
    const { data: staff, error: fetchErr } = await supabase
      .from('store_staff')
      .select('id, user_id, store_id')
      .eq('id', staffId)
      .eq('store_id', req.store.id)
      .single();

    if (fetchErr || !staff) {
      return apiError(res, 404, 'الموظف غير موجود', 'STAFF_NOT_FOUND');
    }

    // Revoke user_roles
    if (staff.user_id) {
      await supabase.from('user_roles').delete()
        .eq('user_id', staff.user_id)
        .eq('store_id', req.store.id);
    }

    // Delete from store_staff
    const { error: delErr } = await supabase
      .from('store_staff')
      .delete()
      .eq('id', staffId);

    if (delErr) throw delErr;

    sendSuccess(res, {
      deleted: true,
      message: 'تم إزالة الموظف من المتجر بنجاح'
    });
  } catch (err) {
    logger.error('[staff] Delete staff failed:', err.message);
    apiError(res, 500, 'فشل حذف الموظف', 'HTTP_500');
  }
});

module.exports = router;
