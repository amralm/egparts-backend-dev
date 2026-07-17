async function testRemote() {
  const url = 'https://egparts-backend.onrender.com/api/store-context';
  const headers = {
    'X-Store-Subdomain': 'egparts',
    'X-Original-Host': 'egparts.store'
  };

  try {
    const res = await fetch(url, { headers });
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response Body:', text);
  } catch (err) {
    console.error('Fetch error:', err.message);
  }
}

testRemote();
