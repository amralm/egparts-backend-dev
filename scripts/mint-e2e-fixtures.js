'use strict';
// Provision E2E fixtures against the DEV Supabase project and emit them as
// shell-safe JSON on stdout. Never prints secrets beyond the short-lived
// access token requested by the operator.
//
// Usage: node scripts/mint-e2e-fixtures.js [--email prefix] [--out file]
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function loadDotEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  }
}

async function main() {
  loadDotEnv();
  const { createClient } = require('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / service key missing (.env)');

  const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  // 1) Resolve default dev store.
  const subdomain = process.argv.includes('--store')
    ? process.argv[process.argv.indexOf('--store') + 1]
    : 'egparts';
  const { data: store, error: storeErr } = await admin
    .from('stores').select('id, subdomain').eq('subdomain', subdomain).maybeSingle();
  if (storeErr || !store) throw new Error(`store '${subdomain}' not found: ${storeErr?.message}`);

  // 2) Ensure customer auth user (idempotent).
  const email = (process.argv.includes('--email')
    ? process.argv[process.argv.indexOf('--email') + 1]
    : 'e2e-customer') + '@dev.local';
  const password = `E2e_${crypto.randomBytes(9).toString('base64url')}!x`;

  const { data: listed } = await admin.auth.admin.listUsers({ perPage: 200, page: 1 });
  let user = listed?.users?.find((u) => u.email === email);
  if (!user) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: 'E2E Customer' }
    });
    if (createErr) throw new Error(`createUser: ${createErr.message}`);
    user = created.user;
  }

  const { data: sess, error: sessErr } = await admin.auth.admin.generateLink({
    type: 'magiclink', email
  });
  void sess; void sessErr;

  // Sign in via public endpoint to obtain a real access token.
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
    || process.env.SUPABASE_ANON_KEY;
  if (!anonKey) throw new Error('anon key missing for sign-in');
  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) {
    // Password may be unknown for a pre-existing user — reset it then retry once.
    await admin.auth.admin.updateUserById(user.id, { password });
    const retry = await fetch(`${url}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    if (!retry.ok) throw new Error(`sign-in failed after reset: ${await retry.text()}`);
  }
  const sessionJson = await (res.ok ? res : await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  })).json();
  if (!sessionJson?.access_token) throw new Error('no access_token in sign-in response');

  // 3) Ensure an active product exists to order.
  let { data: product } = await admin
    .from('products')
    .select('id, name, price')
    .eq('store_id', store.id)
    .eq('is_active', true)
    .eq('is_deleted', false)
    .gt('stock_quantity', 0)
    .limit(1)
    .maybeSingle();

  const out = {
    storeSubdomain: store.subdomain,
    storeId: store.id,
    userId: user.id,
    email,
    accessToken: sessionJson.access_token,
    productId: product?.id || null,
    productName: product?.name || null
  };

  const outIdx = process.argv.indexOf('--out');
  if (outIdx > -1) {
    fs.writeFileSync(process.argv[outIdx + 1], JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ ok: true, out: process.argv[outIdx + 1], hasProduct: !!product }));
  } else {
    console.log(JSON.stringify(out));
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
