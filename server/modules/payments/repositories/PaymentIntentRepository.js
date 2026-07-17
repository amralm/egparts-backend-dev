const { supabase } = require('../../../../services/supabase');
const PaymentIntent = require('../entities/PaymentIntent');

class PaymentIntentRepository {
  async save(paymentIntent, client = supabase) {
    const dbData = paymentIntent.toDatabase ? paymentIntent.toDatabase() : paymentIntent;
    const { data, error } = await client
      .from('payment_intents')
      .upsert(dbData)
      .select()
      .single();

    if (error) throw error;
    return new PaymentIntent(data);
  }

  async getById(id, client = supabase) {
    const { data, error } = await client
      .from('payment_intents')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    return data ? new PaymentIntent(data) : null;
  }

  async getByProviderReference(provider, providerReference, client = supabase) {
    const { data, error } = await client
      .from('payment_intents')
      .select('*')
      .eq('provider', provider)
      .eq('metadata->>provider_reference', providerReference)
      .maybeSingle();

    if (error) throw error;
    return data ? new PaymentIntent(data) : null;
  }
}

module.exports = PaymentIntentRepository;
