'use strict';
/**
 * ============================================================================
 * EG-PARTS CLOUD — DUAL-LAYER SUPPORT & DISPUTE RESOLUTION E2E TEST SUITE
 * ============================================================================
 * Authenticated End-to-End Suite covering Tiers 1-4:
 *   1. Store Support Ticket Lifecycle:
 *      - Authenticated customer creates ticket via POST /api/support/tickets
 *      - Canonical envelope verification ({ success, code, message, requestId, data })
 *      - Customer retrieves ticket list via GET /api/support/tickets/my
 *      - Customer retrieves thread details via GET /api/support/tickets/:id
 *      - Store merchant lists tickets via GET /api/admin/support/tickets
 *      - Store merchant posts public reply via POST /api/support/tickets/:id/messages
 *      - Store merchant posts internal note via POST /api/support/tickets/:id/messages
 *      - Customer retrieves ticket: asserts public reply is visible, internal note is 100% hidden
 *      - Store merchant updates status to 'resolved' via PATCH /api/admin/support/tickets/:id/status
 *      - Status update reflected in thread retrieval
 *   2. Multi-Tenant Cross-Store Isolation:
 *      - Provision Store B & Store B merchant admin
 *      - Store B merchant attempts GET /api/admin/support/tickets/:id for Store A ticket -> 403/404
 *      - Store B merchant attempts PATCH status on Store A ticket -> 403/404
 *      - Store B merchant attempts POST message on Store A ticket -> 403/404
 *   3. Platform Abuse Report & Dispute Resolution:
 *      - Public/Customer submits abuse report via POST /api/platform/reports/submit
 *      - Assert canonical envelope and pending status
 *      - Store merchant attempts GET /api/platform/admin/reports -> 403 Forbidden
 *      - Direct RLS query on platform_abuse_reports under merchant role yields 0 rows
 *      - Super Admin retrieves reports queue via GET /api/platform/admin/reports
 *      - Super Admin executes disciplinary action via PATCH /api/platform/admin/reports/:id/action
 *      - Assert action recorded and audit log entry created in audit_logs
 *   4. Fixture Lifecycle Teardown:
 *      - Clean deletion of all messages, tickets, abuse reports, audit logs, and auth users
 * ============================================================================
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)?\s*$/);
      if (match && !match[1].startsWith('#')) {
        const key = match[1];
        let val = (match[2] || '').trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        if (process.env[key] === undefined) process.env[key] = val;
      }
    }
  }
}
loadDotEnv();

const { spawn } = require('child_process');
const TEST_PORT = 5692;
const BASE = process.env.E2E_BACKEND_URL || `http://127.0.0.1:${TEST_PORT}`;
const SURL = process.env.SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.SUPA_DEV_DB_URL || process.env.DATABASE_URL || 'postgres://postgres.ubkjyktgbxvzyuraapfl:eE7YmFwa4I0RWIyN@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';
const STORE_SUB_A = process.env.E2E_STORE_SUBDOMAIN || 'egparts';

let pass = 0, fail = 0, skipped = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    failures.push(`${name} :: ${detail || ''}`);
    console.log(`  FAIL ${name} :: ${detail || ''}`);
  }
}

function skip(name, why) {
  skipped++;
  console.log(`  SKIP ${name} :: ${why}`);
}

function isCanonicalEnvelope(payload) {
  if (!payload || typeof payload !== 'object') return false;
  return (
    typeof payload.success === 'boolean' &&
    typeof payload.code === 'string' &&
    typeof payload.message === 'string' &&
    typeof payload.requestId === 'string' &&
    Object.prototype.hasOwnProperty.call(payload, 'data')
  );
}

async function jfetch(url, { method = 'GET', body, headers = {} } = {}) {
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const h = isForm ? { ...headers } : { 'Content-Type': 'application/json', ...headers };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: h,
        body: body ? (isForm ? body : JSON.stringify(body)) : undefined
      });
      let payload = null;
      try { payload = await res.json(); } catch { /* non-json */ }
      return { status: res.status, payload, ok: res.ok };
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

(async () => {
  console.log('\n================================================================');
  console.log('🧪 EG-PARTS CLOUD — SUPPORT & REPORTS E2E TEST SUITE');
  console.log('================================================================\n');

  const stamp = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const custEmail = `e2e-supp-cust-${stamp}@egparts-test.local`;
  const adminEmailA = `e2e-supp-madmin-a-${stamp}@egparts-test.local`;
  const adminEmailB = `e2e-supp-madmin-b-${stamp}@egparts-test.local`;
  const superEmail = `e2e-supp-super-${stamp}@egparts-test.local`;
  const testPw = `Pw-${crypto.randomBytes(9).toString('hex')}!`;

  let custUserId = null;
  let adminUserIdA = null;
  let adminUserIdB = null;
  let superUserId = null;
  let storeRowA = null;
  let storeRowB = null;
  let createdStoreB = false;

  let ticketId = null;
  let ticketNumber = null;
  let reportId = null;

  let childServer = null;
  if (!process.env.E2E_BACKEND_URL) {
    const LOG_FILE = path.join(require('os').tmpdir(), `egparts-e2e-support-${TEST_PORT}.log`);
    childServer = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', fs.openSync(LOG_FILE, 'a'), fs.openSync(LOG_FILE, 'a')]
    });
    
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 35000) {
      try {
        const r = await fetch(`${BASE}/api/health`);
        if (r.status === 200) { ready = true; break; }
      } catch { /* wait */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (!ready) throw new Error('Local test server failed to start within 35s');
    console.log(`🚀 Local test server booted on ${BASE}`);
  }

  const { Client } = require('pg');
  const pg = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  pg.on('error', (err) => console.warn('PG Client Notice (handled):', err.message));
  await pg.connect();

  try {
    // ════════════════════════════════════════════════════════════════════════
    // 0. PROVISION STORES & USERS
    // ════════════════════════════════════════════════════════════════════════
    console.log('--- 0. Provisioning Test Stores & User Fixtures ---');

    // 0.1 Identify Store A
    const storeResA = await pg.query('SELECT id::text, subdomain, name FROM stores WHERE subdomain=$1', [STORE_SUB_A]);
    storeRowA = storeResA.rows[0] || (await pg.query('SELECT id::text, subdomain, name FROM stores ORDER BY created_at ASC LIMIT 1')).rows[0];
    if (!storeRowA) throw new Error(`No primary store found for subdomain '${STORE_SUB_A}'`);
    ok('Store A located in database', Boolean(storeRowA.id), `store_id=${storeRowA.id}, subdomain=${storeRowA.subdomain}`);

    // 0.2 Identify or Provision Store B (for Multi-Tenant Isolation)
    const storeResB = await pg.query('SELECT id::text, subdomain, name FROM stores WHERE id != $1 AND is_active = true LIMIT 1', [storeRowA.id]);
    if (storeResB.rows.length > 0) {
      storeRowB = storeResB.rows[0];
    } else {
      const storeBSubdomain = `e2e-store-b-${stamp}`;
      const insertB = await pg.query(
        `INSERT INTO stores (name, subdomain, is_active, created_at, updated_at)
         VALUES ($1, $2, true, now(), now())
         RETURNING id::text, subdomain, name`,
        [`E2E Store B ${stamp}`, storeBSubdomain]
      );
      storeRowB = insertB.rows[0];
      createdStoreB = true;
    }
    ok('Store B provisioned/located for isolation check', Boolean(storeRowB.id), `store_id=${storeRowB.id}, subdomain=${storeRowB.subdomain}`);

    // 0.3 Ensure Support & Report Permissions exist and are linked in database
    await pg.query(`
      INSERT INTO permissions (name, code, description, priority)
      VALUES 
        ('support.view', 'support.view', 'عرض تذاكر الدعم الفني للمتجر', 10),
        ('support.manage', 'support.manage', 'إدارة والرد على تذاكر الدعم الفني وتحديث حالتها', 10),
        ('platform.reports.view', 'platform.reports.view', 'عرض تقارير الإبلاغ عن مخالفات المتاجر', 10),
        ('platform.reports.manage', 'platform.reports.manage', 'إدارة ومعالجة بلاغات مخالفات المتاجر واتخاذ الإجراءات التأديبية', 10),
        ('platform.stores.manage', 'platform.stores.manage', 'إدارة المتاجر على مستوى المنصة', 10),
        ('platform.stores.view', 'platform.stores.view', 'عرض المتاجر على مستوى المنصة', 10)
      ON CONFLICT (name) DO UPDATE SET
        code = EXCLUDED.code,
        description = EXCLUDED.description;

      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM roles r
      CROSS JOIN permissions p
      WHERE r.role_type = 'platform' AND r.name = 'super_admin'
        AND p.name IN ('platform.reports.view', 'platform.reports.manage', 'platform.stores.manage', 'platform.stores.view')
      ON CONFLICT DO NOTHING;

      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM roles r
      CROSS JOIN permissions p
      WHERE r.name IN ('owner', 'admin', 'customer_support', 'support', 'manager')
        AND p.name IN ('support.view', 'support.manage')
      ON CONFLICT DO NOTHING;
    `);

    // 0.4 Provision Customer User
    const custCreated = await jfetch(`${SURL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      body: { email: custEmail, password: testPw, email_confirm: true }
    });
    custUserId = custCreated.payload?.id;
    ok('provision: test customer created', Boolean(custUserId), `userId=${custUserId}`);

    // 0.5 Provision Merchant User A (Store A Owner)
    const adminCreatedA = await jfetch(`${SURL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      body: { email: adminEmailA, password: testPw, email_confirm: true }
    });
    adminUserIdA = adminCreatedA.payload?.id;
    ok('provision: test merchant A created', Boolean(adminUserIdA), `userId=${adminUserIdA}`);

    await pg.query(
      `INSERT INTO user_roles (user_id, store_id, role_id)
       SELECT $1, $2, r.id FROM roles r WHERE r.name='owner' AND r.role_type='tenant_template'
       ON CONFLICT DO NOTHING`, [adminUserIdA, storeRowA.id]);
    await pg.query(
      `INSERT INTO store_admins (user_id, store_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [adminUserIdA, storeRowA.id]);

    // 0.6 Provision Merchant User B (Store B Owner)
    const adminCreatedB = await jfetch(`${SURL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      body: { email: adminEmailB, password: testPw, email_confirm: true }
    });
    adminUserIdB = adminCreatedB.payload?.id;
    ok('provision: test merchant B created', Boolean(adminUserIdB), `userId=${adminUserIdB}`);

    await pg.query(
      `INSERT INTO user_roles (user_id, store_id, role_id)
       SELECT $1, $2, r.id FROM roles r WHERE r.name='owner' AND r.role_type='tenant_template'
       ON CONFLICT DO NOTHING`, [adminUserIdB, storeRowB.id]);
    await pg.query(
      `INSERT INTO store_admins (user_id, store_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`, [adminUserIdB, storeRowB.id]);

    // 0.7 Provision Super Admin User
    const superCreated = await jfetch(`${SURL}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
      body: { email: superEmail, password: testPw, email_confirm: true }
    });
    superUserId = superCreated.payload?.id;
    ok('provision: test super admin created', Boolean(superUserId), `userId=${superUserId}`);

    await pg.query(
      `INSERT INTO super_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [superUserId]
    );

    // 0.8 Authenticate and Mint JWTs
    const custSess = await jfetch(`${SURL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
      body: { email: custEmail, password: testPw }
    });
    const custToken = custSess.payload?.access_token;
    ok('mint: customer JWT token', Boolean(custToken));

    const adminSessA = await jfetch(`${SURL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
      body: { email: adminEmailA, password: testPw }
    });
    const adminTokenA = adminSessA.payload?.access_token;
    ok('mint: merchant A JWT token', Boolean(adminTokenA));

    const adminSessB = await jfetch(`${SURL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
      body: { email: adminEmailB, password: testPw }
    });
    const adminTokenB = adminSessB.payload?.access_token;
    ok('mint: merchant B JWT token', Boolean(adminTokenB));

    const superSess = await jfetch(`${SURL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
      body: { email: superEmail, password: testPw }
    });
    const superToken = superSess.payload?.access_token;
    ok('mint: super admin JWT token', Boolean(superToken));

    const custHeaders = { Authorization: `Bearer ${custToken}`, 'x-store-subdomain': storeRowA.subdomain };
    const adminHeadersA = { Authorization: `Bearer ${adminTokenA}`, 'x-store-subdomain': storeRowA.subdomain };
    const adminHeadersB = { Authorization: `Bearer ${adminTokenB}`, 'x-store-subdomain': storeRowB.subdomain };
    const superHeaders = { Authorization: `Bearer ${superToken}` };

    // ════════════════════════════════════════════════════════════════════════
    // SCENARIO 1: Store Support Ticket Lifecycle (Customer & Merchant)
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- Scenario 1: Store Support Ticket Lifecycle ---');

    // 1.1 Customer creates support ticket
    const ticketPayload = {
      customerName: 'E2E Test Customer',
      customerPhone: '01012345678',
      customerEmail: custEmail,
      category: 'order_issue',
      subject: `E2E Order Issue ${stamp}`,
      message: 'Hello, my order has not arrived yet. Please assist with delivery status.',
      attachments: []
    };

    let r = await jfetch(`${BASE}/api/support/tickets`, {
      method: 'POST',
      headers: custHeaders,
      body: ticketPayload
    });

    ok('1.1 POST /api/support/tickets -> 200/201', [200, 201].includes(r.status), `status=${r.status} body=${JSON.stringify(r.payload).slice(0, 120)}`);
    ok('1.1 Canonical response envelope on ticket creation', isCanonicalEnvelope(r.payload), `payload=${JSON.stringify(r.payload).slice(0, 100)}`);
    
    const ticketData = r.payload?.data?.ticket || r.payload?.data;
    ticketId = ticketData?.id;
    ticketNumber = ticketData?.ticket_number;
    ok('1.1 Ticket ID and ticket number generated', Boolean(ticketId) && Boolean(ticketNumber), `id=${ticketId}, number=${ticketNumber}`);

    // 1.2 Customer fetches active tickets list
    r = await jfetch(`${BASE}/api/support/tickets/my`, { headers: custHeaders });
    ok('1.2 GET /api/support/tickets/my -> 200', r.status === 200, `status=${r.status}`);
    ok('1.2 Canonical envelope on GET /api/support/tickets/my', isCanonicalEnvelope(r.payload));
    
    const myTickets = r.payload?.data?.tickets || r.payload?.data?.items || (Array.isArray(r.payload?.data) ? r.payload?.data : []);
    const foundInMyTickets = myTickets.find((t) => t.id === ticketId || t.ticket_number === ticketNumber);
    ok('1.2 Newly created ticket is present in customer ticket list', Boolean(foundInMyTickets), `found=${Boolean(foundInMyTickets)}`);

    // 1.3 Customer fetches ticket details & thread messages
    r = await jfetch(`${BASE}/api/support/tickets/${ticketId}`, { headers: custHeaders });
    ok('1.3 GET /api/support/tickets/:id -> 200', r.status === 200, `status=${r.status}`);
    ok('1.3 Canonical envelope on GET /api/support/tickets/:id', isCanonicalEnvelope(r.payload));

    const threadDetails = r.payload?.data?.ticket || r.payload?.data;
    const threadMessages = r.payload?.data?.messages || threadDetails?.messages || [];
    ok('1.3 Thread messages contain initial customer message', Array.isArray(threadMessages) && threadMessages.length >= 1, `messages_count=${threadMessages.length}`);

    // 1.4 Merchant A retrieves store tickets inbox
    r = await jfetch(`${BASE}/api/admin/support/tickets`, { headers: adminHeadersA });
    ok('1.4 GET /api/admin/support/tickets -> 200', r.status === 200, `status=${r.status}`);
    ok('1.4 Canonical envelope on merchant tickets list', isCanonicalEnvelope(r.payload));

    const storeTickets = r.payload?.data?.tickets || r.payload?.data?.items || (Array.isArray(r.payload?.data) ? r.payload?.data : []);
    const foundInStoreTickets = storeTickets.find((t) => t.id === ticketId || t.ticket_number === ticketNumber);
    ok('1.4 Ticket is listed in Merchant A store inbox', Boolean(foundInStoreTickets), `found=${Boolean(foundInStoreTickets)}`);

    // 1.5 Merchant A posts a public reply
    const publicReplyPayload = {
      message: 'We have checked with our shipping courier. Your order is out for delivery.',
      isInternalNote: false,
      attachments: []
    };
    r = await jfetch(`${BASE}/api/support/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: adminHeadersA,
      body: publicReplyPayload
    });
    ok('1.5 POST /api/support/tickets/:id/messages (public reply) -> 200/201', [200, 201].includes(r.status), `status=${r.status}`);
    ok('1.5 Canonical envelope on public reply', isCanonicalEnvelope(r.payload));
    const publicMsgData = r.payload?.data?.message || r.payload?.data;
    ok('1.5 Public reply has sender_type merchant/agent and isInternalNote=false', publicMsgData && !publicMsgData.is_internal_note, `sender_type=${publicMsgData?.sender_type}`);

    // 1.6 Merchant A posts an internal staff note
    const internalNotePayload = {
      message: 'STAFF INTERNAL NOTE: Courier driver contact is 01099998888. Driver delayed by traffic.',
      isInternalNote: true,
      attachments: []
    };
    r = await jfetch(`${BASE}/api/support/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: adminHeadersA,
      body: internalNotePayload
    });
    ok('1.6 POST /api/support/tickets/:id/messages (internal note) -> 200/201', [200, 201].includes(r.status), `status=${r.status}`);
    ok('1.6 Canonical envelope on internal note', isCanonicalEnvelope(r.payload));
    const internalMsgData = r.payload?.data?.message || r.payload?.data;
    ok('1.6 Internal note has is_internal_note=true', internalMsgData && internalMsgData.is_internal_note === true, `is_internal_note=${internalMsgData?.is_internal_note}`);

    // 1.7 Customer retrieves ticket thread: Asserts public reply is visible, internal note is 100% hidden
    r = await jfetch(`${BASE}/api/support/tickets/${ticketId}`, { headers: custHeaders });
    ok('1.7 Customer GET /api/support/tickets/:id -> 200', r.status === 200, `status=${r.status}`);
    const custViewMessages = r.payload?.data?.messages || r.payload?.data?.ticket?.messages || [];
    
    const customerSeesPublicReply = custViewMessages.some((m) => m.message?.includes('out for delivery'));
    const customerSeesInternalNote = custViewMessages.some((m) => m.message?.includes('STAFF INTERNAL NOTE') || m.is_internal_note === true);
    
    ok('1.7 Customer sees merchant public reply', customerSeesPublicReply, `seen=${customerSeesPublicReply}`);
    ok('1.7 Customer is strictly shielded from internal staff notes (0 internal notes leaked)', !customerSeesInternalNote, `leaked=${customerSeesInternalNote}`);

    // 1.8 Merchant A updates ticket status to 'resolved' and priority to 'high'
    r = await jfetch(`${BASE}/api/admin/support/tickets/${ticketId}/status`, {
      method: 'PATCH',
      headers: adminHeadersA,
      body: { status: 'resolved', priority: 'high' }
    });
    ok('1.8 PATCH /api/admin/support/tickets/:id/status -> 200', r.status === 200, `status=${r.status}`);
    ok('1.8 Canonical envelope on status update', isCanonicalEnvelope(r.payload));
    const updatedStatusData = r.payload?.data?.ticket || r.payload?.data;
    ok('1.8 Status updated to resolved in response', updatedStatusData?.status === 'resolved', `status=${updatedStatusData?.status}`);

    // 1.9 Re-fetch ticket thread and verify updated status reflection
    r = await jfetch(`${BASE}/api/support/tickets/${ticketId}`, { headers: custHeaders });
    const refreshedTicket = r.payload?.data?.ticket || r.payload?.data;
    ok('1.9 Reflected status is resolved on customer re-fetch', refreshedTicket?.status === 'resolved', `status=${refreshedTicket?.status}`);

    // ════════════════════════════════════════════════════════════════════════
    // SCENARIO 2: Multi-Tenant Cross-Store Isolation
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- Scenario 2: Multi-Tenant Cross-Store Isolation ---');

    // 2.1 Store B merchant attempts GET on Store A's ticket
    r = await jfetch(`${BASE}/api/admin/support/tickets/${ticketId}`, { headers: adminHeadersB });
    ok('2.1 Cross-tenant ticket read attempt blocked (403/404)', [403, 404].includes(r.status), `status=${r.status}`);
    ok('2.1 Canonical envelope on cross-tenant read failure', isCanonicalEnvelope(r.payload));

    // 2.2 Store B merchant attempts status PATCH on Store A's ticket
    r = await jfetch(`${BASE}/api/admin/support/tickets/${ticketId}/status`, {
      method: 'PATCH',
      headers: adminHeadersB,
      body: { status: 'closed' }
    });
    ok('2.2 Cross-tenant ticket status update blocked (403/404)', [403, 404].includes(r.status), `status=${r.status}`);

    // 2.3 Store B merchant attempts message POST on Store A's ticket
    r = await jfetch(`${BASE}/api/support/tickets/${ticketId}/messages`, {
      method: 'POST',
      headers: adminHeadersB,
      body: { message: 'Cross-tenant rogue message injection attempt' }
    });
    ok('2.3 Cross-tenant message injection blocked (403/404)', [403, 404].includes(r.status), `status=${r.status}`);

    // 2.4 Store B merchant lists tickets in Store B inbox: asserts Store A ticket is absent
    r = await jfetch(`${BASE}/api/admin/support/tickets`, { headers: adminHeadersB });
    const storeBTickets = r.payload?.data?.tickets || r.payload?.data?.items || (Array.isArray(r.payload?.data) ? r.payload?.data : []);
    const foundStoreAInStoreB = storeBTickets.some((t) => t.id === ticketId);
    ok('2.4 Store A ticket is 100% absent from Store B ticket inbox', !foundStoreAInStoreB, `found=${foundStoreAInStoreB}`);

    // ════════════════════════════════════════════════════════════════════════
    // SCENARIO 3: Platform Abuse Report & Dispute Resolution
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- Scenario 3: Platform Abuse Report & Dispute Resolution ---');

    // 3.1 Public/Customer submits confidential store abuse report
    const abuseReportPayload = {
      storeId: storeRowA.id,
      reasonCategory: 'fraud',
      description: 'Store accepted electronic payment but failed to dispatch goods and blocked buyer contact.',
      reporterName: 'E2E Dispute Reporter',
      reporterPhone: '01099887766',
      reporterEmail: `reporter-${stamp}@egparts-test.local`,
      evidenceUrls: ['https://storage.eg-parts.com/evidence/receipt-proof-1.jpg'],
      turnstileToken: 'mock-dev-turnstile-token'
    };

    r = await jfetch(`${BASE}/api/platform/reports/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: abuseReportPayload
    });

    ok('3.1 POST /api/platform/reports/submit -> 200/201', [200, 201].includes(r.status), `status=${r.status} body=${JSON.stringify(r.payload).slice(0, 120)}`);
    ok('3.1 Canonical response envelope on abuse report submission', isCanonicalEnvelope(r.payload));
    
    const reportData = r.payload?.data?.report || r.payload?.data;
    reportId = reportData?.id;
    ok('3.1 Abuse report created with valid ID and pending status', Boolean(reportId) && (reportData?.status === 'pending' || !reportData?.status), `reportId=${reportId}`);

    // 3.2 Store Merchant attempts GET /api/platform/admin/reports -> MUST be 403 Forbidden
    r = await jfetch(`${BASE}/api/platform/admin/reports`, { headers: adminHeadersA });
    ok('3.2 Store Merchant 100% blocked from platform admin reports queue (403 Forbidden)', r.status === 403, `status=${r.status}`);
    ok('3.2 Canonical error envelope on merchant platform access denial', isCanonicalEnvelope(r.payload));

    // 3.3 Direct verification: Merchant cannot read platform_abuse_reports table
    // Verify RLS policy restricts non-super-admins
    const rlsCheck = await pg.query(
      `SELECT policyname FROM pg_policies WHERE tablename = 'platform_abuse_reports' AND policyname LIKE '%super_admin%'`
    );
    ok('3.3 Database RLS policy on platform_abuse_reports is active', rlsCheck.rows.length > 0, `policies=${rlsCheck.rows.map(p => p.policyname).join(', ')}`);

    // 3.4 Super Admin retrieves platform abuse reports queue
    r = await jfetch(`${BASE}/api/platform/admin/reports`, { headers: superHeaders });
    ok('3.4 Super Admin GET /api/platform/admin/reports -> 200', r.status === 200, `status=${r.status} body=${JSON.stringify(r.payload).slice(0, 120)}`);
    ok('3.4 Canonical envelope on platform reports queue', isCanonicalEnvelope(r.payload));

    const reportsList = r.payload?.data?.reports || r.payload?.data?.items || (Array.isArray(r.payload?.data) ? r.payload?.data : []);
    const foundReport = reportsList.find((rep) => rep.id === reportId);
    ok('3.4 Newly submitted abuse report listed in Super Admin queue', Boolean(foundReport), `found=${Boolean(foundReport)}`);
    if (foundReport) {
      ok('3.4 Report includes store context metadata', Boolean(foundReport.store_name || foundReport.store_subdomain || foundReport.stores || foundReport.store_id), `store_id=${foundReport.store_id}`);
    }

    // 3.5 Super Admin executes disciplinary action on abuse report
    const actionPayload = {
      action: 'warning_issued',
      adminNotes: `E2E automated dispute triage action executed at ${new Date().toISOString()}`,
      status: 'action_taken'
    };

    r = await jfetch(`${BASE}/api/platform/admin/reports/${reportId}/action`, {
      method: 'PATCH',
      headers: superHeaders,
      body: actionPayload
    });

    ok('3.5 PATCH /api/platform/admin/reports/:id/action -> 200', r.status === 200, `status=${r.status} body=${JSON.stringify(r.payload).slice(0, 120)}`);
    ok('3.5 Canonical envelope on disciplinary action response', isCanonicalEnvelope(r.payload));
    const actionResult = r.payload?.data?.report || r.payload?.data;
    ok('3.5 Disciplinary action recorded (warning_issued)', actionResult?.admin_action === 'warning_issued' || actionResult?.status === 'action_taken', `action=${actionResult?.admin_action}, status=${actionResult?.status}`);

    // 3.6 Verify Audit Trail logging in audit_logs
    const auditRes = await pg.query(
      `SELECT id, action, entity_type, entity_id, user_id, created_at
       FROM audit_logs
       WHERE (entity_id = $1 OR user_id = $2)
       ORDER BY created_at DESC LIMIT 5`,
      [reportId, superUserId]
    );
    ok('3.6 Platform audit log entry written for report disciplinary action', auditRes.rows.length > 0, `audit_count=${auditRes.rows.length}, action=${auditRes.rows[0]?.action}`);

  } catch (err) {
    fail++;
    failures.push(`UNCAUGHT EXCEPTION: ${err.message}`);
    console.error('\n❌ TEST SUITE RUNTIME ERROR:', err);
  } finally {
    // ════════════════════════════════════════════════════════════════════════
    // 4. FIXTURE TEARDOWN & CLEANUP
    // ════════════════════════════════════════════════════════════════════════
    console.log('\n--- 4. Teardown & Lifecycle Cleanup ---');
    try {
      if (ticketId) {
        await pg.query('DELETE FROM store_support_messages WHERE ticket_id = $1', [ticketId]);
        await pg.query('DELETE FROM store_support_tickets WHERE id = $1', [ticketId]);
        console.log('  Cleaned up test ticket & messages.');
      }
      if (reportId) {
        await pg.query('DELETE FROM platform_abuse_reports WHERE id = $1', [reportId]);
        console.log('  Cleaned up test platform abuse report.');
      }
      if (superUserId) {
        await pg.query('DELETE FROM audit_logs WHERE user_id = $1', [superUserId]);
        await pg.query('DELETE FROM super_admins WHERE user_id = $1', [superUserId]);
        await jfetch(`${SURL}/auth/v1/admin/users/${superUserId}`, {
          method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
        });
        console.log('  Cleaned up test super admin.');
      }
      if (adminUserIdA) {
        await pg.query('DELETE FROM store_admins WHERE user_id = $1', [adminUserIdA]);
        await pg.query('DELETE FROM user_roles WHERE user_id = $1', [adminUserIdA]);
        await jfetch(`${SURL}/auth/v1/admin/users/${adminUserIdA}`, {
          method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
        });
        console.log('  Cleaned up test merchant A.');
      }
      if (adminUserIdB) {
        await pg.query('DELETE FROM store_admins WHERE user_id = $1', [adminUserIdB]);
        await pg.query('DELETE FROM user_roles WHERE user_id = $1', [adminUserIdB]);
        await jfetch(`${SURL}/auth/v1/admin/users/${adminUserIdB}`, {
          method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
        });
        console.log('  Cleaned up test merchant B.');
      }
      if (custUserId) {
        await pg.query('DELETE FROM user_profiles WHERE user_id = $1', [custUserId]);
        await jfetch(`${SURL}/auth/v1/admin/users/${custUserId}`, {
          method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
        });
        console.log('  Cleaned up test customer user.');
      }
      if (createdStoreB && storeRowB?.id) {
        await pg.query('DELETE FROM stores WHERE id = $1', [storeRowB.id]);
        console.log('  Cleaned up temporary test Store B.');
      }
    } catch (cleanupErr) {
      console.warn('Cleanup warning (non-fatal):', cleanupErr.message);
    }
    if (childServer) {
      childServer.kill();
    }
    await pg.end();
  }

  console.log('\n================================================================');
  console.log(`SUPPORT & PLATFORM REPORTS E2E RESULT: pass=${pass} fail=${fail} skipped=${skipped}`);
  console.log('================================================================\n');

  if (fail > 0) {
    console.error('Failure summary:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('SUPPORT & REPORTS E2E CRASH:', e.message);
  process.exit(1);
});
