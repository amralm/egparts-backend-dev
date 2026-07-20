const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

(async () => {
  try {
    const { rows: stores } = await pool.query('SELECT id FROM stores');
    console.log(`Found ${stores.length} stores`);
    
    for (const store of stores) {
      let totalBytes = 0;
      let isTruncated = true;
      let continuationToken;
      
      while (isTruncated) {
        const cmd = new ListObjectsV2Command({
          Bucket: process.env.R2_BUCKET_NAME || 'egparts-assets',
          Prefix: `stores/${store.id}/`,
          ContinuationToken: continuationToken,
        });
        const data = await s3.send(cmd);
        
        if (data.Contents) {
          for (const item of data.Contents) {
            totalBytes += item.Size;
          }
        }
        
        isTruncated = data.IsTruncated;
        continuationToken = data.NextContinuationToken;
      }
      
      console.log(`Store ${store.id}: ${totalBytes} bytes`);
      
      const { rows } = await pool.query(`SELECT id FROM feature_usage WHERE store_id = $1 AND feature_key = 'storage_bytes'`, [store.id]);
      if (rows.length > 0) {
        await pool.query(`UPDATE feature_usage SET usage_count = $1, updated_at = NOW() WHERE id = $2`, [totalBytes, rows[0].id]);
      } else {
        await pool.query(`INSERT INTO feature_usage (store_id, feature_key, usage_count, period, period_start, updated_at) VALUES ($1, 'storage_bytes', $2, 'lifetime', '2000-01-01', NOW())`, [store.id, totalBytes]);
      }
    }
    
    console.log('Sync complete');
  } catch (err) {
    console.error(err);
  } finally {
    pool.end();
  }
})();
