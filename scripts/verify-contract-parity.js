const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Parity is SEMANTIC: contracts are canonicalized with recursive key sorting
// before hashing so formatting and key insertion order differences never fail
// the verification, while any real value, field, or schema change fails immediately.

const backendContractPath = path.resolve(__dirname, '..', 'contracts', 'api-contract.json');
const frontendContractPath = process.env.FRONTEND_CONTRACT_PATH || path.resolve(__dirname, '..', '..', 'frontend', 'src', 'contracts', 'api-contract.json');

function sortObjectKeys(value) {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  const sortedObj = {};
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    sortedObj[key] = sortObjectKeys(value[key]);
  }
  return sortedObj;
}

function canonicalize(bufferOrString) {
  const text = Buffer.isBuffer(bufferOrString) ? bufferOrString.toString('utf8') : String(bufferOrString);
  const parsed = JSON.parse(text);
  const sorted = sortObjectKeys(parsed);
  return JSON.stringify(sorted);
}

function semanticHash(bufferOrString) {
  let canonical;
  try {
    canonical = canonicalize(bufferOrString);
  } catch (error) {
    throw new Error(`Contract file is not valid JSON: ${error.message}`);
  }
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function reportDrift(backendHash, frontendHash) {
  console.error(`Contract drift detected!`);
  console.error(`Backend SHA-256:  ${backendHash}`);
  console.error(`Frontend SHA-256: ${frontendHash}`);
  console.error('Canonical copy lives in backend/contracts/api-contract.json; synchronize frontend/src/contracts/api-contract.json.');
  process.exit(1);
}

function main() {
  if (!fs.existsSync(backendContractPath)) {
    console.error(`Backend contract file not found: ${backendContractPath}`);
    process.exit(1);
  }

  const backendContent = fs.readFileSync(backendContractPath);
  let backendHash;
  try {
    backendHash = semanticHash(backendContent);
  } catch (err) {
    console.error(`Backend contract error: ${err.message}`);
    process.exit(1);
  }

  if (fs.existsSync(frontendContractPath)) {
    const frontendContent = fs.readFileSync(frontendContractPath);
    let frontendHash;
    try {
      frontendHash = semanticHash(frontendContent);
    } catch (err) {
      console.error(`Frontend contract error: ${err.message}`);
      process.exit(1);
    }

    if (backendHash !== frontendHash) {
      reportDrift(backendHash, frontendHash);
    }

    console.log(`Contract parity passed against Frontend (${backendHash}).`);
    process.exit(0);
  }

  // If frontend is not available locally (e.g. isolated backend container), validate backend contract integrity
  console.log(`Backend contract integrity verified (${backendHash}). Frontend sibling not present.`);
  process.exit(0);
}

main();
