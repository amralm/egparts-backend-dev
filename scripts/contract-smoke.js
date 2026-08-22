'use strict';

const assert = require('node:assert/strict');
const { createOrderSchema, orderStatusSchema } = require('../schemas/orderSchemas');
const { addressSchema } = require('../schemas/accountSchemas');
const errorHandler = require('../middleware/errorHandler');
const responseContract = require('../middleware/responseContract');
const apiNotFound = require('../middleware/apiNotFound');
const jsonContract = require('../middleware/jsonContract');
const { sendSuccess } = require('../utils/apiResponse');
const { apiError } = require('../utils/apiError');

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
assert.equal(createOrderSchema.parse({
  items: [{ id: 'p1', qty: 1 }], paymentMethod: 'paymob', idempotencyKey: 'legacy-paymob-1', phone: '01234567890', city: 'Cairo', address: 'Main'
}).paymentMethod, 'card', 'legacy Paymob input must normalize to canonical card');
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

// sendSuccess: canonical envelope + legacy top-level spread + message promotion.
let successPayload;
let successStatus;
const successRes = {
  status(code) { successStatus = code; return this; },
  json(payload) { successPayload = payload; return this; }
};
successRes.req = { id: 'req_success_test' };
sendSuccess(successRes, { methods: [{ id: 'cod' }], message: 'تم جلب وسائل الدفع' });
assert.equal(successStatus, 200, 'sendSuccess default status');
assert.deepEqual(successPayload, {
  success: true,
  code: 'OK',
  message: 'تم جلب وسائل الدفع',
  requestId: 'req_success_test',
  data: { methods: [{ id: 'cod' }], message: 'تم جلب وسائل الدفع' },
  methods: [{ id: 'cod' }]
}, 'success envelope with legacy spread and promoted business message');

let emptySuccessPayload;
const emptySuccessRes = {
  status(code) { this.statusCode = code; return this; },
  json(payload) { emptySuccessPayload = payload; return this; }
};
emptySuccessRes.req = { correlationId: 'req_empty_ok' };
sendSuccess(emptySuccessRes, {}, { code: 'WISHLIST_CLEARED', status: 201 });
assert.equal(emptySuccessRes.statusCode, 201, 'sendSuccess custom status');
assert.equal(emptySuccessPayload.code, 'WISHLIST_CLEARED', 'sendSuccess custom code');
assert.deepEqual(emptySuccessPayload.data, {}, 'empty payload normalizes to {}');
assert.equal(emptySuccessPayload.requestId, 'req_empty_ok', 'requestId from correlationId fallback');

// apiError with explicit UI-required scalar data keeps legacy top-level mirror.
let couponErrorPayload;
const couponErrorRes = {
  status(code) { this.statusCode = code; return this; },
  json(payload) { couponErrorPayload = payload; return this; }
};
couponErrorRes.req = { id: 'req_coupon_err' };
apiError(couponErrorRes, 400, 'تعذر تطبيق كود الخصم.', 'COUPON_MIN_ORDER_NOT_MET', { min_order_value: 250 });
assert.equal(couponErrorRes.statusCode, 400, 'apiError status');
assert.equal(couponErrorPayload.requestId, 'req_coupon_err', 'apiError requestId');
assert.equal(couponErrorPayload.min_order_value, 250, 'legacy top-level error scalar');
assert.deepEqual(couponErrorPayload.data, { min_order_value: 250 }, 'canonical error data');

// jsonContract: missing or unsupported Content-Type on a non-empty body is 415.
function runJsonContract(headers, body, expectTermination, label) {
  let passedNext = false;
  let rejectedPayload;
  const res = {
    statusCode: 0,
    status(code) { this.statusCode = code; return this; },
    json(payload) { rejectedPayload = payload; return this; }
  };
  res.req = { id: 'req_ct_test' };
  jsonContract({
    path: '/api/account/addresses',
    method: 'POST',
    headers,
    body
  }, res, () => { passedNext = true; });
  if (expectTermination) {
    assert.equal(passedNext, false, `${label} must terminate`);
    assert.equal(res.statusCode, 415, `${label} must answer 415`);
    assert.equal(rejectedPayload.code, 'UNSUPPORTED_CONTENT_TYPE', `${label} stable code`);
    assert.equal(rejectedPayload.success, false, `${label} failure flag`);
  } else {
    assert.equal(passedNext, true, `${label} must pass through`);
  }
}

runJsonContract({ 'content-type': 'text/plain', 'content-length': '30' }, '{"title":"wrong ct"}', true, 'text/plain JSON body');
runJsonContract({ 'content-length': '30' }, '{"title":"missing ct"}', true, 'missing content-type');
runJsonContract({ 'content-type': 'application/xml', 'content-length': '12' }, '<x/>', true, 'unsupported xml body');
runJsonContract({ 'content-type': 'application/json', 'content-length': '20' }, { title: 'ok' }, false, 'valid application/json');
runJsonContract({ 'content-type': 'application/json;charset=utf-8', 'content-length': '20' }, { title: 'ok' }, false, 'json with charset suffix');
runJsonContract({ 'content-type': 'multipart/form-data; boundary=x', 'content-length': '400' }, {}, false, 'multipart upload');
runJsonContract({ 'content-type': 'application/x-www-form-urlencoded', 'content-length': '18' }, 'a=1&b=2', false, 'form encoded webhook');
runJsonContract({}, undefined, false, 'bodyless DELETE passes');

console.log('Contract smoke tests passed');
