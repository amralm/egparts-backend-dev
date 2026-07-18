require('dotenv').config({path: 'server/.env'});
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function main() {
  // Try querying the information_schema directly (if exposed)
  const { data: cols, error } = await supabase
    .from('columns')
    .select('table_name, column_name, is_nullable, udt_name')
    .in('table_name', ['payment_intents', 'orders'])
    .in('table_schema', ['public']);
  console.log('columns:', JSON.stringify({ data: cols, error }, null, 2));
}
main();
