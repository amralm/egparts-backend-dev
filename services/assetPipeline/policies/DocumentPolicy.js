'use strict';
const AssetPolicy = require('./AssetPolicy');

/**
 * DocumentPolicy — PDFs, Excel, CSV files
 * No image processing. No compression. Pass-through upload.
 */
class DocumentPolicy extends AssetPolicy {
  get name()              { return 'document' }
  get maxSizeBytes()      { return 15 * 1024 * 1024 }  // 15 MB
  get optimizeFromBytes() { return Infinity }          // Never optimize
  get resizeFromBytes()   { return Infinity }          // Never resize
  get convertToWebP()     { return false }
  get visibility()        { return 'private' }
  get allowedMimeTypes()  {
    return [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv'
    ];
  }

  generateStorageKey(storeId, fileId, ext) {
    return `stores/${storeId}/private/documents/${fileId}.${ext}`;
  }
}

module.exports = new DocumentPolicy();
