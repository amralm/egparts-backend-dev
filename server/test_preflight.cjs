async function testPreflight() {
  const url = 'https://egparts-backend.onrender.com/api/store-context';
  
  try {
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: {
        'Origin': 'https://egparts.store',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'x-original-host, x-store-subdomain'
      }
    });
    
    console.log('OPTIONS Status:', res.status);
    console.log('Headers:');
    res.headers.forEach((value, key) => {
      console.log(`  ${key}: ${value}`);
    });
  } catch (err) {
    console.error('Fetch error:', err.message);
  }
}

testPreflight();
