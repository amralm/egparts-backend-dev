const { createClient } = require('@supabase/supabase-js');
const supabase = createClient('https://pfubitpzrmgrnzalcsgr.supabase.co', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmdWJpdHB6cm1ncm56YWxjc2dyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzQyMzI5NywiZXhwIjoyMDkyOTk5Mjk3fQ.gbmiBXM7plPYbF-DoNwxpUCVt-5gjPkHWFU1_y6mAyU');

async function check() {
  const { data, error } = await supabase.from('invoices').insert([
    { id: '11111111-1111-1111-1111-111111111111', asdfgh: 1 }
  ]);
  console.log('Error:', error);
}
check();
