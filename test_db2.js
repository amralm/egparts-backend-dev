require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function test() {
  const { data, error } = await supabase.from('site_settings').select('*').limit(1);
  console.log('site_settings:', error || data);

  const { data: themes, error: tErr } = await supabase.from('platform_themes').select('id, name').limit(1);
  console.log('platform_themes:', tErr || themes);
}

test();
