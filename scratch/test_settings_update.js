const fs = require('fs');
const path = require('path');

// Read server/.env and populate process.env
const envContent = fs.readFileSync('server/.env', 'utf8');
const env = require('dotenv').parse(envContent);
for (const key in env) {
  process.env[key] = env[key];
}

const { getSettings, saveSettings } = require('../services/settingsAdminService');

async function test() {
  const storeId = '3f6326f4-fc55-43f3-b992-72461f262aa0'; // Ahmed Alam store
  try {
    console.log('Fetching settings for store:', storeId);
    const result = await getSettings(storeId);
    console.log('Get settings result succeeded. Rows count:', result.rows.length);
    if (result.rows.length === 0) {
      console.log('No settings row found for this store!');
      return;
    }

    const currentSettings = result.rows[0];
    console.log('Current settings keys:', Object.keys(currentSettings));
    
    // Attempt to save settings
    console.log('Attempting to save settings...');
    const updated = await saveSettings(
      storeId,
      currentSettings,
      result.business_type,
      []
    );
    console.log('Save settings succeeded! Result keys:', Object.keys(updated || {}));
  } catch (err) {
    console.error('ERROR during settings operations:', err);
  }
}

test();
