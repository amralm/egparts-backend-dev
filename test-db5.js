const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://pfubitpzrmgrnzalcsgr.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmdWJpdHB6cm1ncm56YWxjc2dyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzQyMzI5NywiZXhwIjoyMDkyOTk5Mjk3fQ.gbmiBXM7plPYbF-DoNwxpUCVt-5gjPkHWFU1_y6mAyU');

async function check() {
  const o = await supabase.from('orders').select('store_id').limit(1);
  const p = await supabase.from('payment_providers').select('*').limit(1);
  console.log('Orders:', o.error || o.data);
  console.log('Providers:', p.error || p.data);
}
check();
