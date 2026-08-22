# EG-Parts Cloud — Canonical Architectural Contracts & Golden Paths

**Document Version:** 1.0.0  
**Status:** Permanent Standard Architecture Standard (Active)  
**Scope:** Frontend (Storefront & Admin), Backend (Express API & Middlewares), and Supabase (PostgreSQL & PostgREST).

---

## 1. Unified HTTP Client Standard (`authFetch / apiClient`)

All internal frontend API communication **MUST** flow through the canonical client located at `frontend/src/lib/getAuthToken.js`.

### Mandatory Outbound Headers Injected Automatically:
1. `Content-Type: application/json` — Explicitly enforced for all non-FormData requests.
2. `Authorization: Bearer <jwt_access_token>` — Automatically retrieved and refreshed via Supabase Auth session.
3. `x-store-subdomain` — Injected for multi-tenant isolation and store context resolution.
4. `x-original-host` — Preserves the browser hostname for custom domain routing.
5. `X-Request-ID` — Generated unique request correlation ID for end-to-end tracing across logs.

---

## 2. Universal API Error Contract

All API endpoints return a standardized, structured JSON response on failure:

```json
{
  "success": false,
  "code": "ERROR_CODE_STRING",
  "message": "Human readable Arabic error message for user UI",
  "requestId": "req_123456789",
  "data": null
}
```

---

## 3. Order Lifecycle & Payment Workflows

### 3.1 Payment Methods Standard Enum
* `cod` (or `cash_on_delivery`) — Cash on delivery.
* `card` — Electronic card payment via Paymob iframe/redirection.
* `manual_wallet` — Electronic wallets (Vodafone Cash, InstaPay, Orange Money, Etisalat Cash).

### 3.2 Manual Wallet Golden Path (Self-Healing Contract)
```
[1. User selects manual_wallet in Cart]
        │
        ▼
[2. Complete Order (POST /api/orders)] ──► Calls create_order_atomic
        │
        ▼
[3. Direct Navigation to /payment/upload-proof?orderId=...]
        │
        ▼
[4. Self-Healing Intent Resolution] ──► If intentId is missing, UploadPaymentProof
        │                               calls initiateWalletPayment(orderId) automatically
        ▼
[5. Wallet Info & QR Code Display] ──► Customer transfers funds & uploads receipt
        │
        ▼
[6. Submit Proof (POST /api/payments/wallet/submit-proof)]
        │
        ├── Uploads screenshot image to Cloudflare R2 bucket
        └── Transitions order payment_status to 'waiting_verification'
        │
        ▼
[7. Store Admin Kanban Dashboard] ──► Admin inspects receipt image
        ├── Approve ──► payment_status becomes 'paid'
        └── Reject  ──► payment_status becomes 'failed', prompts customer re-upload
```

---

## 4. Database & PL/pgSQL Standards

1. **No Overloaded Duplicate Signatures:**
   * Every stored procedure (`create_order_atomic`, etc.) must exist as **exactly one unique function** in PostgreSQL `public` schema.
2. **Defensive Parameter & Column Naming:**
   * Procedure parameters must use the `p_` prefix (e.g. `p_user_id`, `p_location_url`, `p_store_id`).
   * Internal variables must use the `v_` prefix (e.g. `v_order_id`, `v_total`).
   * All SQL columns in queries must be qualified with table alias (e.g. `orders.store_id`, `products.stock_quantity`).
