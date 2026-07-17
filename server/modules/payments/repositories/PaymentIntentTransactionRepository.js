const { supabase } = require('../../../../services/supabase');

class PaymentIntentTransactionRepository {
  async save(transactionData, client = supabase) {
    const { data, error } = await client
      .from('payment_intent_transactions')
      .upsert(transactionData)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getById(id, client = supabase) {
    const { data, error } = await client
      .from('payment_intent_transactions')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async getByIntentId(intentId, client = supabase) {
    const { data, error } = await client
      .from('payment_intent_transactions')
      .select('*')
      .eq('intent_id', intentId);

    if (error) throw error;
    return data || [];
  }
}

module.exports = PaymentIntentTransactionRepository;
