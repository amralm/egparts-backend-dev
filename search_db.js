require('dotenv').config();
const { supabase } = require('./services/supabase');
async function check() {
  const { data, error } = await supabase.rpc('execute_sql', { sql_query: "SELECT proname, prosrc FROM pg_proc WHERE prosrc LIKE '%whatsapp%' OR prosrc LIKE '%notification_queue%';" });
  console.log('Error:', error);
  console.log('Data:', JSON.stringify(data, null, 2));
}
check();
