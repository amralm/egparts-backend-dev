const { supabase } = require('./services/supabase');

async function check() {
  const { data, error } = await supabase.rpc('check_feature_limit', {
    p_store_id: '50e93a0b-1934-406a-a5c9-9405bfb426b3', // Need a valid store id
    p_feature_key: 'copilot_messages_day',
    p_requested_increment: 1
  });
  console.log(data, error);
}

check();
