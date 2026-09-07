'use strict';

const { z } = require('zod');

const createDriverSchema = z.object({
  name: z.string().trim().min(2, 'اسم المندوب مطلوب (حرفين على الأقل)').max(100),
  phone: z.string().trim().min(8, 'رقم الهاتف مطلوب').max(20),
  vehicle_type: z.string().trim().max(60).optional().default('موتوسيكل'),
  notes: z.string().trim().max(500).optional().default(''),
  is_active: z.boolean().optional().default(true)
}).strip();

const updateDriverSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  phone: z.string().trim().min(8).max(20).optional(),
  vehicle_type: z.string().trim().max(60).optional(),
  notes: z.string().trim().max(500).optional(),
  is_active: z.boolean().optional()
}).strip();

const assignDriverSchema = z.object({
  driverId: z.string().uuid('معرف المندوب غير صالح'),
  notes: z.string().trim().max(500).optional().default('')
}).strip();

module.exports = {
  createDriverSchema,
  updateDriverSchema,
  assignDriverSchema
};
