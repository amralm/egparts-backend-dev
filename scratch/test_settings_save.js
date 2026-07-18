require('dotenv').config({ path: 'server/.env' });
const { supabase } = require('../services/supabase');
const settingsAdminService = require('../services/settingsAdminService');

async function testSave() {
  try {
    // 1. Get first store and its settings
    const { data: stores, error: storeErr } = await supabase.from('stores').select('id, business_type').limit(1);
    if (storeErr || !stores || stores.length === 0) {
      console.error('Failed to get stores:', storeErr);
      return;
    }
    const storeId = stores[0].id;
    console.log('Testing with Store ID:', storeId);

    const { rows: settingsRows, business_type } = await settingsAdminService.getSettings(storeId);
    if (!settingsRows || settingsRows.length === 0) {
      console.log('No settings row found for store, cannot test update.');
      return;
    }
    
    const settings = settingsRows[0];
    console.log('Current site_settings keys:', Object.keys(settings));

    // Try saving the settings back as-is (this mimics the update operation)
    console.log('Calling saveSettings...');
    const result = await settingsAdminService.saveSettings(
      storeId,
      settings,
      business_type,
      []
    );
    console.log('saveSettings result:', result ? 'SUCCESS' : 'EMPTY');
  } catch (err) {
    console.error('saveSettings THREW ERROR:', err);
  }
}

testSave();
