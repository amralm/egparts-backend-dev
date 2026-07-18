const fs = require('fs');
const path = require('path');

const filesToFix = [
  'C:\\Users\\Admin\\Desktop\\Osama\\src\\components\\CartDrawer.jsx',
  'C:\\Users\\Admin\\Desktop\\Osama\\src\\components\\LiveSearch.jsx',
  'C:\\Users\\Admin\\Desktop\\Osama\\src\\components\\SocialProofToast.jsx',
  'C:\\Users\\Admin\\Desktop\\Osama\\src\\pages\\admin\\Dashboard.jsx',
  'C:\\Users\\Admin\\Desktop\\Osama\\src\\pages\\admin\\Settings.jsx',
  'C:\\Users\\Admin\\Desktop\\Osama\\src\\pages\\admin\\WARequests.jsx',
  'C:\\Users\\Admin\\Desktop\\Osama\\src\\pages\\Catalog.jsx',
  'C:\\Users\\Admin\\Desktop\\Osama\\src\\pages\\Favorites.jsx',
  'C:\\Users\\Admin\\Desktop\\Osama\\src\\pages\\Home.jsx',
  'C:\\Users\\Admin\\Desktop\\Osama\\src\\pages\\platform\\infrastructure\\WARequests.jsx',
  'C:\\Users\\Admin\\Desktop\\Osama\\src\\pages\\Product.jsx'
];

for (const file of filesToFix) {
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes('getMediaUrl') && !content.includes('import { getMediaUrl }')) {
    const srcDir = 'C:\\Users\\Admin\\Desktop\\Osama\\src';
    let relativePath = path.relative(path.dirname(file), path.join(srcDir, 'utils', 'uploadHelper')).replace(/\\/g, '/');
    if (!relativePath.startsWith('.')) relativePath = './' + relativePath;
    
    // add it after the first import
    const lines = content.split('\n');
    const firstImportIndex = lines.findIndex(line => line.trim().startsWith('import '));
    if (firstImportIndex !== -1) {
      lines.splice(firstImportIndex, 0, `import { getMediaUrl } from '${relativePath}';`);
    } else {
      lines.unshift(`import { getMediaUrl } from '${relativePath}';`);
    }
    fs.writeFileSync(file, lines.join('\n'));
    console.log(`Added import to ${file}`);
  }
}
