const fs = require('fs');
const content = fs.readFileSync('routes/platform.js', 'utf8');
const startIndex = content.indexOf('router.post(\'/plans\',');
const endIndex = content.indexOf('// ============================================================', startIndex);
console.log(content.substring(startIndex, endIndex));
