'use strict';
/**
 * ============================================================================
 * CHALLENGER 1: ADVERSARIAL SECURITY & MULTI-TENANT ISOLATION PROBE
 * ============================================================================
 * Probes:
 *   1. Cross-tenant isolation (queries, updates, message posts across distinct store IDs)
 *   2. Internal note leakage (customer thread retrieval, list retrieval, guest retrieval)
 *   3. Platform abuse report access authorization (merchant role 403 Forbidden, RLS check)
 *   4. Route mount and contract alignment (ORIGINAL_REQUEST.md vs server.js mount points)
 *   5. Permission code audit (support.view/support.manage vs settings.view)
 * ============================================================================
 */

const { spawn } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PORT = 5598;
const BASE = `http://127.0.0.1:${PORT}`;
const LOG_FILE = path.join(require('os').tmpdir(), `egparts-challenger-${PORT}.log`);

const SURL = process.env.SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = 'postgres://postgres.ubkjyktgbxvzyuraapfl:eE7YmFwa4I0RWIyN@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';

let pass = 0, fail = 0;
const probeResults = [];

function recordResult(probeId, name, success, details) {
  if (success) {
    pass++;
    console.log(`  [PASS] [${probeId}] ${name}`);
  } else {
    fail++;
    console.log(`  [FAIL] [${probeId}] ${name} -> ${details}`);
  }
  probeResults.push({ probeId, name, success, details });
}

function request(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const isJson = body && typeof body === 'object' && !(body instanceof Buffer);
    const bodyStr = isJson ? JSON.stringify(body) : (body || null);
    const finalHeaders = { ...headers };
    if (isJson && !finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
      finalHeaders['Content-Type'] = 'application/json';
    }

    const parsedUrl = new URL(`${BASE}${urlPath}`);
    const req = http.request(parsedUrl, { method, headers: finalHeaders }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let payload = null;
        try { payload = JSON.parse(data); } catch { payload = data; }
        resolve({ status: res.statusCode, headers: res.headers, payload, raw: data, ok: res.statusCode >= 200 && res.statusCode < 300 });
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
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

async function waitForHealth(timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const r = await request('GET', '/api/health');
      if (r.status === 200) return true;
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}

(async () => {
  console.log('\n================================================================');
  console.log('⚔️  CHALLENGER 1: ADVERSARIAL SECURITY & BEHAVIORAL HARNESS');
  console.log('================================================================\n');

  const { Client } = require('pg');
  const pg = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await pg.connect();

  const stamp = Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const custEmail = `probe-cust-${stamp}@egparts-test.local`;
  const merchantEmailA = `probe-merch-a-${stamp}@egparts-test.local`;
  const merchantEmailB = `probe-merch-b-${stamp}@egparts-test.local`;
  const superEmail = `probe-super-${stamp}@egparts-test.local`;
  const testPw = `Pw-${crypto.randomBytes(9).toString('hex')}!`;

  let custUserId = null;
  let merchUserIdA = null;
  let merchUserIdB = null;
  let superUserId = null;
  let storeA = null;
  let storeB = null;
  let createdStoreB = false;

  let ticketAId = null;
  let reportId = null;

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', fs.openSync(LOG_FILE, 'w'), fs.openSync(LOG_FILE, 'w')]
  });
  console.log(`Server child spawned (pid=${child.pid}, log=${LOG_FILE})`);

  try {
    const ready = await waitForHealth();
    if (!ready) {
      throw new Error(`Server failed to start on port ${PORT} within timeout`);
    }
    console.log('Server is healthy and ready for adversarial probing.\n');

    // 1. Locate Store A and Store B
    const storeResA = await pg.query('SELECT id::text, subdomain, name FROM stores WHERE is_active=true ORDER BY created_at ASC LIMIT 1');
    storeA = storeResA.rows[0];
    if (!storeA) throw new Error('No active store found in database');

    const storeResB = await pg.query('SELECT id::text, subdomain, name FROM stores WHERE id != $1 AND is_active=true LIMIT 1', [storeA.id]);
    if (storeResB.rows.length > 0) {
      storeB = storeResB.rows[0];
    } else {
      const insB = await pg.query(
        `INSERT INTO stores (name, subdomain, is_active, created_at, updated_at)
         VALUES ($1, $2, true, now(), now()) RETURNING id::text, subdomain, name`,
        [`Probe Store B ${stamp}`, `probe-store-b-${stamp}`]
      );
      storeB = insB.rows[0];
      createdStoreB = true;
    }

    // 2. Provision Supabase Auth Users
    const createAuth = async (email) => {
      const res = await jfetch(`${SURL}/auth/v1/admin/users`, {
        method: 'POST',
        headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` },
        body: { email, password: testPw, email_confirm: true }
      });
      if (!res.payload?.id) {
        throw new Error(`Failed to create auth user for ${email}: status=${res.status} payload=${JSON.stringify(res.payload)}`);
      }
      return res.payload.id;
    };

    custUserId = await createAuth(custEmail);
    merchUserIdA = await createAuth(merchantEmailA);
    merchUserIdB = await createAuth(merchantEmailB);
    superUserId = await createAuth(superEmail);

    // Ensure user_roles and store_admins mapping
    await pg.query(`
      INSERT INTO user_roles (user_id, store_id, role_id)
      SELECT $1, $2, r.id FROM roles r WHERE r.name='owner' AND r.role_type='tenant_template'
      ON CONFLICT DO NOTHING`, [merchUserIdA, storeA.id]);
    await pg.query(`INSERT INTO store_admins (user_id, store_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [merchUserIdA, storeA.id]);

    await pg.query(`
      INSERT INTO user_roles (user_id, store_id, role_id)
      SELECT $1, $2, r.id FROM roles r WHERE r.name='owner' AND r.role_type='tenant_template'
      ON CONFLICT DO NOTHING`, [merchUserIdB, storeB.id]);
    await pg.query(`INSERT INTO store_admins (user_id, store_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [merchUserIdB, storeB.id]);

    await pg.query(`INSERT INTO super_admins (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [superUserId]);

    // Ensure permissions and role_permissions exist
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

    // Mint tokens
    const mintToken = async (email) => {
      const sess = await jfetch(`${SURL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: ANON, Authorization: `Bearer ${ANON}` },
        body: { email, password: testPw }
      });
      return sess.payload?.access_token;
    };

    const custToken = await mintToken(custEmail);
    const merchTokenA = await mintToken(merchantEmailA);
    const merchTokenB = await mintToken(merchantEmailB);
    const superToken = await mintToken(superEmail);

    const custHeaders = { Authorization: `Bearer ${custToken}`, 'x-store-subdomain': storeA.subdomain };
    const merchHeadersA = { Authorization: `Bearer ${merchTokenA}`, 'x-store-subdomain': storeA.subdomain };
    const merchHeadersB = { Authorization: `Bearer ${merchTokenB}`, 'x-store-subdomain': storeB.subdomain };
    const superHeaders = { Authorization: `Bearer ${superToken}` };

    console.log('--- PROBE 1: Cross-Tenant Access & Isolation ---');

    // Create a support ticket in Store A
    const tktRes = await request('POST', '/api/support/tickets', {
      headers: custHeaders,
      body: {
        customerName: 'Probe Customer',
        customerPhone: '01011112222',
        customerEmail: custEmail,
        category: 'order_issue',
        subject: `Adversarial Probe Subject ${stamp}`,
        message: 'Adversarial probe initial customer message',
        attachments: []
      }
    });

    const tktData = tktRes.payload?.data?.ticket || tktRes.payload?.data;
    ticketAId = tktData?.id;
    recordResult('P1.0', 'Ticket creation in Store A', Boolean(ticketAId), `ticket_id=${ticketAId}`);

    // Probe 1.1: Store B merchant attempts to read Store A ticket via GET /api/support/tickets/:id with Store B context
    const crossReadRes = await request('GET', `/api/support/tickets/${ticketAId}`, {
      headers: merchHeadersB
    });
    const crossReadBlocked = crossReadRes.status === 404 || crossReadRes.status === 403 || crossReadRes.payload?.data?.ticket === null || !crossReadRes.payload?.data?.ticket;
    recordResult(
      'P1.1',
      'Merchant B blocked from reading Store A ticket via /api/support/tickets/:id',
      crossReadBlocked,
      `status=${crossReadRes.status}, data=${JSON.stringify(crossReadRes.payload?.data)}`
    );

    // Probe 1.2: Store B merchant attempts to post message to Store A ticket via POST /api/support/tickets/:id/messages
    const crossMsgRes = await request('POST', `/api/support/tickets/${ticketAId}/messages`, {
      headers: merchHeadersB,
      body: { message: 'Cross-tenant rogue message injection attempt' }
    });
    const crossMsgBlocked = [400, 403, 404].includes(crossMsgRes.status) && crossMsgRes.payload?.success === false;
    recordResult(
      'P1.2',
      'Merchant B blocked from posting message to Store A ticket',
      crossMsgBlocked,
      `status=${crossMsgRes.status}, payload=${JSON.stringify(crossMsgRes.payload)}`
    );

    // Probe 1.3: Store B merchant lists tickets in Store B
    const listResB = await request('GET', '/api/support/admin/tickets', {
      headers: merchHeadersB
    });
    const storeBTickets = listResB.payload?.data?.tickets || [];
    const leakedTicketInStoreB = storeBTickets.some((t) => t.id === ticketAId);
    recordResult(
      'P1.3',
      'Store A ticket is completely absent from Store B ticket list query',
      !leakedTicketInStoreB,
      `leaked=${leakedTicketInStoreB}, totalInB=${storeBTickets.length}`
    );

    // Probe 1.4: Cross-tenant status update attempt (Store B merchant updating Store A ticket)
    const crossPatchRes = await request('PATCH', `/api/support/admin/tickets/${ticketAId}/status`, {
      headers: merchHeadersB,
      body: { status: 'closed' }
    });
    const crossPatchBlocked = [400, 403, 404].includes(crossPatchRes.status) && crossPatchRes.payload?.success === false;
    recordResult(
      'P1.4',
      'Merchant B blocked from updating status of Store A ticket',
      crossPatchBlocked,
      `status=${crossPatchRes.status}, payload=${JSON.stringify(crossPatchRes.payload)}`
    );

    console.log('\n--- PROBE 2: Internal Note Leakage Prevention ---');

    // Merchant A adds a public response
    const pubMsgRes = await request('POST', `/api/support/tickets/${ticketAId}/messages`, {
      headers: merchHeadersA,
      body: {
        message: 'PUBLIC MERCHANT REPLY: We are processing your request.',
        isInternalNote: false
      }
    });
    recordResult('P2.1', 'Merchant A posts public reply', [200, 201].includes(pubMsgRes.status), `status=${pubMsgRes.status}`);

    // Merchant A adds a confidential internal note
    const privMsgRes = await request('POST', `/api/support/tickets/${ticketAId}/messages`, {
      headers: merchHeadersA,
      body: {
        message: 'INTERNAL CONFIDENTIAL NOTE: Suspected abusive customer, do not refund.',
        isInternalNote: true
      }
    });
    recordResult('P2.2', 'Merchant A posts internal note', [200, 201].includes(privMsgRes.status), `status=${privMsgRes.status}`);

    // Probe 2.3 & 2.4: Customer fetches ticket thread
    const custFetchRes = await request('GET', `/api/support/tickets/${ticketAId}`, {
      headers: custHeaders
    });
    const custMessages = custFetchRes.payload?.data?.ticket?.messages || custFetchRes.payload?.data?.messages || [];
    const leakedInternalMsg = custMessages.some((m) =>
      m.message?.includes('INTERNAL CONFIDENTIAL NOTE') ||
      m.is_internal_note === true
    );
    const sawPublicMsg = custMessages.some((m) =>
      m.message?.includes('PUBLIC MERCHANT REPLY')
    );

    recordResult(
      'P2.3',
      'Customer retrieves ticket thread: public reply is visible',
      sawPublicMsg,
      `messages_count=${custMessages.length}`
    );
    recordResult(
      'P2.4',
      'Customer retrieves ticket thread: 0 internal notes leaked (is_internal_note: true is 100% stripped)',
      !leakedInternalMsg,
      `leaked=${leakedInternalMsg}, messages=${JSON.stringify(custMessages)}`
    );

    // Probe 2.5: Guest / Unauthenticated customer fetches ticket thread
    const guestFetchRes = await request('GET', `/api/support/tickets/${ticketAId}`, {
      headers: { 'x-store-subdomain': storeA.subdomain }
    });
    const guestMessages = guestFetchRes.payload?.data?.ticket?.messages || guestFetchRes.payload?.data?.messages || [];
    const guestLeakedInternal = guestMessages.some((m) =>
      m.message?.includes('INTERNAL CONFIDENTIAL NOTE') ||
      m.is_internal_note === true
    );
    recordResult(
      'P2.5',
      'Unauthenticated/Guest request: 0 internal notes leaked',
      !guestLeakedInternal,
      `guest_messages=${guestMessages.length}`
    );

    console.log('\n--- PROBE 3: Unauthorized Platform Abuse Report Access (RBAC) ---');

    // Submit a platform abuse report
    const submitReportRes = await request('POST', '/api/platform/reports/submit', {
      headers: { 'x-store-subdomain': storeA.subdomain },
      body: {
        storeId: storeA.id,
        reporterName: 'Adversarial Reporter',
        reporterPhone: '01055556666',
        reporterEmail: custEmail,
        reasonCategory: 'fraud',
        description: 'Test fraud report for RBAC probe',
        evidenceUrls: ['https://example.com/evidence1.png']
      }
    });

    const reportData = submitReportRes.payload?.data?.report || submitReportRes.payload?.data;
    reportId = reportData?.id;
    recordResult('P3.0', 'Platform abuse report submitted', Boolean(reportId), `reportId=${reportId}`);

    // Probe 3.1: Store Merchant A attempts to query platform abuse reports -> MUST BE 403 Forbidden
    const merchReportQueryRes = await request('GET', '/api/platform/admin/reports', {
      headers: merchHeadersA
    });
    recordResult(
      'P3.1',
      'Store Merchant A receives 403 Forbidden when accessing /api/platform/admin/reports',
      merchReportQueryRes.status === 403,
      `status=${merchReportQueryRes.status}, payload=${JSON.stringify(merchReportQueryRes.payload)}`
    );

    // Probe 3.2: Store Merchant A attempts to read specific report -> MUST BE 403 Forbidden
    const merchReportDetailRes = await request('GET', `/api/platform/admin/reports/${reportId}`, {
      headers: merchHeadersA
    });
    recordResult(
      'P3.2',
      'Store Merchant A receives 403 Forbidden when accessing /api/platform/admin/reports/:id',
      merchReportDetailRes.status === 403,
      `status=${merchReportDetailRes.status}`
    );

    // Probe 3.3: Store Merchant A attempts to action a report -> MUST BE 403 Forbidden
    const merchReportActionRes = await request('PATCH', `/api/platform/admin/reports/${reportId}/action`, {
      headers: merchHeadersA,
      body: { status: 'dismissed', adminAction: 'dismissed' }
    });
    recordResult(
      'P3.3',
      'Store Merchant A receives 403 Forbidden when attempting PATCH /api/platform/admin/reports/:id/action',
      merchReportActionRes.status === 403,
      `status=${merchReportActionRes.status}`
    );

    // Probe 3.4: Customer attempts to access platform reports -> MUST BE 403 Forbidden
    const custReportQueryRes = await request('GET', '/api/platform/admin/reports', {
      headers: custHeaders
    });
    recordResult(
      'P3.4',
      'Customer receives 403 Forbidden when accessing /api/platform/admin/reports',
      custReportQueryRes.status === 403,
      `status=${custReportQueryRes.status}`
    );

    // Probe 3.5: Super Admin accesses reports -> 200 OK
    const superReportQueryRes = await request('GET', '/api/platform/admin/reports', {
      headers: superHeaders
    });
    recordResult(
      'P3.5',
      'Super Admin receives 200 OK when accessing /api/platform/admin/reports',
      superReportQueryRes.status === 200,
      `status=${superReportQueryRes.status}`
    );

    console.log('\n--- PROBE 4: Route Mount Parity & Specification Alignment ---');

    // Probe 4.1: Check if /api/admin/support/tickets (as specified in ORIGINAL_REQUEST.md R2) is mounted
    const reqAdminSupportRes = await request('GET', '/api/admin/support/tickets', {
      headers: merchHeadersA
    });
    const adminSupportMounted = reqAdminSupportRes.status !== 404;
    recordResult(
      'P4.1',
      'Check if /api/admin/support/tickets is mounted (R2 specification contract)',
      adminSupportMounted,
      `status=${reqAdminSupportRes.status} (server.js mounted /api/support with /admin/tickets resulting in /api/support/admin/tickets instead of /api/admin/support/tickets)`
    );

    // Probe 4.2: Check if /api/support/admin/tickets is reachable
    const reqSupportAdminRes = await request('GET', '/api/support/admin/tickets', {
      headers: merchHeadersA
    });
    recordResult(
      'P4.2',
      'Check if /api/support/admin/tickets is reachable',
      reqSupportAdminRes.status === 200,
      `status=${reqSupportAdminRes.status}`
    );

    console.log('\n--- PROBE 5: Permission & RBAC Mapping Audit ---');
    // Probe 5.1: Check permission names used in backend/routes/support.js
    const supportRouteContent = fs.readFileSync(path.join(__dirname, '../routes/support.js'), 'utf8');
    const usesSupportView = supportRouteContent.includes("'support.view'") || supportRouteContent.includes('"support.view"');
    const usesSupportManage = supportRouteContent.includes("'support.manage'") || supportRouteContent.includes('"support.manage"');
    const usesSettingsView = supportRouteContent.includes("'settings.view'");

    recordResult(
      'P5.1',
      "Verify routes use 'support.view' and 'support.manage' permissions seeded in M1 (not fallback 'settings.view')",
      usesSupportView && usesSupportManage,
      `usesSupportView=${usesSupportView}, usesSupportManage=${usesSupportManage}, usesSettingsView=${usesSettingsView}`
    );

  } catch (err) {
    fail++;
    console.error('PROBE SUITE ERROR:', err);
  } finally {
    console.log('\n--- Teardown Probe Fixtures ---');
    child.kill('SIGKILL');
    if (ticketAId) {
      await pg.query('DELETE FROM store_support_messages WHERE ticket_id = $1', [ticketAId]);
      await pg.query('DELETE FROM store_support_tickets WHERE id = $1', [ticketAId]);
    }
    if (reportId) {
      await pg.query('DELETE FROM platform_abuse_reports WHERE id = $1', [reportId]);
    }
    if (superUserId) {
      await pg.query('DELETE FROM audit_logs WHERE user_id = $1', [superUserId]);
      await pg.query('DELETE FROM super_admins WHERE user_id = $1', [superUserId]);
      await jfetch(`${SURL}/auth/v1/admin/users/${superUserId}`, {
        method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
      });
    }
    if (merchUserIdA) {
      await pg.query('DELETE FROM store_admins WHERE user_id = $1', [merchUserIdA]);
      await pg.query('DELETE FROM user_roles WHERE user_id = $1', [merchUserIdA]);
      await jfetch(`${SURL}/auth/v1/admin/users/${merchUserIdA}`, {
        method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
      });
    }
    if (merchUserIdB) {
      await pg.query('DELETE FROM store_admins WHERE user_id = $1', [merchUserIdB]);
      await pg.query('DELETE FROM user_roles WHERE user_id = $1', [merchUserIdB]);
      await jfetch(`${SURL}/auth/v1/admin/users/${merchUserIdB}`, {
        method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
      });
    }
    if (custUserId) {
      await pg.query('DELETE FROM user_profiles WHERE user_id = $1', [custUserId]);
      await jfetch(`${SURL}/auth/v1/admin/users/${custUserId}`, {
        method: 'DELETE', headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` }
      });
    }
    if (createdStoreB && storeB?.id) {
      await pg.query('DELETE FROM stores WHERE id = $1', [storeB.id]);
    }
    await pg.end();
  }

  console.log('\n================================================================');
  console.log(`PROBE RESULTS SUMMARY: pass=${pass} fail=${fail}`);
  console.log('================================================================\n');

  if (fail > 0) {
    process.exit(1);
  }
})();
