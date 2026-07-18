async function run() {
  const res = await fetch('https://pfubitpzrmgrnzalcsgr.supabase.co/rest/v1/', {
    headers: {
      'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmdWJpdHB6cm1ncm56YWxjc2dyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzQyMzI5NywiZXhwIjoyMDkyOTk5Mjk3fQ.gbmiBXM7plPYbF-DoNwxpUCVt-5gjPkHWFU1_y6mAyU'
    }
  });
  const data = await res.json();
  
  if (data.definitions) {
     console.log('invoices:', Object.keys(data.definitions.invoices?.properties || {}));
     console.log('store_subscriptions:', Object.keys(data.definitions.store_subscriptions?.properties || {}));
     console.log('subscription_plans:', Object.keys(data.definitions.subscription_plans?.properties || {}));
  }
}
run();
