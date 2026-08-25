const express = require('express');
const supportService = require('../services/supportService');
const { verifyUser, optionalAuth, verifyPermission } = require('../middleware/auth');
const { sendSuccess } = require('../utils/apiResponse');
const { apiError } = require('../utils/apiError');
const rateLimit = require('express-rate-limit');

const ticketLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, code: 'HTTP_429', message: 'تم تجاوز الحد المسموح به لإرسال التذاكر. حاول بعد قليل.' }
});

// ── Handlers ─────────────────────────────────────────────────────────

// Customer creates ticket
async function handleCreateTicket(req, res) {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  const { customerName, customerPhone, customerEmail, category, priority, subject, message, attachments, orderId } = req.body || {};

  try {
    const ticket = await supportService.createTicket({
      storeId: req.store.id,
      userId: req.user?.sub || null,
      orderId: orderId || null,
      customerName,
      customerPhone,
      customerEmail,
      category,
      priority,
      subject,
      message,
      attachments
    });
    return sendSuccess(res, { ticket, message: 'تم إنشاء تذكرة الدعم بنجاح' }, 201);
  } catch (err) {
    return apiError(res, 400, err.message, 'TICKET_CREATE_FAILED');
  }
}

// Customer gets their tickets
async function handleListCustomerTickets(req, res) {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  try {
    const tickets = await supportService.listCustomerTickets(req.user.sub, req.store.id);
    return sendSuccess(res, { tickets });
  } catch (err) {
    return apiError(res, 500, 'فشل تحميل التذاكر', 'TICKETS_FETCH_FAILED');
  }
}

// Post ticket message (Customer or Merchant)
async function handleAddTicketMessage(req, res) {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  const { message, attachments, isInternalNote } = req.body || {};
  
  const isMerchant = await supportService.isStaffMember(req.user?.sub, req.store.id);

  try {
    const msg = await supportService.addTicketMessage({
      ticketId: req.params.id,
      storeId: req.store.id,
      senderType: isMerchant ? 'merchant' : 'customer',
      senderId: req.user?.sub || null,
      message,
      attachments,
      isInternalNote: isMerchant ? Boolean(isInternalNote) : false
    });
    return sendSuccess(res, { message: msg }, 201);
  } catch (err) {
    return apiError(res, 400, err.message, 'MESSAGE_SEND_FAILED');
  }
}

// Store Admin lists store tickets
async function handleListStoreTickets(req, res) {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  const { status, priority, search, page, limit } = req.query;

  try {
    const result = await supportService.listStoreTickets(req.store.id, {
      status,
      priority,
      search,
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20
    });
    return sendSuccess(res, result);
  } catch (err) {
    return apiError(res, 500, 'فشل استرجاع تذاكر المتجر', 'ADMIN_TICKETS_FAILED');
  }
}

// Store Admin updates ticket status/priority
async function handleUpdateTicketStatus(req, res) {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  const { status, priority } = req.body || {};

  try {
    const updated = await supportService.updateTicketStatus(req.params.id, req.store.id, { status, priority });
    return sendSuccess(res, { ticket: updated, message: 'تم تحديث حالة التذكرة بنجاح' });
  } catch (err) {
    return apiError(res, 400, err.message, 'TICKET_STATUS_UPDATE_FAILED');
  }
}

// Store Admin gets single ticket
async function handleGetStoreTicketDetails(req, res) {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  try {
    const ticket = await supportService.getTicketDetails(req.params.id, req.store.id, null, true);
    if (!ticket) return apiError(res, 404, 'التذكرة غير موجودة', 'TICKET_NOT_FOUND');
    return sendSuccess(res, { ticket });
  } catch (err) {
    return apiError(res, 500, err.message, 'TICKET_DETAILS_FAILED');
  }
}

// Customer gets single ticket details
async function handleGetCustomerTicketDetails(req, res) {
  if (!req.store?.id) return apiError(res, 400, 'Tenant context required', 'TENANT_CONTEXT_REQUIRED');
  try {
    const isMerchant = await supportService.isStaffMember(req.user?.sub, req.store.id);
    const ticket = await supportService.getTicketDetails(req.params.id, req.store.id, req.user?.sub || null, isMerchant);
    if (!ticket) return apiError(res, 404, 'التذكرة غير موجودة', 'TICKET_NOT_FOUND');
    return sendSuccess(res, { ticket });
  } catch (err) {
    return apiError(res, 500, err.message, 'TICKET_DETAILS_FAILED');
  }
}

// ── Customer Router (Mounted at /api/support) ─────────────────────────
const customerRouter = express.Router();
customerRouter.post('/tickets', optionalAuth, ticketLimiter, handleCreateTicket);
customerRouter.get('/tickets/my', verifyUser, handleListCustomerTickets);
customerRouter.get('/tickets/:id', optionalAuth, handleGetCustomerTicketDetails);
customerRouter.post('/tickets/:id/messages', optionalAuth, ticketLimiter, handleAddTicketMessage);
customerRouter.post('/', optionalAuth, ticketLimiter, handleCreateTicket);
customerRouter.get('/my', verifyUser, handleListCustomerTickets);
customerRouter.get('/:id', optionalAuth, handleGetCustomerTicketDetails);
customerRouter.post('/:id/messages', optionalAuth, ticketLimiter, handleAddTicketMessage);

// ── Merchant Admin Router (Mounted at /api/admin/support) ─────────────
const adminRouter = express.Router();
adminRouter.get('/tickets', verifyPermission('support.view'), handleListStoreTickets);
adminRouter.get('/tickets/:id', verifyPermission('support.view'), handleGetStoreTicketDetails);
adminRouter.patch('/tickets/:id/status', verifyPermission('support.manage'), handleUpdateTicketStatus);
adminRouter.post('/tickets/:id/messages', verifyPermission('support.manage'), ticketLimiter, handleAddTicketMessage);
adminRouter.get('/', verifyPermission('support.view'), handleListStoreTickets);
adminRouter.get('/:id', verifyPermission('support.view'), handleGetStoreTicketDetails);
adminRouter.patch('/:id/status', verifyPermission('support.manage'), handleUpdateTicketStatus);
adminRouter.post('/:id/messages', verifyPermission('support.manage'), ticketLimiter, handleAddTicketMessage);

// ── Combined Root Router ──────────────────────────────────────────────
const rootRouter = express.Router();

// Specific routes first to prevent :id param eating static routes
rootRouter.get('/admin/tickets', verifyPermission('support.view'), handleListStoreTickets);
rootRouter.get('/admin/tickets/:id', verifyPermission('support.view'), handleGetStoreTicketDetails);
rootRouter.patch('/admin/tickets/:id/status', verifyPermission('support.manage'), handleUpdateTicketStatus);
rootRouter.post('/admin/tickets/:id/messages', verifyPermission('support.manage'), ticketLimiter, handleAddTicketMessage);

rootRouter.post('/tickets', optionalAuth, ticketLimiter, handleCreateTicket);
rootRouter.get('/tickets/my', verifyUser, handleListCustomerTickets);
rootRouter.post('/tickets/:id/messages', optionalAuth, ticketLimiter, handleAddTicketMessage);
rootRouter.get('/tickets/:id', optionalAuth, handleGetCustomerTicketDetails);

rootRouter.customerRouter = customerRouter;
rootRouter.adminRouter = adminRouter;

module.exports = rootRouter;
