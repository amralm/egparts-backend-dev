'use strict';

const { z } = require('zod');
const { contract, itemSchema } = require('./canonicalSchemas');

const syncDraftCartSchema = z.object({
  phone: z.string().trim().min(contract.fields.phone_min).max(contract.fields.phone_max),
  customerName: z.string().trim().max(100).optional().nullable(),
  customer_name: z.string().trim().max(100).optional().nullable(),
  items: z.array(itemSchema).min(1).max(contract.fields.items_max),
}).strip();

const recoverTokenParamSchema = z.object({
  token: z.string().trim().min(16).max(128),
});

module.exports = {
  syncDraftCartSchema,
  recoverTokenParamSchema,
};
