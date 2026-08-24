'use strict';
// Cloudflare Pages custom-domain automation (CF API v4).
// Provisions SSL + hosting for tenant domains without dashboard visits.
//
// Env (one-time setup in Render):
//   CLOUDFLARE_API_TOKEN    — token with Account > Cloudflare Pages > Edit
//   CLOUDFLARE_ACCOUNT_ID   — 32-char account id
//   CLOUDFLARE_PAGES_PROJECT — Pages project name (production frontend)
//
// Contract: functions NEVER throw. They return { ok, status?, data?, error? }
// so domain flows continue even when Cloudflare is unconfigured/unreachable
// (the existing DNS validator keeps working independently).

const API_BASE = 'https://api.cloudflare.com/client/v4';
const FQDN_RE = /^([a-zA-Z0-9][\-*a-zA-Z0-9]*\.)+[\-a-zA-Z0-9]{2,20}$/;

function cfg() {
  const token = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const project = (process.env.CLOUDFLARE_PAGES_PROJECT || '').trim();
  if (!token || !accountId || !project) {
    return { ok: false, error: 'Cloudflare Pages automation is not configured (missing CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_PAGES_PROJECT).' };
  }
  return { ok: true, token, accountId, project };
}

function normalizeDomainName(input) {
  const name = String(input || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!FQDN_RE.test(name)) return null;
  return name;
}

async function cfRequest(method, path, body) {
  const config = cfg();
  if (!config.ok) return config;

  const url = `${API_BASE}/accounts/${config.accountId}/pages/projects/${config.project}${path}`;
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json'
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await response.json().catch(() => null);
    if (!response.ok || !json?.success) {
      const detail = json?.errors?.[0]?.message || `HTTP_${response.status}`;
      return { ok: false, status: response.status, error: detail };
    }
    return { ok: true, status: response.status, data: json.result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// POST /accounts/:id/pages/projects/:project/domains  { name }
async function addCustomDomain(domainInput) {
  const name = normalizeDomainName(domainInput);
  if (!name) return { ok: false, error: 'Invalid domain name (full FQDN required, e.g. www.elhoda.com).' };
  const result = await cfRequest('POST', '/domains', { name });
  if (result.ok) {
    return { ok: true, status: result.data?.status || 'initializing', validation: result.data?.validation_data || null, data: result.data };
  }
  // Idempotency: a domain already attached to this project is a success for us.
  if (/already exists|10006/i.test(result.error || '')) {
    return { ok: true, status: 'active', alreadyExists: true };
  }
  return result;
}

// GET /accounts/:id/pages/projects/:project/domains/:name
async function getCustomDomain(domainInput) {
  const name = normalizeDomainName(domainInput);
  if (!name) return { ok: false, error: 'Invalid domain name.' };
  return cfRequest('GET', `/domains/${encodeURIComponent(name)}`);
}

// DELETE /accounts/:id/pages/projects/:project/domains/:name
async function deleteCustomDomain(domainInput) {
  const name = normalizeDomainName(domainInput);
  if (!name) return { ok: false, error: 'Invalid domain name.' };
  return cfRequest('DELETE', `/domains/${encodeURIComponent(name)}`);
}

module.exports = { addCustomDomain, getCustomDomain, deleteCustomDomain, normalizeDomainName };
