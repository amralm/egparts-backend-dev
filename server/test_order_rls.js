require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function run() {
  console.log("Checking if we can update an order...");
  const { data: orders, error: err1 } = await supabase.from('orders').select('*').limit(1);
  if (err1) { console.error("Error fetching order:", err1); return; }
  if (orders.length === 0) { console.error("No orders found"); return; }
  
  const order = orders[0];
  console.log("Found order:", order.id, order.status);

  // Try updating the order status
  const { error: updateError } = await supabase.from('orders').update({ status: order.status === 'pending' ? 'confirmed' : 'pending' }).eq('id', order.id);
  console.log("Update Order Error:", updateError);

  // Try inserting an order_log
  const { error: insertError } = await supabase.from('order_logs').insert([{
    order_id: order.id,
    admin_id: order.user_id, // fake admin id
    old_status: order.status,
    new_status: 'test',
    note: 'Test'
  }]);
  console.log("Insert Order Log Error:", insertError);
}
run();
