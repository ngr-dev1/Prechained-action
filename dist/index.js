// Prechained Supply Chain Verify — GitHub Action
// https://prechained.com · Built by NextGenRails™

const fs = require('fs');
const path = require('path');
const https = require('https');

// Simple input getter (works without @actions/core for zero-dependency)
function getInput(name) {
  return process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] || '';
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) fs.appendFileSync(outputFile, `${name}=${value}\n`);
}

function log(msg) { console.log(`[Prechained] ${msg}`); }
function warn(msg) { console.log(`⚠️  [Prechained] ${msg}`); }
function error(msg) { console.error(`❌ [Prechained] ${msg}`); }

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON response')); }
      });
    }).on('error', reject);
  });
}

function parseNpm(manifestPath) {
  const file = manifestPath || 'package.json';
  if (!fs.existsSync(file)) return [];
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return Object.keys(deps).map(name => ({ name, version: deps[name].replace(/[\^~>=<]/g, '').split(' ')[0] }));
}

function parsePypi(manifestPath) {
  const file = manifestPath || 'requirements.txt';
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'))
    .map(l => {
      const [name, version] = l.split(/[==>=<]/);
      return { name: name.trim(), version: (version || '').trim() };
    });
}

function parseCargo(manifestPath) {
  const file = manifestPath || 'Cargo.toml';
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, 'utf8');
  const deps = [];
  const depSection = content.match(/\[dependencies\]([\s\S]*?)(?=\[|$)/);
  if (!depSection) return [];
  const lines = depSection[1].split('\n').filter(l => l.trim() && !l.startsWith('#'));
  for (const line of lines) {
    const match = line.match(/^(\S+)\s*=\s*"([^"]+)"/);
    if (match) deps.push({ name: match[1], version: match[2] });
  }
  return deps;
}

async function verifyPackage(apiUrl, ecosystem, name, version) {
  try {
    const url = `${apiUrl}?action=fingerprint&package=${encodeURIComponent(name)}&ecosystem=${ecosystem}${version ? `&version=${encodeURIComponent(version)}` : ''}`;
    const data = await fetchJSON(url);
    return data;
  } catch(e) {
    return { found: false, error: e.message };
  }
}

async function run() {
  const ecosystem = getInput('ecosystem') || 'npm';
  const manifestPath = getInput('manifest');
  const failOnMissing = getInput('fail-on-missing') === 'true';
  const apiUrl = getInput('api-url') || 'https://prechained.com/.netlify/functions/api';

  log(`Verifying ${ecosystem} dependencies against Prechained archive...`);
  log(`API: ${apiUrl}`);

  let packages = [];
  if (ecosystem === 'npm') packages = parseNpm(manifestPath);
  else if (ecosystem === 'pypi') packages = parsePypi(manifestPath);
  else if (ecosystem === 'cargo') packages = parseCargo(manifestPath);

  if (packages.length === 0) {
    warn(`No packages found for ecosystem: ${ecosystem}`);
    setOutput('verified-count', '0');
    setOutput('missing-count', '0');
    return;
  }

  log(`Found ${packages.length} packages to verify`);

  const results = { verified: [], missing: [], errors: [] };

  // Verify in batches of 5 to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < packages.length; i += batchSize) {
    const batch = packages.slice(i, i + batchSize);
    await Promise.all(batch.map(async (pkg) => {
      const result = await verifyPackage(apiUrl, ecosystem, pkg.name, pkg.version);
      if (result.found) {
        results.verified.push({ ...pkg, receipt_id: result.receipt_id, btc_block: result.btc_block });
      } else if (result.error) {
        results.errors.push({ ...pkg, error: result.error });
      } else {
        results.missing.push(pkg);
      }
    }));
    // Small delay between batches
    if (i + batchSize < packages.length) await new Promise(r => setTimeout(r, 200));
  }

  // Summary
  console.log('\n📊 Prechained Verification Summary');
  console.log('═'.repeat(50));
  console.log(`✅ Verified in archive:  ${results.verified.length} / ${packages.length}`);
  console.log(`❌ Not in archive:       ${results.missing.length} / ${packages.length}`);
  if (results.errors.length) console.log(`⚠️  Errors:               ${results.errors.length} / ${packages.length}`);

  if (results.missing.length > 0) {
    console.log('\n📦 Missing from archive (capture at prechained.com/capture):');
    results.missing.slice(0, 10).forEach(p => console.log(`   • ${p.name}${p.version ? `@${p.version}` : ''}`));
    if (results.missing.length > 10) console.log(`   ... and ${results.missing.length - 10} more`);
  }

  if (results.verified.length > 0) {
    console.log('\n🔐 Sample verified receipts:');
    results.verified.slice(0, 5).forEach(p => {
      if (p.receipt_id) console.log(`   • ${p.name} → ${p.receipt_id} (BTC #${p.btc_block || 'pending'})`);
    });
  }

  console.log(`\n🔗 Full archive: https://prechained.com/browse`);

  setOutput('verified-count', String(results.verified.length));
  setOutput('missing-count', String(results.missing.length));
  setOutput('report', JSON.stringify(results));

  if (failOnMissing && results.missing.length > 0) {
    error(`${results.missing.length} packages not found in Prechained archive. Set fail-on-missing: false to allow.`);
    process.exit(1);
  }
}

run().catch(e => {
  error(e.message);
  process.exit(1);
});
