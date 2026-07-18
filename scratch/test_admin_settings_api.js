const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

// Read server/.env and populate process.env
const envContent = fs.readFileSync('server/.env', 'utf8');
const env = require('dotenv').parse(envContent);
for (const key in env) {
  process.env[key] = env[key];
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_iBH2KZATTthSn3Mds3M_wg_UG5ls8pu';

async function test() {
  const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  
  console.log('Logging in admin user (ah2717679@gmail.com)...');
  const { data, error } = await supabase.auth.signInWithPassword({
    email: 'ah2717679@gmail.com',
    password: '1234cac1234'
  });

  if (error) {
    console.error('Login failed:', error.message);
    return;
  }

  const token = data.session.access_token;
  console.log('Login succeeded! Token starts with:', token.slice(0, 15));

  // Let's call GET /api/admin/settings first
  console.log('Sending GET request to /api/admin/settings...');
  try {
    const getRes = await axios.get('http://localhost:5000/api/admin/settings', {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Host': 'alam.localhost'
      }
    });
    console.log('GET Succeeded! Response code:', getRes.status);
    console.log('GET Data keys:', Object.keys(getRes.data));

    // Let's call PUT /api/admin/settings
    console.log('Sending PUT request to /api/admin/settings...');
    const putRes = await axios.put('http://localhost:5000/api/admin/settings', {
      settings: getRes.data.rows[0],
      businessType: getRes.data.business_type,
      guaranteeProductIds: []
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Host': 'alam.localhost',
        'Content-Type': 'application/json'
      }
    });

    console.log('PUT Succeeded! Response code:', putRes.status);
    console.log('PUT Data:', putRes.data);
  } catch (err) {
    console.error('API Call Failed!');
    if (err.response) {
      console.error('Response Status:', err.response.status);
      console.error('Response Headers:', err.response.headers);
      console.error('Response Body:', err.response.data);
    } else {
      console.error('Error Message:', err.message);
    }
  }
}

test();
