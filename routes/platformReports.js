const express = require('express');
const platformReportService = require('../services/platformReportService');
const { optionalAuth } = require('../middleware/auth');
const { verifyPlatformAdmin } = require('../middleware/platformAdmin');
const { sendSuccess } = require('../utils/apiResponse');
const { apiError } = require('../utils/apiError');
const rateLimit = require('express-rate-limit');

const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'HTTP_429', message: 'تم تجاوز الحد المسموح به لإرسال البلاغات. حاول بعد قليل.' }
});

// ── Handlers ─────────────────────────────────────────────────────────

// Public / Customer submits abuse report
async function handleSubmitReport(req, res) {
  const { storeId, reporterName, reporterPhone, reporterEmail, orderId, reasonCategory, description, evidenceUrls } = req.body || {};
  const targetStoreId = storeId || req.store?.id;

  if (!targetStoreId) {
    return apiError(res, 400, 'معرف المتجر المبلغ عنه مطلوب', 'STORE_REQUIRED');
  }

  try {
    const report = await platformReportService.createReport({
      storeId: targetStoreId,
      reporterUserId: req.user?.sub || null,
      reporterName,
      reporterPhone,
      reporterEmail,
      orderId,
      reasonCategory,
      description,
      evidenceUrls
    });
    return sendSuccess(res, { report, message: 'تم إرسال البلاغ بنجاح وسيتم مراجعته من قبل إدارة المنصة.' }, 201);
  } catch (err) {
    return apiError(res, 400, err.message, 'REPORT_CREATE_FAILED');
  }
}

// Super Admin lists platform abuse reports
async function handleListReports(req, res) {
  const { status, reasonCategory, storeId, page, limit } = req.query;

  try {
    const result = await platformReportService.listPlatformReports({
      status,
      reasonCategory,
      storeId,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20
    });
    return sendSuccess(res, result);
  } catch (err) {
    return apiError(res, 500, 'فشل تحميل تقارير البلاغات', 'PLATFORM_REPORTS_FAILED');
  }
}

// Super Admin gets report details
async function handleGetReportDetails(req, res) {
  try {
    const report = await platformReportService.getPlatformReportDetails(req.params.id);
    if (!report) return apiError(res, 404, 'البلاغ غير موجود', 'REPORT_NOT_FOUND');
    return sendSuccess(res, { report });
  } catch (err) {
    return apiError(res, 500, err.message, 'REPORT_DETAILS_FAILED');
  }
}

// Super Admin updates report action (warnings, suspensions, dismissals)
async function handleUpdateReportAction(req, res) {
  const { status, action, adminAction, adminNotes } = req.body || {};

  try {
    const updated = await platformReportService.updateReportAction(req.params.id, {
      status,
      adminAction: adminAction || action,
      action: action || adminAction,
      adminNotes,
      resolvedByUserId: req.user?.sub || null,
      correlationId: req.correlationId || null,
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null
    });
    return sendSuccess(res, { report: updated, message: 'تم تحديث إجراءات البلاغ بنجاح' });
  } catch (err) {
    return apiError(res, 400, err.message, 'REPORT_ACTION_FAILED');
  }
}

// ── Public Reports Router (Mounted at /api/platform/reports) ──────────
const publicReportsRouter = express.Router();
publicReportsRouter.post(['/submit', '/'], optionalAuth, reportLimiter, handleSubmitReport);

// ── Super Admin Reports Router (Mounted at /api/platform/admin/reports) 
const adminReportsRouter = express.Router();
adminReportsRouter.get(['/', '/reports'], verifyPlatformAdmin, handleListReports);
adminReportsRouter.get(['/:id', '/reports/:id'], verifyPlatformAdmin, handleGetReportDetails);
adminReportsRouter.patch(['/:id/action', '/reports/:id/action'], verifyPlatformAdmin, handleUpdateReportAction);

// ── Combined Root Router ──────────────────────────────────────────────
const rootRouter = express.Router();
rootRouter.post(['/submit', '/reports/submit', '/'], optionalAuth, reportLimiter, handleSubmitReport);
rootRouter.get(['/', '/reports', '/admin/reports'], verifyPlatformAdmin, handleListReports);
rootRouter.get(['/:id', '/reports/:id', '/admin/reports/:id'], verifyPlatformAdmin, handleGetReportDetails);
rootRouter.patch(['/:id/action', '/reports/:id/action', '/admin/reports/:id/action'], verifyPlatformAdmin, handleUpdateReportAction);

rootRouter.publicReportsRouter = publicReportsRouter;
rootRouter.adminReportsRouter = adminReportsRouter;

module.exports = rootRouter;
