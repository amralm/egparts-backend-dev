const { supabase } = require('../../../../services/supabase');

class PaymentTimelineRepository {
  async log(intentId, eventName, description, payload = {}, client = supabase) {
    const { data, error } = await client
      .from('payment_timelines')
      .insert({
        intent_id: intentId,
        event_name: eventName,
        description,
        payload
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getByIntentId(intentId, client = supabase) {
    const { data, error } = await client
      .from('payment_timelines')
      .select('*')
      .eq('intent_id', intentId)
      .order('created_at', { ascending: true });

    if (error) throw error;
    return data || [];
  }
}

module.exports = PaymentTimelineRepository;
