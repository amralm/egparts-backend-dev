const fetch = require('node-fetch');
async function run() {
  const res = await fetch('http://localhost:5000/api/platform/invitations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImE5YjJiMjNhLWYyYjMtNDY5Yi04MTBkLTI3YmJhN2MxOGNmYSIsInJvbGUiOiJwbGF0Zm9ybV9hZG1pbiIsImlhdCI6MTc4NDMzNDg0MX0.LUC2ae-L2pTkZGxcpUotjSGJdQAaUhljwI0ldOv-M6I'
    },
    body: JSON.stringify({
      email: 'amralm460@gmail.com',
      phone: '01033051615',
      store_id: '4331e2ed-60dc-4cf8-a92c-5b5c9281729c'
    })
  });
  console.log(res.status, await res.text());
}
run();
