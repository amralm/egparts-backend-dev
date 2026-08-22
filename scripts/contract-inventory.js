'use strict';

const fs = require('node:fs');
const path = require('node:path');

const backendRoot = path.resolve(__dirname, '..');
const frontendRoot = path.resolve(backendRoot, '..', 'frontend');
const outputDir = path.join(backendRoot, 'audit');
const outputFile = path.join(outputDir, 'contract-inventory.json');

function filesUnder(root, extensions, ignored = new Set()) {
  if (!fs.existsSync(root)) return [];
  const result = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) result.push(full);
    }
  };
  visit(root);
  return result;
}

function relative(root, file) { return path.relative(root, file).replaceAll(path.sep, '/'); }
function matches(text, regex) { return [...text.matchAll(regex)].map((match) => match[0]); }
function collect(root, files, rules) {
  return files.flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    return rules.flatMap(({ name, regex }) => matches(text, regex).map((value) => ({ file: relative(root, file), name, value })));
  });
}

const backendRuntime = filesUnder(backendRoot, ['.js'], new Set(['node_modules', 'dist', 'recovery', 'scratch', 'coverage']));
const frontendRuntime = filesUnder(path.join(frontendRoot, 'src'), ['.js', '.jsx'], new Set(['node_modules', 'dist']));
const migrations = filesUnder(path.join(backendRoot, 'supabase_tabled-and-rows'), ['.sql']);

const backendFindings = collect(backendRoot, backendRuntime, [
  { name: 'route', regex: /router\.(get|post|put|patch|delete|options)\s*\([^\n]*/g },
  { name: 'request_input', regex: /req\.(body|query|params|headers)\b[^\n]*/g },
  { name: 'supabase_call', regex: /supabase\.(rpc|from)\s*\([^\n]*/g },
  // Multiline response validation is authoritative in contract-audit.js. The
  // inventory keeps only same-line hits to avoid treating unrelated logger or
  // Supabase variables as response fields.
  { name: 'response_error_key', regex: /res\.(?:status\([^)]*\)\.)?json\(\{[^\n]*\berror\s*:/g },
  { name: 'legacy_payment_value', regex: /\b(?:manual|paymob|cash_on_delivery)\b/g },
  { name: 'tenant_header', regex: /x-(?:store-subdomain|original-host)/gi },
]);

const frontendFindings = collect(frontendRoot, frontendRuntime, [
  { name: 'api_call', regex: /\b(?:authFetch|apiClient\.(?:get|post|put|patch|delete|request))\s*\(/g },
  { name: 'direct_api_client', regex: /(?<!\.)\b(?:fetch|axios)\s*\(/g },
  { name: 'form_input', regex: /\b(?:onSubmit|onChange|FormData|input|textarea|select)\b/g },
]);

const migrationFindings = migrations.flatMap((file) => {
  const text = fs.readFileSync(file, 'utf8');
  return [
    ...matches(text, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+[^\n]*/gi).map((value) => ({ file: relative(backendRoot, file), name: 'rpc_function', value })),
    ...matches(text, /CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+[^\n]*/gi).map((value) => ({ file: relative(backendRoot, file), name: 'trigger', value })),
    ...matches(text, /CREATE\s+POLICY\s+[^\n]*/gi).map((value) => ({ file: relative(backendRoot, file), name: 'rls_policy', value })),
    ...matches(text, /SECURITY\s+DEFINER/gi).map((value) => ({ file: relative(backendRoot, file), name: 'security_definer', value })),
  ];
});

const inventory = {
  generated_at: new Date().toISOString(),
  roots: { backend: backendRoot, frontend: frontendRoot },
  files: { backend_runtime: backendRuntime.length, frontend_runtime: frontendRuntime.length, migrations: migrations.length },
  backend: backendFindings,
  frontend: frontendFindings,
  database: migrationFindings,
  summary: {
    backend_routes: backendFindings.filter((item) => item.name === 'route').length,
    backend_inputs: backendFindings.filter((item) => item.name === 'request_input').length,
    supabase_calls: backendFindings.filter((item) => item.name === 'supabase_call').length,
    frontend_api_calls: frontendFindings.filter((item) => item.name === 'api_call').length,
    frontend_direct_clients: frontendFindings.filter((item) => item.name === 'direct_api_client').length,
    response_error_keys: backendFindings.filter((item) => item.name === 'response_error_key').length,
    rpc_functions: migrationFindings.filter((item) => item.name === 'rpc_function').length,
    triggers: migrationFindings.filter((item) => item.name === 'trigger').length,
    rls_policies: migrationFindings.filter((item) => item.name === 'rls_policy').length,
    security_definers: migrationFindings.filter((item) => item.name === 'security_definer').length,
  }
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(inventory, null, 2) + '\n');
console.log(JSON.stringify({ output: relative(backendRoot, outputFile), ...inventory.summary }, null, 2));
