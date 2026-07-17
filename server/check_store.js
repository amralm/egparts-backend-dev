const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function checkStores() {
  const { data: store, error } = await supabase
    .from('stores')
    .select('*')
    .eq('subdomain', 'egparts')
    .single();

  if (error) {
    console.error('Error fetching egparts store:', error.message);
  } else {
    console.log('egparts store details:', store);
  }
}

checkStores();
