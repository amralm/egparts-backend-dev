'use strict';
const AssetPolicy = require('./AssetPolicy');

class CategoryPolicy extends AssetPolicy {
  get name()              { return 'category' }
  get maxSizeBytes()      { return 10 * 1024 * 1024 }
  get maxLongEdge()       { return 3000 }
  get optimizeFromBytes() { return 1 * 1024 * 1024 }
  get resizeFromBytes()   { return 5 * 1024 * 1024 }
  get quality()           { return 82 }
  get convertToWebP()     { return true }
  get visibility()        { return 'public' }
  get allowedMimeTypes()  { return ['image/jpeg', 'image/png', 'image/webp'] }
}

module.exports = new CategoryPolicy();
