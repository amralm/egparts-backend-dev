'use strict';

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

module.exports = function correlationId(req, res, next) {
  req.id = uuidv4();
  req.correlationId = req.headers['x-correlation-id'] || `req_${uuidv4()}`;
  res.setHeader('X-Correlation-Id', req.correlationId);
  logger.info(`${req.method} ${req.url}`, { requestId: req.id, correlationId: req.correlationId });
  next();
};
