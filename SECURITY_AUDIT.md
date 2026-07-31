# Security Audit Log — EGParts Cloud Backend

**Date:** 2026-07-31
**Status:** All known vulnerabilities patched (0 vulnerabilities found)

## Vulnerabilities Fixed

### CRITICAL — Patched
| Package | Before | After | Risk |
|---------|--------|-------|------|
| @whiskeysockets/baileys | 7.0.0-rc.9 | 7.0.0-rc14 | WhatsApp session spoofing via crafted protocolMessage |
| protobufjs | <=7.6.4 | 7.6.5+ | Arbitrary code execution, prototype injection |

### HIGH — Patched
| Package | Before | After | Risk |
|---------|--------|-------|------|
| axios | 1.16.0 | 1.19.0 | DoS, prototype pollution, auth header injection |
| form-data | 4.0.x | 4.0.6+ | CRLF injection in multipart field names |
| ws | 8.20.0 | 8.20.2+ | Uninitialized memory disclosure + DoS |
| sharp | 0.34.5 | 0.35.3 | Heap overflow + OOB read in libvips (CVE-2026-33327/33328/35590/35591) |

### MODERATE — Patched
| Package | Before | After | Risk |
|---------|--------|-------|------|
| ip-address | <=10.1.0 | 10.1.1+ | XSS in Address6 HTML-emitting methods |
| qs | 6.15.1 | 6.15.2+ | DoS via null entries in comma-format arrays |
| body-parser | 2.2.2 | 2.2.3+ | DoS via invalid limit value |

## Code Changes Made
- middleware/uploadValidator.js: Added security docblock, explicit SAFE_IMAGE_TYPES allowlist, .rotate() for EXIF strip
- services/assetPipeline/ImageProcessor.js: Added security comment on EXIF stripping rationale

## Remaining (Future Work)
- Add Redis for distributed rate limiting
- Integration test suite
- Wire ClamAV antivirus stub
