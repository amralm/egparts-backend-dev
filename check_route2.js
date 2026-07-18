const fs = require('fs');
const content = fs.readFileSync('routes/platform.js', 'utf8');
const lines = content.split('\n');
const startIndex = lines.findIndex(l => l.includes('/plans'));
if (startIndex !== -1) {
    console.log(lines.slice(startIndex - 5, startIndex + 50).join('\n'));
} else {
    console.log('Not found');
}
