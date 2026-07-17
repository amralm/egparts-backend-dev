'use strict';
const AssetPolicy = require('./AssetPolicy');

class ProductPolicy extends AssetPolicy {
  get name()              { return 'product' }
  get maxSizeBytes()      { return 15 * 1024 * 1024 }  // 15 MB
  get maxLongEdge()       { return 4000 }
  get optimizeFromBytes() { return 1 * 1024 * 1024 }
  get resizeFromBytes()   { return 5 * 1024 * 1024 }
  get quality()           { return 82 }
  get convertToWebP()     { return true }
  get visibility()        { return 'public' }
  get duplicateDetection(){ return true }  // Same product image detection
  get allowedMimeTypes()  { return ['image/jpeg', 'image/png', 'image/webp'] }
}

module.exports = new ProductPolicy();
