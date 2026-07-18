const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

// Read server/.env and populate process.env
const envContent = fs.readFileSync('server/.env', 'utf8');
const env = require('dotenv').parse(envContent);
const url = env.SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_KEY;

const supabase = createClient(url, serviceKey);

async function main() {
  try {
    console.log('Querying RLS policies via exec_sql RPC...');
    const { data: policies, error: polErr } = await supabase.rpc('exec_sql', {
      query: `SELECT tablename, policyname, permissive, roles, cmd, qual, with_check FROM pg_policies WHERE tablename = 'site_settings'`
    });

    if (polErr) {
      console.error('Error fetching policies:', polErr);
    } else {
      console.log('=== POLICIES ===');
      console.log(JSON.stringify(policies, null, 2));
    }

    console.log('Querying triggers via exec_sql RPC...');
    const { data: triggers, error: trigErr } = await supabase.rpc('exec_sql', {
      query: `SELECT trigger_name, event_manipulation, action_statement FROM information_schema.triggers WHERE event_object_table = 'site_settings'`
    });

    if (trigErr) {
      console.error('Error fetching triggers:', trigErr);
    } else {
      console.log('=== TRIGGERS ===');
      console.log(JSON.stringify(triggers, null, 2));
    }

  } catch (err) {
    console.error('Exception:', err);
  }
}

main();
