const { z } = require('zod');

const addressSchema = z.object({
  title: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(8).max(20),
  city: z.string().trim().min(1).max(120),
  address: z.string().trim().min(2).max(500),
  is_default: z.boolean().optional().default(false),
  location_url: z.string().url().max(2048).nullable().optional().default(null)
// Strip legacy client fields such as user_id; ownership comes from req.user.
}).strip();

module.exports = { addressSchema };
