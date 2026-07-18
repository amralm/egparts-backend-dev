require('dotenv').config();
const jwt = require('jsonwebtoken');

const token = jwt.sign({ 
  id: 'a9b2b23a-f2b3-469b-810d-27bba7c18cfa', // random uuid
  role: 'platform_admin'
}, process.env.JWT_SECRET || 'your-secret-key-for-jwt-signing');

console.log('TOKEN:', token);
