const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://pfubitpzrmgrnzalcsgr.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmdWJpdHB6cm1ncm56YWxjc2dyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzQyMzI5NywiZXhwIjoyMDkyOTk5Mjk3fQ.gbmiBXM7plPYbF-DoNwxpUCVt-5gjPkHWFU1_y6mAyU');

async function check() {
  const r = await supabase.from('refunds').select('*').limit(1);
  const p = await supabase.from('payments').select('*').limit(1);
  console.log('Refunds error:', r.error);
  console.log('Payments error:', p.error);
}
check();
