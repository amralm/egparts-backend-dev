'use strict';

// Values inside Supabase .or() are parsed as a PostgREST expression. This
// helper keeps user text data-only: no commas, operators, wildcards or escape
// characters are allowed to reach that expression language.
function sanitizeIlikeTerm(value, maxLength = 80) {
  return String(value ?? '')
    .normalize('NFKC')
    .slice(0, maxLength)
    .replace(/[,*().%\\:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { sanitizeIlikeTerm };
