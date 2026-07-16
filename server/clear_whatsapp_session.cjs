const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: './.env' });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function clearSession() {
  console.log('Clearing WhatsApp session from Supabase...');
  const { error } = await supabase
    .from('whatsapp_sessions')
    .delete()
    .like('id', 'main_whatsapp_session%');
  
  if (error) {
    console.error('Error clearing session:', error);
  } else {
    console.log('✅ Session cleared successfully.');
  }
}

clearSession();
