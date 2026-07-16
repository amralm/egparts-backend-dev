// Cloudflare Turnstile configuration.
// The site key is PUBLIC (it is embedded in the client and visible in the page
// source) — it only identifies the widget. The matching *secret* key lives on
// the server only. We centralize it here so every Turnstile widget uses the
// same value and it can be swapped via env var per-environment (e.g. staging).
export const TURNSTILE_SITE_KEY =
  import.meta.env.VITE_TURNSTILE_SITE_KEY ||
  '0x4AAAAAADF4VfOFuztpzj9u';
