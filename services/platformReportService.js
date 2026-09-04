const { supabase } = require('./supabase');

async function createReport({ storeId, reporterUserId, reporterName, reporterPhone, reporterEmail, orderId, reasonCategory, description, evidenceUrls = [] }) {
  if (!storeId) throw new Error('Store context is required');
  if (!reporterName || !reporterPhone || !description) {
    throw new Error('بيانات البلاغ غير مكتملة');
  }

  const { data, error } = await supabase
    .from('platform_abuse_reports')
    .insert({
      store_id: storeId,
      reporter_user_id: reporterUserId || null,
      reporter_name: reporterName.trim(),
      reporter_phone: reporterPhone.trim(),
      reporter_email: reporterEmail ? reporterEmail.trim().toLowerCase() : null,
      order_id: orderId || null,
      reason_category: reasonCategory || 'other',
      description: description.trim(),
      evidence_urls: Array.isArray(evidenceUrls) ? evidenceUrls : [],
      status: 'pending'
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

function formatReport(report) {
  if (!report) return report;
  const storeObj = report.store || report.stores || null;
  const storeName = storeObj?.name || report.store_name || null;
  const storeSubdomain = storeObj?.subdomain || report.store_subdomain || null;
  const storeIsActive = storeObj ? storeObj.is_active !== false : true;

  const orderObj = report.order ? {
    ...report.order,
    customer_phone: report.order.customer_phone || report.order.phone || null
  } : null;

  return {
    ...report,
    store: storeObj,
    stores: storeObj,
    store_name: storeName,
    store_subdomain: storeSubdomain,
    store_active: storeIsActive,
    order: orderObj,
  };
}

async function listPlatformReports({ status, reasonCategory, storeId, page = 1, limit = 20 }) {
  let query = supabase
    .from('platform_abuse_reports')
    .select(`
      *,
      store:stores(id, name, subdomain, business_type, is_active, created_at),
      order:orders(id, order_number, total, status)
    `, { count: 'exact' });

  if (status && status !== 'all') {
    query = query.eq('status', status);
  }
  if (reasonCategory && reasonCategory !== 'all') {
    query = query.eq('reason_category', reasonCategory);
  }
  if (storeId) {
    query = query.eq('store_id', storeId);
  }

  const offset = (Math.max(1, page) - 1) * limit;
  query = query.order('created_at', { ascending: false }).range(offset, offset + limit - 1);

  const { data, count, error } = await query;
  if (error) throw error;

  const formatted = (data || []).map(formatReport);

  return {
    reports: formatted,
    total: count || 0,
    page: Number(page),
    limit: Number(limit),
    pagination: {
      page: Number(page),
      limit: Number(limit),
      total: count || 0,
      totalPages: Math.ceil((count || 0) / Number(limit)) || 1
    }
  };
}

async function getPlatformReportDetails(reportId) {
  const { data, error } = await supabase
    .from('platform_abuse_reports')
    .select(`
      *,
      store:stores(id, name, subdomain, business_type, is_active, created_at),
      order:orders(id, order_number, total, status, phone, city, address)
    `)
    .eq('id', reportId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  let resolver = null;
  if (data.resolved_by) {
    try {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('name, email')
        .eq('id', data.resolved_by)
        .maybeSingle();
      resolver = profile || null;
    } catch {
      resolver = null;
    }
  }

  return formatReport({
    ...data,
    resolver
  });
}

async function updateReportAction(reportId, { status, adminAction, action, adminNotes, resolvedByUserId, correlationId, ipAddress, userAgent }) {
  const crypto = require('crypto');
  const effectiveAction = adminAction || action;

  const updates = {
    updated_at: new Date().toISOString()
  };
  if (status) updates.status = status;
  if (effectiveAction) updates.admin_action = effectiveAction;
  if (adminNotes !== undefined) updates.admin_notes = adminNotes;
  if (resolvedByUserId) {
    updates.resolved_by = resolvedByUserId;
    updates.resolved_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('platform_abuse_reports')
    .update(updates)
    .eq('id', reportId)
    .select(`
      *,
      store:stores(id, name, subdomain, business_type, is_active, created_at)
    `)
    .single();

  if (error) throw error;

  // Execute genuine store disciplinary action if punitive
  if (effectiveAction === 'store_suspended' || effectiveAction === 'store_frozen') {
    const storeStatus = effectiveAction === 'store_suspended' ? 'suspended' : 'frozen';
    const { error: storeErr } = await supabase
      .from('stores')
      .update({
        is_active: false,
        status: storeStatus,
        updated_at: new Date().toISOString()
      })
      .eq('id', data.store_id);

    if (storeErr) {
      console.warn('Disciplinary store status update warning:', storeErr.message);
    }
  }

  // Genuinely record action into public.audit_logs
  try {
    const rawCorr = String(correlationId || '');
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawCorr);

    await supabase
      .from('audit_logs')
      .insert([{
        correlation_id: isUuid ? rawCorr : crypto.randomUUID(),
        store_id: data.store_id,
        user_id: resolvedByUserId || null,
        action: 'platform.store.disciplinary_action',
        entity_type: 'platform_abuse_reports',
        entity_id: String(reportId),
        new_values: {
          storeId: data.store_id,
          action: effectiveAction,
          adminNotes: adminNotes || '',
          status: status || data.status
        },
        old_values: {},
        ip_address: ipAddress || null,
        user_agent: userAgent || null
      }]);
  } catch (auditErr) {
    console.warn('Platform abuse audit log insertion warning:', auditErr.message);
  }

  return formatReport(data);
}

module.exports = {
  createReport,
  listPlatformReports,
  getPlatformReportDetails,
  updateReportAction
};
