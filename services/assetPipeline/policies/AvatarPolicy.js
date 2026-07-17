'use strict';
const AssetPolicy = require('./AssetPolicy');

class AvatarPolicy extends AssetPolicy {
  get name()              { return 'avatar' }
  get maxSizeBytes()      { return 5 * 1024 * 1024 }
  get maxLongEdge()       { return 1200 }
  get optimizeFromBytes() { return 512 * 1024 }       // 512 KB
  get resizeFromBytes()   { return 2 * 1024 * 1024 }
  get quality()           { return 80 }
  get convertToWebP()     { return true }
  get visibility()        { return 'public' }
  get allowedMimeTypes()  { return ['image/jpeg', 'image/png', 'image/webp'] }
}

module.exports = new AvatarPolicy();
