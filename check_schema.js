const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function check() {
  try {
    const { data: cols, error: colError } = await supabase
      .from('information_schema_columns')
      .select('column_name, data_type, column_default')
      .eq('table_name', 'site_settings');
    
    // Wait, information_schema is in a different schema, but we can query it if RPC is available,
    // or let's query it via a custom REST call or using supabase client.
    // Actually, in Supabase, we can't query information_schema directly unless it's exposed.
    // Let's see if we can write a database function or check if we can run it.
    // Instead, let's look at the error: duplicate key value violates unique constraint "site_settings_pkey"
    // If the primary key is 'id', and it's an integer, let's check what values exist.
    const { data: rows, error: rowError } = await supabase
      .from('site_settings')
      .select('id, store_id, brand_name');
    console.log('site_settings rows:', { rows, rowError });
  } catch (err) {
    console.error(err);
  }
}

check();
