# Asset Pipeline — Upload Policies

Any AI agent or developer adding a new upload type should read this file first.

## How to Add a New Policy

1. Create `services/assetPipeline/policies/MyPolicy.js` extending `AssetPolicy`
2. Set `get name()`, `get maxSizeBytes()`, and any overrides
3. Override `generateStorageKey()` if the path structure differs from the default
4. Register it in `AssetRegistry.js`: `registry.register(require('./policies/MyPolicy'))`
5. Add a row to the table below

That's it. Zero changes to the pipeline orchestrator.

---

## Policy Table

| Policy | maxSize | optimizeFrom | resizeFrom | maxLongEdge | quality | toWebP | visibility | dedup | Notes |
|--------|---------|-------------|-----------|-------------|---------|--------|------------|-------|-------|
| `product` | 15 MB | 1 MB | 5 MB | 4000 px | 82% | ✅ | public | ✅ | Display images |
| `banner` | 15 MB | 1 MB | 5 MB | 4000 px | 82% | ✅ | public | ❌ | Store banners |
| `logo` | 5 MB | 1 MB | 3 MB | 2000 px | 85% | ✅ | public | ✅ | Custom key path |
| `category` | 10 MB | 1 MB | 5 MB | 3000 px | 82% | ✅ | public | ❌ | Category icons |
| `avatar` | 5 MB | 512 KB | 2 MB | 1200 px | 80% | ✅ | public | ❌ | Profile photos |
| `receipt` | 15 MB | 2 MB | 8 MB | **6000 px** | **92%** | **❌** | **private** | **❌** | Payment proofs — see notes |
| `document` | 15 MB | — | — | — | — | **❌** | **private** | **❌** | PDF, Excel, CSV |

---

## Processing Logic (applies to all image policies)

```
File size < optimizeFrom   → strip EXIF only (no compression, no resize)
File size < resizeFrom     → strip EXIF + auto-orient + light compression
File size ≥ resizeFrom     → strip EXIF + auto-orient + resize (fit inside maxLongEdge) + compression
```

> **Receipt special rule:**
> Resize only happens if the longest edge exceeds `maxLongEdge` (6000px).
> This protects QR codes, barcodes, and reference numbers from becoming unreadable.
> Regular receipts (< 6000px on longest side) are compressed lightly at 92% quality maximum.

---

## Storage Key Patterns

| Policy | Key Pattern |
|--------|------------|
| `product` | `stores/{storeId}/public/products/{uuid}.webp` |
| `banner` | `stores/{storeId}/public/banners/{uuid}.webp` |
| `logo` | `stores/{storeId}/public/logos/{uuid}.webp` |
| `category` | `stores/{storeId}/public/categorys/{uuid}.webp` |
| `avatar` | `stores/{storeId}/public/avatars/{uuid}.webp` |
| `receipt` | `stores/{storeId}/private/receipts/{uuid}.{ext}` |
| `document` | `stores/{storeId}/private/documents/{uuid}.{ext}` |

---

## Policy Versioning

Each policy has a `version` getter. Bump it when the processing logic changes (quality, resize thresholds, etc.).
This allows identifying which algorithm was used to process any given file.

Current versions: all policies at **v1**.
