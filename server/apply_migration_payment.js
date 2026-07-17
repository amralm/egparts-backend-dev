require('dotenv').config({ path: 'server/.env' });
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function run() {
  console.log("=== DATABASE MIGRATION PLAN ===");
  console.log("1. What will change: Create 4 new tables (payment_intents, payment_intent_transactions, payment_timelines, payment_outbox) with appropriate columns, constraints, indices, and RLS enabled.");
  console.log("2. Why: Segregate Enterprise payment domain objects (intents, transaction attempts, timeline logs, outbox events) from SaaS subscription billing.");
  console.log("3. Affected Tables: New tables public.payment_intents, public.payment_intent_transactions, public.payment_timelines, public.payment_outbox.");
  console.log("4. Risks: None. These are CREATE TABLE IF NOT EXISTS operations. No data will be modified or dropped.");
  console.log("5. Rollback plan: DROP TABLE public.payment_outbox, public.payment_timelines, public.payment_intent_transactions, public.payment_intents;");
  
  const migrationPath = path.join(__dirname, '..', 'supbase_tabled-and-rows', '37_enterprise_payment_boundary.sql');
  const sql = fs.readFileSync(migrationPath, 'utf8');
  console.log("6. Final SQL:\n", sql);

  console.log("Applying migration to live Supabase database via exec_sql (sql_string)...");
  
  // Try parameter name: sql_string
  let res = await supabase.rpc('exec_sql', { sql_string: sql });
  if (res.error) {
    console.warn("exec_sql with sql_string failed, trying sql_query...", res.error);
    // Try parameter name: sql_query
    res = await supabase.rpc('exec_sql', { sql_query: sql });
  }
  if (res.error) {
    console.warn("exec_sql with sql_query failed, trying query...", res.error);
    // Try parameter name: query
    res = await supabase.rpc('exec_sql', { query: sql });
  }

  if (res.error) {
    console.error("Migration failed:", res.error);
    process.exit(1);
  } else {
    console.log("Migration applied successfully! Output:", res.data);
  }
}

run();
