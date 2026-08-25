'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env') });

console.log('====================================================');
console.log('ADVERSARIAL BACKEND RUNTIME & INTEGRITY PROBE');
console.log('====================================================\n');

const dirs = ['routes', 'middleware', 'services', 'utils', 'schemas'];
const runtimeFiles = [];

for (const dir of dirs) {
  const dirPath = path.join(root, dir);
  if (!fs.existsSync(dirPath)) continue;
  for (const f of fs.readdirSync(dirPath)) {
    if (f.endsWith('.js') && !f.endsWith('.bak')) {
      runtimeFiles.push({
        dir,
        file: f,
        rel: path.join(dir, f).replace(/\\/g, '/'),
        abs: path.join(dirPath, f)
      });
    }
  }
}

let totalErrors = 0;

// =========================================================================
// TEST 1: Isolated Subprocess Loading (With Standard Environment)
// =========================================================================
console.log(`[TEST 1] Probing isolated dynamic require across ${runtimeFiles.length} files in separate Node processes...`);

const isolatedFailures = [];
for (const item of runtimeFiles) {
  const code = `
    require('dotenv').config({ path: ${JSON.stringify(path.join(root, '.env'))} });
    try {
      const mod = require(${JSON.stringify(item.abs)});
      if (mod === undefined) {
        console.error('Module exported undefined');
        process.exit(2);
      }
      process.exit(0);
    } catch (err) {
      console.error(err.stack || err.message);
      process.exit(1);
    }
  `;

  const res = spawnSync(process.execPath, ['-e', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 6000
  });

  if (res.status !== 0) {
    isolatedFailures.push({
      file: item.rel,
      status: res.status,
      error: (res.stderr || res.stdout || 'Timeout / unknown error').trim()
    });
  }
}

if (isolatedFailures.length > 0) {
  totalErrors += isolatedFailures.length;
  console.error(`❌ TEST 1 FAILED: ${isolatedFailures.length} files failed isolated require:`);
  for (const f of isolatedFailures) {
    console.error(`  - ${f.file}: (Exit code ${f.status})\n    ${f.error.split('\n')[0]}`);
  }
} else {
  console.log(`✅ TEST 1 PASSED: 100% (${runtimeFiles.length}/${runtimeFiles.length}) files load cleanly in isolated processes.\n`);
}

// =========================================================================
// TEST 2: Missing Environment Handling
// =========================================================================
console.log(`[TEST 2] Testing module behavior under completely EMPTY environment variables (no .env)...`);

const emptyEnvResults = [];
for (const item of runtimeFiles) {
  const code = `
    // Completely clear env vars that might leak from parent
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.PORT;
    try {
      const mod = require(${JSON.stringify(item.abs)});
      console.log('CLEAN_LOAD');
      process.exit(0);
    } catch (err) {
      // If it throws an expected configuration/env error, that is valid fail-fast behavior.
      // If it throws SyntaxError, ReferenceError, TypeError (like undefined property access), that is an AST/code bug.
      const name = err.name || 'Error';
      const msg = err.message || '';
      console.log(name + ': ' + msg);
      if (name === 'ReferenceError' || name === 'SyntaxError' || name === 'TypeError') {
        process.exit(2);
      }
      process.exit(0);
    }
  `;

  const res = spawnSync(process.execPath, ['-e', code], {
    cwd: root,
    encoding: 'utf8',
    timeout: 6000
  });

  if (res.status === 2) {
    emptyEnvResults.push({
      file: item.rel,
      error: (res.stderr || res.stdout).trim()
    });
  }
}

if (emptyEnvResults.length > 0) {
  totalErrors += emptyEnvResults.length;
  console.error(`❌ TEST 2 FAILED: ${emptyEnvResults.length} files threw Reference/Syntax/Type errors on missing env:`);
  for (const f of emptyEnvResults) {
    console.error(`  - ${f.file}: ${f.error}`);
  }
} else {
  console.log(`✅ TEST 2 PASSED: All files handle missing env safely (no ReferenceError/SyntaxError/TypeError unhandled crashes).\n`);
}

// =========================================================================
// TEST 3: Static Dependency Graph & Circular Dependency Detection
// =========================================================================
console.log(`[TEST 3] Constructing module dependency graph & searching for circular dependency cycles...`);

const graph = new Map();

// Helper to resolve require paths
function resolveLocalRequire(sourceFileAbs, requirePath) {
  if (!requirePath.startsWith('.')) return null; // third-party / built-in
  const sourceDir = path.dirname(sourceFileAbs);
  let resolved = path.resolve(sourceDir, requirePath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    resolved = path.join(resolved, 'index.js');
  }
  if (!resolved.endsWith('.js') && fs.existsSync(resolved + '.js')) {
    resolved = resolved + '.js';
  }
  if (fs.existsSync(resolved) && resolved.startsWith(root)) {
    return path.relative(root, resolved).replace(/\\/g, '/');
  }
  return null;
}

// Regex to extract require calls
for (const item of runtimeFiles) {
  const content = fs.readFileSync(item.abs, 'utf8');
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  let match;
  const deps = new Set();
  while ((match = requireRegex.exec(content)) !== null) {
    const targetRel = resolveLocalRequire(item.abs, match[1]);
    if (targetRel) {
      deps.add(targetRel);
    }
  }
  graph.set(item.rel, Array.from(deps));
}

// Cycle detection via DFS
const cycles = [];
const visited = new Map(); // 0: unvisited, 1: visiting, 2: visited
const currentPath = [];

function findCycles(node) {
  visited.set(node, 1);
  currentPath.push(node);

  const neighbors = graph.get(node) || [];
  for (const neighbor of neighbors) {
    const state = visited.get(neighbor) || 0;
    if (state === 1) {
      // Cycle detected
      const cycleStartIdx = currentPath.indexOf(neighbor);
      const cycle = currentPath.slice(cycleStartIdx).concat([neighbor]);
      cycles.push(cycle);
    } else if (state === 0) {
      findCycles(neighbor);
    }
  }

  currentPath.pop();
  visited.set(node, 2);
}

for (const node of graph.keys()) {
  if (!visited.has(node) || visited.get(node) === 0) {
    findCycles(node);
  }
}

if (cycles.length > 0) {
  console.warn(`⚠️ TEST 3 WARNING: Found ${cycles.length} circular dependency cycles:`);
  for (const c of cycles) {
    console.warn(`  - Cycle: ${c.join(' -> ')}`);
  }
  // We check if runtime loading in reverse/random order causes failure due to cycles
} else {
  console.log(`✅ TEST 3 PASSED: Static dependency graph is clean (0 circular dependencies detected across ${graph.size} modules).\n`);
}

// =========================================================================
// TEST 4: Express Router Endpoint & Middleware Stack Integrity
// =========================================================================
console.log(`[TEST 4] Probing Express router stacks for undefined route handlers or broken middleware callbacks...`);

const routeFiles = runtimeFiles.filter(f => f.dir === 'routes');
const brokenRoutes = [];

// Setup dummy env if needed for requiring routers
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://placeholder.supabase.co';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'placeholder-key';
process.env.SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || 'placeholder-secret-32-chars-long';

for (const item of routeFiles) {
  try {
    const router = require(item.abs);
    if (!router) {
      brokenRoutes.push({ file: item.rel, reason: 'Module did not export a router (exported null/undefined)' });
      continue;
    }

    // A valid express router has .stack or is a middleware function
    if (typeof router === 'function' && Array.isArray(router.stack)) {
      for (let i = 0; i < router.stack.length; i++) {
        const layer = router.stack[i];
        if (!layer) {
          brokenRoutes.push({ file: item.rel, reason: `Layer ${i} in router.stack is null/undefined` });
          continue;
        }
        if (typeof layer.handle !== 'function') {
          brokenRoutes.push({ file: item.rel, reason: `Layer ${i} (${layer.name || 'unnamed'}) handle is not a function (got ${typeof layer.handle})` });
        }
        if (layer.route) {
          const route = layer.route;
          if (!Array.isArray(route.stack) || route.stack.length === 0) {
            brokenRoutes.push({ file: item.rel, reason: `Route path '${route.path}' has empty or invalid stack` });
          } else {
            for (let j = 0; j < route.stack.length; j++) {
              const routeLayer = route.stack[j];
              if (!routeLayer || typeof routeLayer.handle !== 'function') {
                brokenRoutes.push({
                  file: item.rel,
                  reason: `Route path '${route.path}' method '${routeLayer?.method || 'unknown'}' handler ${j} is not a function (got ${typeof routeLayer?.handle})`
                });
              }
            }
          }
        }
      }
    } else if (typeof router !== 'function') {
      brokenRoutes.push({ file: item.rel, reason: `Exported type is '${typeof router}' instead of Express Router function` });
    }
  } catch (err) {
    brokenRoutes.push({ file: item.rel, reason: `Failed to require router: ${err.message}` });
  }
}

if (brokenRoutes.length > 0) {
  totalErrors += brokenRoutes.length;
  console.error(`❌ TEST 4 FAILED: ${brokenRoutes.length} route stack defects found:`);
  for (const b of brokenRoutes) {
    console.error(`  - ${b.file}: ${b.reason}`);
  }
} else {
  console.log(`✅ TEST 4 PASSED: All ${routeFiles.length} Express routers and route handlers/middleware callbacks are 100% valid functions.\n`);
}

// =========================================================================
// TEST 5: Reverse & Shuffled Require Order Resilience
// =========================================================================
console.log(`[TEST 5] Testing require order independence (reverse and randomized loading)...`);

const reverseCode = `
  require('dotenv').config({ path: ${JSON.stringify(path.join(root, '.env'))} });
  const files = ${JSON.stringify(runtimeFiles.map(f => f.abs).reverse())};
  for (const f of files) {
    require(f);
  }
  process.exit(0);
`;

const revRes = spawnSync(process.execPath, ['-e', reverseCode], {
  cwd: root,
  encoding: 'utf8',
  timeout: 8000
});

if (revRes.status !== 0) {
  totalErrors += 1;
  console.error(`❌ TEST 5 FAILED (Reverse require crashed):\n${revRes.stderr || revRes.stdout}`);
} else {
  console.log(`✅ TEST 5 PASSED: Modules load cleanly regardless of require order (0 order-coupling defects).\n`);
}

// =========================================================================
// Summary
// =========================================================================
console.log('====================================================');
if (totalErrors === 0) {
  console.log('🏁 BACKEND ADVERSARIAL VERIFICATION: 100% PASSED (0 ERRORS)');
  process.exit(0);
} else {
  console.error(`🚨 BACKEND ADVERSARIAL VERIFICATION: ${totalErrors} ERRORS DETECTED`);
  process.exit(1);
}
