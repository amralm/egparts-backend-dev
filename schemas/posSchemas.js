'use strict';

const { z } = require('zod');

const posOrderItemSchema = z.object({
  id: z.string().uuid({ message: 'معرف المنتج غير صالح' }),
  qty: z.coerce.number().int().min(1, { message: 'الكمية يجب أن تكون 1 على الأقل' }),
  price: z.coerce.number().min(0, { message: 'السعر غير صالح' }).optional(),
  name: z.string().trim().optional()
});

const posOrderSchema = z.object({
  items: z.array(posOrderItemSchema).min(1, { message: 'السلة فارغة. يرجى إضافة منتج واحد على الأقل.' }),
  payment_method: z.enum(['cash', 'card']).default('cash'),
  discount_amount: z.coerce.number().min(0).default(0),
  customer_name: z.string().trim().max(120).default('عميل نقدي'),
  customer_phone: z.string().trim().max(30).nullable().optional(),
  notes: z.string().trim().max(500).default(''),
  cash_tendered: z.coerce.number().nullable().optional(),
  change_due: z.coerce.number().nullable().optional()
}).strip();

const posReturnItemSchema = z.object({
  id: z.string().uuid({ message: 'معرف المنتج غير صالح' }),
  qty: z.coerce.number().int().min(1, { message: 'الكمية المرتجعة يجب أن تكون 1 على الأقل' }),
  price: z.coerce.number().min(0, { message: 'السعر غير صالح' }).optional(),
  condition: z.enum(['sound', 'damaged']).default('sound'),
  name: z.string().trim().optional()
});

const posReturnSchema = z.object({
  order_id: z.string().uuid({ message: 'معرف الفاتورة غير صالح' }),
  items: z.array(posReturnItemSchema).min(1, { message: 'يجب اختيار صنف واحد على الأقل للإرجاع' }),
  refund_method: z.enum(['cash', 'card', 'exchange']).default('cash'),
  reason: z.string().trim().max(500).default('')
}).strip();

const openShiftSchema = z.object({
  opening_cash: z.coerce.number().min(0, { message: 'رصيد الافتتاح يجب أن يكون رقماً موجباً' }).default(0),
  notes: z.string().trim().max(500).default('')
}).strip();

const cashMovementSchema = z.object({
  type: z.enum(['pay_in', 'pay_out'], { message: 'نوع الحركة يجب أن يكون إيداع (pay_in) أو سحب (pay_out)' }),
  amount: z.coerce.number().positive({ message: 'المبلغ يجب أن يكون أكبر من صفر' }),
  reason: z.string().trim().min(2, { message: 'سبب الحركة مطلوب' }).max(255)
}).strip();

const closeShiftSchema = z.object({
  actual_cash: z.coerce.number().min(0, { message: 'المبلغ الفعلي في الدرج مطلوب' }),
  notes: z.string().trim().max(1000).default('')
}).strip();

const sendReceiptSchema = z.object({
  phone: z.string().trim().min(8, { message: 'رقم الهاتف غير صالح' }).max(30)
}).strip();

const createCashierSchema = z.object({
  name: z.string().trim().min(2, { message: 'اسم الكاشير يجب أن يتكون من حرفين على الأقل' }).max(80),
  phone: z.string().trim().max(30).nullable().optional(),
  role: z.enum(['cashier', 'supervisor']).default('cashier'),
  pin: z.string().trim().regex(/^\d{4,6}$/, { message: 'رمز PIN يجب أن يتكون من 4 إلى 6 أرقام رقمية فقط' })
}).strip();

const updateCashierSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  role: z.enum(['cashier', 'supervisor']).optional(),
  pin: z.string().trim().regex(/^\d{4,6}$/, { message: 'رمز PIN يجب أن يتكون من 4 إلى 6 أرقام' }).optional(),
  is_active: z.boolean().optional()
}).strip();

const switchCashierSchema = z.object({
  pin: z.string().trim().regex(/^\d{4,6}$/, { message: 'رمز PIN يجب أن يتكون من 4 إلى 6 أرقام' })
}).strip();

const managerPinSchema = z.object({
  pin: z.string().trim().regex(/^\d{4,6}$/, { message: 'رمز PIN المدير يجب أن يتكون من 4 إلى 6 أرقام' })
}).strip();

module.exports = {
  posOrderSchema,
  posReturnSchema,
  openShiftSchema,
  cashMovementSchema,
  closeShiftSchema,
  sendReceiptSchema,
  createCashierSchema,
  updateCashierSchema,
  switchCashierSchema,
  managerPinSchema
};
