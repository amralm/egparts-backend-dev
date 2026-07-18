const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://pfubitpzrmgrnzalcsgr.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmdWJpdHB6cm1ncm56YWxjc2dyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzQyMzI5NywiZXhwIjoyMDkyOTk5Mjk3fQ.gbmiBXM7plPYbF-DoNwxpUCVt-5gjPkHWFU1_y6mAyU');

async function testQueries() {
  // 1. Test invoices query with plans
  const { data: invs, error: invErr } = await supabase
    .from('invoices')
    .select('*, stores(name, subdomain), plans(display_name)')
    .limit(1);
    
  console.log('Invoices query err:', invErr);

  // 2. Test store_subscriptions MRR query
  const { data: subs, error: subErr } = await supabase
    .from('store_subscriptions')
    .select('plans(price_monthly)')
    .eq('status', 'active');
    
  console.log('Subs query err:', subErr);
}
testQueries();
