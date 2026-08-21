'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

module.exports = function correlationId(req, res, next) {
  const suppliedRequestId = req.headers['x-request-id'];
  const suppliedCorrelationId = req.headers['x-correlation-id'];
  const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{8,120}$/.test(value) ? value : null;

  req.id = safeId(suppliedRequestId) || uuidv4();
  req.correlationId = safeId(suppliedCorrelationId) || `req_${req.id}`;
  req.requestId = req.id;
  res.setHeader('X-Request-ID', req.id);
  res.setHeader('X-Correlation-Id', req.correlationId);
  logger.info(`${req.method} ${req.url}`, { requestId: req.id, correlationId: req.correlationId });
  next();
};
