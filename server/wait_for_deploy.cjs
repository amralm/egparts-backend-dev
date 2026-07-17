async function check() {
  const url = 'https://egparts-backend.onrender.com/api/store-context';
  console.log('Monitoring Render deployment...');
  
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(url, {
        method: 'OPTIONS',
        headers: {
          'Origin': 'https://egparts.store',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'x-original-host'
        }
      });
      
      const allowHeaders = res.headers.get('access-control-allow-headers') || '';
      console.log(`[${new Date().toLocaleTimeString()}] Allow Headers:`, allowHeaders);
      
      if (allowHeaders.includes('x-original-host')) {
        console.log('DEPOLOYMENT LIVE! x-original-host is now allowed!');
        process.exit(0);
      }
    } catch (err) {
      console.log('Error fetching:', err.message);
    }
    
    await new Promise(r => setTimeout(r, 15000));
  }
  
  console.log('Timed out waiting for deployment.');
}

check();
