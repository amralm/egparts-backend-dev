'use strict';

const { z } = require('zod');

const ticketCategorySchema = z.enum([
  'order_issue',
  'payment',
  'product_inquiry',
  'shipping',
  'other'
]);

const ticketStatusSchema = z.enum([
  'open',
  'in_progress',
  'resolved',
  'closed'
]);

const ticketPrioritySchema = z.enum([
  'low',
  'normal',
  'high',
  'urgent'
]);

const abuseReasonCategorySchema = z.enum([
  'fraud',
  'counterfeit',
  'scam',
  'abusive_behavior',
  'policy_violation',
  'other'
]);

const abuseReportStatusSchema = z.enum([
  'pending',
  'investigating',
  'action_taken',
  'dismissed',
  'resolved'
]);

const abuseAdminActionSchema = z.enum([
  'none',
  'warning_issued',
  'store_suspended',
  'store_frozen',
  'dismissed',
  'resolved'
]);

// 1. Create Ticket Schema
const createTicketSchema = z.object({
  customerName: z.string().trim().min(2, 'الاسم يجب أن لا يقل عن حرفين').max(100, 'الاسم طويل جداً').optional(),
  customer_name: z.string().trim().min(2).max(100).optional(),
  customerPhone: z.string().trim().min(8, 'رقم الهاتف غير صالح').max(25, 'رقم الهاتف طويل جداً').optional(),
  customer_phone: z.string().trim().min(8).max(25).optional(),
  customerEmail: z.string().trim().email('البريد الإلكتروني غير صالح').max(254).optional().nullable().or(z.literal('')),
  customer_email: z.string().trim().email().max(254).optional().nullable().or(z.literal('')),
  orderId: z.string().uuid('معرف الطلب غير صالح').optional().nullable().or(z.literal('')),
  order_id: z.string().uuid().optional().nullable().or(z.literal('')),
  category: ticketCategorySchema.default('order_issue'),
  priority: ticketPrioritySchema.optional().default('normal'),
  subject: z.string().trim().min(3, 'عنوان التذكرة يجب أن لا يقل عن 3 أحرف').max(200, 'العنوان طويل جداً'),
  message: z.string().trim().min(1, 'نص الرسالة مطلوب').max(5000, 'نص الرسالة طويل جداً'),
  attachments: z.array(z.string().url()).max(10).optional().default([]),
  turnstileToken: z.string().max(4096).optional().nullable(),
  turnstile_token: z.string().max(4096).optional().nullable()
}).refine((data) => data.customerName || data.customer_name, {
  message: 'اسم العميل مطلوب',
  path: ['customerName']
}).refine((data) => data.customerPhone || data.customer_phone, {
  message: 'رقم الهاتف مطلوب',
  path: ['customerPhone']
});

// 2. Ticket Message Schema
const ticketMessageSchema = z.object({
  message: z.string().trim().min(1, 'نص الرسالة مطلوب').max(5000, 'نص الرسالة طويل جداً'),
  attachments: z.array(z.string().url()).max(10).optional().default([]),
  isInternalNote: z.boolean().optional().default(false),
  is_internal_note: z.boolean().optional()
});

// 3. Update Ticket Status & Priority Schema
const updateTicketStatusSchema = z.object({
  status: ticketStatusSchema.optional(),
  priority: ticketPrioritySchema.optional()
}).refine((data) => data.status !== undefined || data.priority !== undefined, {
  message: 'يجب تحديد الحالة أو الأولوية للتحديث'
});

// 4. Submit Platform Abuse Report Schema
const submitAbuseReportSchema = z.object({
  storeId: z.string().uuid('معرف المتجر غير صالح').optional(),
  store_id: z.string().uuid('معرف المتجر غير صالح').optional(),
  reporterName: z.string().trim().min(2, 'الاسم مطلوب').max(100).optional(),
  reporter_name: z.string().trim().min(2).max(100).optional(),
  reporterPhone: z.string().trim().min(8, 'رقم الهاتف غير صالح').max(25).optional(),
  reporter_phone: z.string().trim().min(8).max(25).optional(),
  reporterEmail: z.string().trim().email('البريد الإلكتروني غير صالح').max(254).optional().nullable().or(z.literal('')),
  reporter_email: z.string().trim().email().max(254).optional().nullable().or(z.literal('')),
  orderId: z.string().uuid('معرف الطلب غير صالح').optional().nullable().or(z.literal('')),
  order_id: z.string().uuid().optional().nullable().or(z.literal('')),
  reasonCategory: abuseReasonCategorySchema.optional(),
  reason_category: abuseReasonCategorySchema.optional(),
  description: z.string().trim().min(5, 'وصف البلاغ مطلوب').max(5000, 'الوصف طويل جداً'),
  evidenceUrls: z.array(z.string().url()).max(10).optional().default([]),
  evidence_urls: z.array(z.string().url()).max(10).optional(),
  turnstileToken: z.string().max(4096).optional().nullable(),
  turnstile_token: z.string().max(4096).optional().nullable()
}).refine((data) => data.storeId || data.store_id, {
  message: 'معرف المتجر مطلوب',
  path: ['storeId']
}).refine((data) => data.reporterName || data.reporter_name, {
  message: 'اسم مقدم البلاغ مطلوب',
  path: ['reporterName']
}).refine((data) => data.reporterPhone || data.reporter_phone, {
  message: 'رقم هاتف مقدم البلاغ مطلوب',
  path: ['reporterPhone']
}).refine((data) => data.reasonCategory || data.reason_category, {
  message: 'سبب البلاغ مطلوب',
  path: ['reasonCategory']
});

// 5. Abuse Report Action Schema
const abuseReportActionSchema = z.object({
  action: abuseAdminActionSchema,
  adminNotes: z.string().trim().max(3000).optional().default(''),
  admin_notes: z.string().trim().max(3000).optional(),
  status: abuseReportStatusSchema.optional()
});

module.exports = {
  ticketCategorySchema,
  ticketStatusSchema,
  ticketPrioritySchema,
  abuseReasonCategorySchema,
  abuseReportStatusSchema,
  abuseAdminActionSchema,
  createTicketSchema,
  ticketMessageSchema,
  updateTicketStatusSchema,
  submitAbuseReportSchema,
  abuseReportActionSchema
};
