const { supabase } = require('./supabase');
const logger = require('../utils/logger');

let paymentExpiryTimer = null;
function startPaymentExpiryJob() {
  if (paymentExpiryTimer) return;
  // Run every 5 minutes
  paymentExpiryTimer = setInterval(async () => {
    try {
      // Find orders that are 'pending' payment, use 'card', and were created > 30 mins ago
      // Since Supabase REST doesn't easily support < NOW() - 30 minutes in a single simple query without RPC
      // we can fetch pending card orders, and filter in JS, OR calculate the timestamp in JS
      
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      const { data: expiredOrders, error } = await supabase
        .from('orders')
        .select('id, store_id')
        .eq('payment_method', 'card')
        .eq('payment_status', 'pending')
        .eq('status', 'pending')
        .lt('created_at', thirtyMinutesAgo);

      if (error) {
        logger.error(`Error fetching expired orders: ${error.message}`);
        return;
      }

      if (!expiredOrders || expiredOrders.length === 0) {
        return; // Nothing to do
      }

      logger.info(`Found ${expiredOrders.length} expired pending payment orders. Processing...`);

      for (const order of expiredOrders) {
        // 1. Optimistic Locking: Try to mark order as expired ONLY if it's STILL pending
        // This prevents a race condition where a Webhook arrives exactly during this process.
        const { data: updatedOrder, error: updateError } = await supabase
          .from('orders')
          .update({
            status: 'cancelled',
            payment_status: 'expired',
          })
          .eq('id', order.id)
          .eq('payment_status', 'pending') // CRITICAL: only if still pending
          .select()
          .maybeSingle();

        if (updateError || !updatedOrder) {
          logger.info(`Order ${order.id} is no longer pending. Skipping expiration.`);
          continue; // Webhook probably processed it just now!
        }

        await supabase.rpc('restore_order_stock', { p_order_id: order.id });

        logger.info(`Cancelled expired order ${order.id} and safely restored stock.`);
      }

    } catch (err) {
      logger.error(`Payment expiry job error: ${err.message}`);
    }
  }, 5 * 60 * 1000); // 5 minutes
}

function stopPaymentExpiryJob() {
  if (paymentExpiryTimer) clearInterval(paymentExpiryTimer);
  paymentExpiryTimer = null;
}

module.exports = { startPaymentExpiryJob, stopPaymentExpiryJob };
