'use strict';
const AssetPolicy = require('./AssetPolicy');

class LogoPolicy extends AssetPolicy {
  get name()              { return 'logo' }
  get maxSizeBytes()      { return 5 * 1024 * 1024 }
  get maxLongEdge()       { return 2000 }
  get optimizeFromBytes() { return 1 * 1024 * 1024 }
  get resizeFromBytes()   { return 3 * 1024 * 1024 }
  get quality()           { return 85 }
  get convertToWebP()     { return true }
  get visibility()        { return 'public' }
  get duplicateDetection(){ return true }  // Avoid duplicate logos
  get allowedMimeTypes()  { return ['image/jpeg', 'image/png', 'image/webp', 'image/svg+xml'] }

  generateStorageKey(storeId, fileId, ext) {
    // Logos go directly under store folder for easy access
    return `stores/${storeId}/public/logos/${fileId}.${ext}`;
  }
}

module.exports = new LogoPolicy();
