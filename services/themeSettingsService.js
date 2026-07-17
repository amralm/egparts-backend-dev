const { z } = require('zod');

const THEME_IDS = ['midnight', 'ocean', 'emerald', 'sunset', 'minimal', 'royal-purple', 'golden-luxury', 'cyber-teal', 'rose-pink', 'earth-brown'];

const THEME_TOKEN_KEYS = [
  'primary', 'primary_hover', 'on_primary',
  'secondary', 'secondary_container', 'on_secondary',
  'background', 'surface', 'surface_container', 'surface_container_high',
  'on_surface', 'on_surface_variant', 'on_background',
  'outline', 'success', 'warning', 'error'
];

const tokenSet = new Set(THEME_TOKEN_KEYS);
const safeTokenValue = /^[#a-zA-Z0-9\s,().%-]+$/;

const themeOverrideSchema = z.record(z.string(), z.string().trim().min(1).max(96).regex(safeTokenValue));

function sanitizeThemeOverrides(overrides) {
  const parsed = themeOverrideSchema.safeParse(overrides || {});
  if (!parsed.success) return {};

  return Object.entries(parsed.data).reduce((safe, [key, value]) => {
    if (tokenSet.has(key)) safe[key] = value;
    return safe;
  }, {});
}

function normalizeThemeSettings(payload = {}) {
  const next = { ...payload };

  // Built-in IDs and UUIDs of platform-managed themes are both valid. The
  // route that applies a managed theme verifies publication before persistence.
  if (next.theme_id !== undefined && typeof next.theme_id !== 'string') {
    next.theme_id = 'midnight';
  }

  if (next.theme_overrides !== undefined) {
    next.theme_overrides = sanitizeThemeOverrides(next.theme_overrides);
  }

  if (next.theme_version !== undefined) {
    const version = Number(next.theme_version);
    next.theme_version = Number.isInteger(version) && version > 0 ? version : 1;
  }

  return next;
}

module.exports = {
  THEME_IDS,
  THEME_TOKEN_KEYS,
  normalizeThemeSettings,
  sanitizeThemeOverrides
};
