'use strict';

const assert = require('node:assert/strict');
const { createOrderSchema, orderStatusSchema } = require('../schemas/orderSchemas');
const { addressSchema } = require('../schemas/accountSchemas');

function expectInvalid(schema, payload, label) {
  assert.equal(schema.safeParse(payload).success, false, `${label} should be rejected`);
}

function expectValid(schema, payload, label) {
  assert.equal(schema.safeParse(payload).success, true, `${label} should be accepted`);
}

expectValid(addressSchema, {
  title: 'المنزل', phone: '01234567890', city: 'أسيوط', address: 'شارع رئيسي 1', user_id: 'legacy-field'
}, 'legacy address payload');
expectInvalid(addressSchema, { title: 'x', phone: '1', city: '', address: '' }, 'invalid address');
expectInvalid(createOrderSchema, { items: [], paymentMethod: 'cod' }, 'empty order');
expectInvalid(createOrderSchema, {
  items: [{ id: 'p1', qty: 1 }], paymentMethod: 'cod', idempotencyKey: 'short', phone: '01234567890', city: 'Cairo', address: 'Main'
}, 'short idempotency key');
expectValid(createOrderSchema, {
  items: [{ id: 'p1', qty: 1 }], paymentMethod: 'cod', idempotencyKey: 'order-test-123', phone: '01234567890', city: 'Cairo', address: 'Main'
}, 'valid order');
expectInvalid(orderStatusSchema, {}, 'empty status transition');
expectValid(orderStatusSchema, { status: 'confirmed' }, 'valid status transition');

console.log('Contract smoke tests passed');
