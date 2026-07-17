const dns = require('dns').promises;
const tls = require('tls');
const { supabase } = require('./supabase');
const logger = require('../utils/logger');

/**
 * Probes the SSL certificate for a given domain
 * @param {string} domain 
 * @returns {Promise<{ssl_status: string, certificate_expiry?: Date, error_message?: string}>}
 */
function probeSSL(domain) {
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: domain,
      port: 443,
      servername: domain,
      timeout: 5000,
      rejectUnauthorized: false // We want to inspect the cert even if invalid
    }, () => {
      try {
        const cert = socket.getPeerCertificate(true);
        socket.destroy();

        if (!cert || Object.keys(cert).length === 0) {
          return resolve({ ssl_status: 'invalid', error_message: 'No SSL certificate returned from host' });
        }

        const validTo = new Date(cert.valid_to);
        const expired = validTo < new Date();
        const authorized = socket.authorized;

        if (expired) {
          resolve({ ssl_status: 'expired', certificate_expiry: validTo, error_message: 'SSL Certificate has expired' });
        } else if (!authorized) {
          resolve({ ssl_status: 'invalid', certificate_expiry: validTo, error_message: 'Self-signed or unauthorized certificate chain' });
        } else {
          resolve({ ssl_status: 'valid', certificate_expiry: validTo });
        }
      } catch (err) {
        socket.destroy();
        resolve({ ssl_status: 'error', error_message: `Cert read failed: ${err.message}` });
      }
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ ssl_status: 'error', error_message: `TLS Connection error: ${err.message}` });
    });

    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve({ ssl_status: 'error', error_message: 'TLS Connection timeout after 5000ms' });
    });
  });
}

/**
 * Validates a single domain's DNS and SSL health
 * @param {string} domainId 
 */
async function runDomainCheck(domainId) {
  logger.info(`[DomainValidator] Starting health check for domain ID: ${domainId}`);
  const startTime = Date.now();

  // 1. Fetch domain metadata
  const { data: customDomain, error: fetchErr } = await supabase
    .from('custom_domains')
    .select('*')
    .eq('id', domainId)
    .maybeSingle();

  if (fetchErr || !customDomain) {
    logger.error(`[DomainValidator] Custom domain not found: ${domainId}`, fetchErr);
    return null;
  }

  const domain = customDomain.domain;
  let dnsStatus = 'invalid';
  let sslStatus = 'pending';
  let httpStatus = 'offline';
  let certExpiry = null;
  let resolvedRecords = { cnames: [], a_records: [] };
  let errorCode = null;
  let errorMessage = '';

  try {
    // 2. DNS Resolution
    // Resolve CNAME
    try {
      const cnames = await dns.resolveCname(domain);
      resolvedRecords.cnames = cnames;
      
      // If points to platform target domain
      const primaryDomain = process.env.PRIMARY_DOMAIN || 'egparts.store';
      const isCorrectCname = cnames.some(cname => 
        cname.endsWith(primaryDomain) || 
        cname.endsWith('pages.dev')
      );
      if (isCorrectCname) {
        dnsStatus = 'valid';
      }
    } catch (e) {
      // CNAME resolution failed, check A records
      try {
        const aRecords = await dns.resolve4(domain);
        resolvedRecords.a_records = aRecords;
        
        // As long as it resolves, treat DNS as valid (or warning if no specific CNAME)
        if (aRecords.length > 0) {
          dnsStatus = 'valid';
        }
      } catch (err2) {
        errorCode = 'DNS_RESOLUTION_FAILED';
        errorMessage = `DNS resolution failed for both CNAME and A records: ${err2.message}`;
      }
    }

    // 3. SSL Check (if DNS is valid)
    if (dnsStatus === 'valid') {
      const sslProbe = await probeSSL(domain);
      sslStatus = sslProbe.ssl_status;
      certExpiry = sslProbe.certificate_expiry;
      if (sslProbe.error_message) {
        errorMessage = sslProbe.error_message;
        errorCode = 'SSL_VERIFICATION_FAILED';
      } else {
        httpStatus = 'online';
      }
    }
  } catch (err) {
    logger.error(`[DomainValidator] Critical failure checking domain ${domain}:`, err);
    errorMessage = err.message;
    errorCode = 'CRITICAL_CHECK_FAILURE';
  }

  const latencyMs = Date.now() - startTime;

  // 4. Determine combined custom_domains status
  let newStatus = 'failed';
  if (dnsStatus === 'valid') {
    if (sslStatus === 'valid') {
      newStatus = 'active';
    } else {
      newStatus = 'warning';
    }
  }

  try {
    // 5. Save logs to domain_health_checks
    const { error: logErr } = await supabase
      .from('domain_health_checks')
      .insert([{
        domain_id: domainId,
        checked_at: new Date().toISOString(),
        dns_status: dnsStatus,
        ssl_status: sslStatus === 'none' ? 'error' : sslStatus,
        http_status: httpStatus,
        latency_ms: latencyMs,
        certificate_expiry: certExpiry ? certExpiry.toISOString() : null,
        resolved_records: resolvedRecords,
        error_code: errorCode,
        error_message: errorMessage || null,
        next_retry_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() // 15 mins retry
      }]);

    if (logErr) throw logErr;

    // 6. Update custom_domains status
    const { error: updateErr } = await supabase
      .from('custom_domains')
      .update({
        status: newStatus,
        ssl_status: sslStatus === 'valid' ? 'active' : sslStatus === 'none' ? 'none' : 'failed',
        last_dns_check: new Date().toISOString(),
        last_ssl_check: new Date().toISOString(),
        verified_at: newStatus === 'active' ? new Date().toISOString() : customDomain.verified_at,
        updated_at: new Date().toISOString()
      })
      .eq('id', domainId);

    if (updateErr) throw updateErr;

    logger.info(`[DomainValidator] Done health check for ${domain}. Status: ${newStatus}`);
  } catch (err) {
    logger.error('[DomainValidator] Database log save failed:', err.message);
  }
}

/**
 * Runs validation checks on all active custom domains
 */
async function runAllDomainChecks() {
  logger.info('[DomainValidator] Scanning all custom domains...');
  try {
    const { data: domains, error } = await supabase
      .from('custom_domains')
      .select('id');

    if (error) throw error;

    if (domains && domains.length > 0) {
      for (const d of domains) {
        await runDomainCheck(d.id);
      }
    }
    logger.info('[DomainValidator] Finished scanning all custom domains.');
  } catch (err) {
    logger.error('[DomainValidator] Bulk check failed:', err.message);
  }
}

// Background Cron runner interval reference
let checkIntervalRef = null;

function startDomainCheckCron() {
  if (checkIntervalRef) return;
  
  // Run check every 15 minutes
  checkIntervalRef = setInterval(() => {
    runAllDomainChecks();
  }, 15 * 60 * 1000);
  
  // Also run immediately on startup
  setTimeout(() => {
    runAllDomainChecks();
  }, 5000);
  
  logger.info('🟢 Centralized Custom Domain background validator started.');
}

function stopDomainCheckCron() {
  if (checkIntervalRef) {
    clearInterval(checkIntervalRef);
    checkIntervalRef = null;
    logger.info('🛑 Centralized Custom Domain background validator stopped.');
  }
}

module.exports = {
  runDomainCheck,
  runAllDomainChecks,
  startDomainCheckCron,
  stopDomainCheckCron
};
