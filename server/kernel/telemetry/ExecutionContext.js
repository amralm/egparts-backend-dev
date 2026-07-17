/**
 * ExecutionContext
 * Carries correlation, identity, and environmental telemetry across module boundaries.
 * Inherited automatically by Logs, Audits, Metrics, and Events.
 */
class ExecutionContext {
  constructor(data = {}) {
    this.correlationId = data.correlationId || crypto.randomUUID();
    this.requestId = data.requestId || null;
    this.sessionId = data.sessionId || null;
    this.tenantId = data.tenantId || null;
    this.actorId = data.actorId || null;
    
    // Operational context
    this.module = data.module || 'System';
    this.command = data.command || null;
    this.version = data.version || '1.0';
    
    // Environmental context
    this.environment = process.env.NODE_ENV || 'development';
    this.region = process.env.REGION || 'global';
    this.node = process.env.HOSTNAME || 'local';
    this.deployment = process.env.DEPLOYMENT_ID || 'local';
    this.release = process.env.RELEASE_VERSION || '1.0.0';
  }

  static fromRequest(req) {
    return new ExecutionContext({
      correlationId: req.headers['x-correlation-id'],
      requestId: req.headers['x-request-id'],
      tenantId: req.context?.tenant?.id,
      actorId: req.context?.identity?.id,
      sessionId: req.context?.session?.id
    });
  }
  
  clone(overrides = {}) {
    return new ExecutionContext({ ...this, ...overrides });
  }
}

module.exports = ExecutionContext;\n