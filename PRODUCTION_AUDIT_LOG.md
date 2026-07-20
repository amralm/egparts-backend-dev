
# Production Audit Log & Fixes

## 1. Checkout Polling 404
- **Problem**: 'CheckoutPayment.jsx' polled non-existent endpoint '/api/payments/status/:orderId'
- **Root Cause**: The backend never implemented this endpoint; it used '/api/orders/:id/tracking' for status.
- **Surgical Fix**: Modified 'CheckoutPayment.jsx' to use the existing tracking endpoint instead of building new backend paths.

## 2. Cart Validation Bypass
- **Problem**: Out-of-stock items could be bought.
- **Root Cause**: Frontend sent '{ items: [...] }', Backend expected 'req.body.ids'.
- **Surgical Fix**: Updated 'routes/storefront.js' to parse 'req.body.items' and extract IDs correctly, reusing existing 'validateCart' logic.

