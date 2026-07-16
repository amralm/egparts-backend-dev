const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function check() {
  try {
    const { data, error } = await supabase.rpc('get_my_stores');
    console.log('Stores connection test:', { data, error });

    // Fetch column info
    const { data: cols, error: colError } = await supabase
      .from('products')
      .select('*')
      .limit(1);
    
    if (colError) {
      console.error('Error fetching product:', colError);
    } else {
      console.log('Product columns:', Object.keys(cols[0] || {}));
      console.log('Product sample:', cols[0]);
    }
  } catch (err) {
    console.error(err);
  }
}

check();
