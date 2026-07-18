async function run() {
  const res = await fetch('https://pfubitpzrmgrnzalcsgr.supabase.co/rest/v1/', {
    headers: {
      'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmdWJpdHB6cm1ncm56YWxjc2dyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzQyMzI5NywiZXhwIjoyMDkyOTk5Mjk3fQ.gbmiBXM7plPYbF-DoNwxpUCVt-5gjPkHWFU1_y6mAyU'
    }
  });
  const data = await res.json();
  
  if (data.definitions) {
     console.log(Object.keys(data.definitions).filter(k => k.includes('plan')));
  }
}
run();
