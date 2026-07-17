# Asset Pipeline — MANIFEST

## Owner

`AssetPipeline` is the **sole owner** of all file upload operations in this platform.

## Single Entry Point

```
POST /api/storage/upload   ← All uploads go here
```

## Allowed (داخل الـ Module فقط)

- Validate files (magic bytes, MIME type, extension, size, pixel dimensions)
- Strip EXIF and file metadata (privacy + security)
- Auto-orient images from EXIF rotation data
- Compress and resize based on Policy
- Upload to storage via `StorageService` only
- Return `{ key, sha256, fingerprint }` to caller

## Forbidden

- ❌ Direct write to R2, S3, or any storage provider outside `StorageService`
- ❌ Direct read/write of any database table
- ❌ Storing metadata — that is the caller's responsibility
- ❌ Any route, service, or component uploading files without going through `AssetPipeline.process()`
- ❌ Returning a URL from the pipeline — use `StorageService.getUrl(key)` at render time

## Contracts

Every upload returns:
```json
{
  "key":             "stores/xxx/public/products/uuid.webp",
  "sha256":          "abc123...",
  "duplicate":       false,
  "fingerprint":     { "width", "height", "format", "orientation", "originalSizeBytes", "processedSizeBytes" },
  "policyVersion":   1,
  "pipelineVersion": 1,
  "correlationId":   "req_xyz"
}
```

- `key` is the only truth. Store it. Use `StorageService.getUrl(key)` or `getMediaUrl(key)` to render.
- `visibility` is determined by the Policy, not the request.
- `ownerId` and `ownerType` are optional metadata — the Pipeline does not use them.

## Extension Points (Phase 2+)

| Extension | How to Add |
|-----------|-----------|
| New file type | Create `MyPolicy extends AssetPolicy` in `policies/`, register in `AssetRegistry.js` |
| New storage backend | Create `MyProvider extends StorageProvider` in `providers/`, wire in `StorageService.js` |
| Real virus scanner | Implement `ClamAVScanner extends VirusScanner` in `VirusScanner.js`, replace export |
| Duplicate detection | Enable `get duplicateDetection() { return true }` in the Policy |
| Asset metadata DB | Add `MediaRepository` + `media_files` table in Phase 2 |

## Pipeline Version

Current: **v1**
Bump when the core orchestration logic in `AssetPipeline.js` changes.
