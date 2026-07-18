require('dotenv').config({ path: 'server/.env' });
const { supabase } = require('../services/supabase');

async function inspectStores() {
  try {
    const { data: rows, error: selectErr } = await supabase.from('stores').select('*').limit(1);
    if (selectErr) {
      console.error('Select stores failed:', selectErr);
    } else {
      console.log('Available columns in stores table:', Object.keys(rows[0] || {}));
    }
  } catch (err) {
    console.error('Inspection crashed:', err);
  }
}

inspectStores();
