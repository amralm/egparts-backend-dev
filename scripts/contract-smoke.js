'use strict';

const assert = require('node:assert/strict');
const { createOrderSchema, orderStatusSchema } = require('../schemas/orderSchemas');
const { addressSchema } = require('../schemas/accountSchemas');
const errorHandler = require('../middleware/errorHandler');
const responseContract = require('../middleware/responseContract');
const apiNotFound = require('../middleware/apiNotFound');
const jsonContract = require('../middleware/jsonContract');

function expectInvalid(schema, payload, label) {
  assert.equal(schema.safeParse(payload).success, false, `${label} should be rejected`);
}

function expectValid(schema, payload, label) {
  assert.equal(schema.safeParse(payload).success, true, `${label} should be accepted`);
}

expectValid(addressSchema, {
  title: 'المنزل', phone: '01234567890', city: 'أسيوط', address: 'شارع رئيسي 1', location_url: '', user_id: 'legacy-field'
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

let capturedErrorResponse;
const errorRes = {
  status(code) { this.statusCode = code; return this; },
  json(payload) { capturedErrorResponse = payload; return this; }
};
errorHandler(Object.assign(new Error('contract test'), { code: 'CONTRACT_TEST' }), {
  id: 'req_contract_test', method: 'GET', url: '/contract-test', body: {}, query: {}, headers: {}
}, errorRes);
assert.equal(errorRes.statusCode, 500, 'error handler status');
assert.deepEqual(
  { success: capturedErrorResponse.success, code: capturedErrorResponse.code, message: capturedErrorResponse.message, requestId: capturedErrorResponse.requestId, data: capturedErrorResponse.data },
  { success: false, code: 'CONTRACT_TEST', message: 'Internal Server Error', requestId: 'req_contract_test', data: null },
  'error response contract'
);

let legacyPayload;
const legacyRes = {
  statusCode: 404,
  json(payload) { legacyPayload = payload; return this; }
};
responseContract({ id: 'req_legacy_contract' }, legacyRes, () => {});
legacyRes.json({ error: 'Not found' });
assert.deepEqual(
  { success: legacyPayload.success, code: legacyPayload.code, message: legacyPayload.message, requestId: legacyPayload.requestId, data: legacyPayload.data },
  { success: false, code: 'HTTP_404', message: 'Not found', requestId: 'req_legacy_contract', data: null },
  'legacy error response compatibility contract'
);

let notFoundPayload;
let notFoundStatus;
const notFoundRes = {
  status(code) { notFoundStatus = code; return this; },
  json(payload) { notFoundPayload = payload; return this; }
};
apiNotFound({ path: '/api/missing-endpoint', correlationId: 'req_not_found' }, notFoundRes, () => {
  throw new Error('API 404 middleware must terminate API requests');
});
assert.equal(notFoundStatus, 404);
assert.deepEqual(notFoundPayload, {
  success: false,
  code: 'ROUTE_NOT_FOUND',
  message: 'المسار المطلوب غير موجود.',
  requestId: 'req_not_found',
  data: null
});

// The response wrapper must be installed before guards that can terminate
// early, such as the text/plain JSON guard.
let contentTypePayload;
const contentTypeRes = {
  statusCode: 200,
  status(code) { this.statusCode = code; return this; },
  json(payload) { contentTypePayload = payload; return this; }
};
responseContract({ id: 'req_content_type' }, contentTypeRes, () => {});
jsonContract({
  path: '/api/account/addresses',
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: '{"title":"wrong content type"}'
}, contentTypeRes, () => {
  throw new Error('JSON content-type guard must terminate invalid payloads');
});
assert.deepEqual(
  { success: contentTypePayload.success, code: contentTypePayload.code, message: contentTypePayload.message, requestId: contentTypePayload.requestId, data: contentTypePayload.data },
  { success: false, code: 'UNSUPPORTED_CONTENT_TYPE', message: 'صيغة الطلب غير مدعومة.', requestId: 'req_content_type', data: null },
  'early content-type error response contract'
);

console.log('Contract smoke tests passed');
