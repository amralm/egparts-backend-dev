require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run() {
  const { data } = await supabase.from('feature_limits').select('id, limit_type, plan_feature_id, plan_features!inner(features!inner(key))');
  const counts = {};
  data.forEach(d => {
    if (!counts[d.plan_feature_id]) counts[d.plan_feature_id] = [];
    counts[d.plan_feature_id].push(d);
  });
  
  const multiple = Object.values(counts).filter(arr => arr.length > 1);
  for (const arr of multiple) {
    console.log('Resolving duplicates for feature:', arr[0].plan_features.features.key);
    // Keep 'boolean' if it's a boolean feature, else keep 'count'
    const key = arr[0].plan_features.features.key;
    const isBool = ['payment_gateways', 'whatsapp_notifications', 'custom_domain', 'whatsapp_customer_notifications', 'coupons'].includes(key);
    
    let toKeep;
    if (isBool) {
      toKeep = arr.find(l => l.limit_type === 'boolean') || arr[0];
    } else if (key === 'export_formats') {
      toKeep = arr.find(l => l.limit_type === 'export_formats') || arr[0];
    } else {
      toKeep = arr.find(l => l.limit_type === 'count') || arr[0];
    }
    
    const toDelete = arr.filter(l => l.id !== toKeep.id);
    for (const del of toDelete) {
      console.log('Deleting limit id:', del.id, 'type:', del.limit_type);
      await supabase.from('feature_limits').delete().eq('id', del.id);
    }
  }
  console.log('Cleanup done.');
}
run();
