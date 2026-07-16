const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: './.env' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function listSessions() {
  console.log('Listing all WhatsApp sessions in Supabase...');
  const { data, error } = await supabase
    .from('whatsapp_sessions')
    .select('id, updated_at');
  
  if (error) {
    console.error('Error listing sessions:', error);
  } else {
    console.log('Sessions found:', data);
  }
}

listSessions();
