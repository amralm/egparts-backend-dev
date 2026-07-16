/**
 * ✅ Production Entry Point Proxy
 * Last Update: 2026-05-08 01:33 AM
 * This file allows Render to find 'server.js' in the root directory
 * while keeping our actual logic organized in the /server folder.
 */
require('./server/server.js');
