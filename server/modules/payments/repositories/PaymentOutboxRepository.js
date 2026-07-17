const { supabase } = require('../../../../services/supabase');

class PaymentOutboxRepository {
  async queue(eventType, payload, client = supabase) {
    const { data, error } = await client
      .from('payment_outbox')
      .insert({
        event_type: eventType,
        payload,
        status: 'pending'
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async markProcessed(id, client = supabase) {
    const { data, error } = await client
      .from('payment_outbox')
      .update({
        status: 'processed',
        processed_at: new Date().toISOString()
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async markFailed(id, errorMsg, client = supabase) {
    const { data, error } = await client
      .from('payment_outbox')
      .update({
        status: 'failed',
        error: errorMsg
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getPending(limit = 10, client = supabase) {
    const { data, error } = await client
      .from('payment_outbox')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(limit);

    if (error) throw error;
    return data || [];
  }
}

module.exports = PaymentOutboxRepository;
