// Prechained Supply Chain Verify — GitHub Action
// https://prechained.com · Built by NextGenRails™
//
// What this does:
//   Reads the EXACT artifact hashes your package manager resolved (from the
//   lockfile), and compares them against the hashes Prechained recorded and
//   Bitcoin-anchored. If a hash differs, the published artifact changed AFTER
//   Prechained's anchored capture — i.e. tamper — and the build fails.
//
// Why the lockfile:
//   package-lock.json (npm) stores `integrity` (SRI sha512) for every resolved
//   package. That is the hash npm itself verifies on install — the bytes that
//   will actually land in your environment. Prechained records the same field
//   at capture time. Comparing them is a true, reproducible tamper check, not a
//   re-hash of metadata. Bitcoin anchoring makes the recorded side unforgeable.

const fs = require('fs');
const https = require('https');

function getInput(name) {
  return process.env[`INPUT_${name.toUpperCase().replace(/-/g, '_')}`] || '';
}
function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (f) fs.appendFileSync(f, `${name}=${value}\n`);
}
function log(m)  { console.log(`[Prechained] ${m}`); }
function warn(m) { console.log(`⚠️  [Prechained] ${m}`); }
function error(m){ console.error(`❌ [Prechained] ${m}`); }

function fetchJSONOnce(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'prechained-action' }, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('Invalid JSON from ' + url)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Request timed out: ' + url)); });
  });
}

// One retry on transient failure (timeout, dropped connection, bad JSON).
// A single network blip should not silently bucket a package as "error".
async function fetchJSON(url) {
  try { return await fetchJSONOnce(url); }
  catch (e) {
    await new Promise(r => setTimeout(r, 500));
    return await fetchJSONOnce(url);
  }
}

// -- Lockfile parsing -------------------------------------------
// Returns [{ name, version, integrity, shasum }] for what will ACTUALLY install.

function parseNpmLock(lockPath) {
  if (!fs.existsSync(lockPath)) return null;
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const out = [];

  // npm v7+ lockfileVersion 2/3: "packages" keyed by "node_modules/<name>"
  if (lock.packages) {
    for (const [key, val] of Object.entries(lock.packages)) {
      if (!key.startsWith('node_modules/')) continue; // skip root ("")
      const name = key.replace(/^.*node_modules\//, '');
      if (!val.version) continue;
      out.push({
        name,
        version: val.version,
        integrity: val.integrity || null,
        shasum: null, // not present in v2/3 packages block
      });
    }
    if (out.length) return out;
  }

  // npm v6 lockfileVersion 1: "dependencies" tree
  if (lock.dependencies) {
    const walk = (deps) => {
      for (const [name, val] of Object.entries(deps)) {
        if (val.version) {
          out.push({
            name,
            version: val.version,
            integrity: val.integrity || null,
            shasum: null,
          });
        }
        if (val.dependencies) walk(val.dependencies);
      }
    };
    walk(lock.dependencies);
  }
  return out.length ? out : null;
}

function detectNpmLock(manifestInput) {
  if (manifestInput && fs.existsSync(manifestInput)) return manifestInput;
  if (fs.existsSync('package-lock.json')) return 'package-lock.json';
  if (fs.existsSync('npm-shrinkwrap.json')) return 'npm-shrinkwrap.json';
  return null;
}

// -- Verify one package against Prechained ----------------------
// Compares the lockfile's integrity to Prechained's recorded artifact_integrity.

async function verifyPackage(apiUrl, ecosystem, pkg) {
  const url = `${apiUrl}?action=fingerprint&package=${encodeURIComponent(pkg.name)}` +
              `&ecosystem=${ecosystem}&version=${encodeURIComponent(pkg.version)}`;
  let resp;
  try { resp = await fetchJSON(url); }
  catch (e) { return { name: pkg.name, version: pkg.version, status: 'error', detail: e.message }; }

  const rec = resp.body;

  if (!rec || rec.found === false) {
    return { name: pkg.name, version: pkg.version, status: 'missing' };
  }

  // No recorded artifact hash to compare against -> can't assert tamper either way.
  if (!rec.artifact_integrity && !rec.artifact_shasum) {
    return {
      name: pkg.name, version: pkg.version, status: 'unverifiable',
      receipt_id: rec.receipt_id, btc_block: rec.btc_block,
      detail: 'recorded before artifact hash was exposed',
    };
  }

  // Primary comparison: SRI integrity (sha512). This is what npm verifies.
  if (pkg.integrity && rec.artifact_integrity) {
    if (pkg.integrity === rec.artifact_integrity) {
      return {
        name: pkg.name, version: pkg.version, status: 'verified',
        receipt_id: rec.receipt_id, btc_block: rec.btc_block,
        btc_anchored: rec.btc_anchored,
      };
    }
    return {
      name: pkg.name, version: pkg.version, status: 'mismatch',
      receipt_id: rec.receipt_id, btc_block: rec.btc_block,
      btc_anchored: rec.btc_anchored,
      recorded: rec.artifact_integrity, observed: pkg.integrity,
      verify_url: rec.verify_url || null,
    };
  }

  // Fallback comparison: shasum (sha1) if integrity absent on either side.
  if (pkg.shasum && rec.artifact_shasum) {
    if (pkg.shasum === rec.artifact_shasum) {
      return { name: pkg.name, version: pkg.version, status: 'verified',
               receipt_id: rec.receipt_id, btc_block: rec.btc_block };
    }
    return { name: pkg.name, version: pkg.version, status: 'mismatch',
             receipt_id: rec.receipt_id, btc_block: rec.btc_block,
             recorded: rec.artifact_shasum, observed: pkg.shasum };
  }

  // Recorded hash exists but lockfile gave us nothing comparable.
  return {
    name: pkg.name, version: pkg.version, status: 'unverifiable',
    receipt_id: rec.receipt_id, btc_block: rec.btc_block,
    detail: 'no comparable hash in lockfile',
  };
}

async function run() {
  const ecosystem = (getInput('ecosystem') || 'npm').toLowerCase();
  const manifestInput = getInput('manifest');
  const failOnMismatch = (getInput('fail-on-mismatch') || 'true') === 'true';
  const failOnMissing  = (getInput('fail-on-missing')  || 'false') === 'true';
  const apiUrl = getInput('api-url') || 'https://prechained.com/.netlify/functions/api';

  log(`Tamper-checking ${ecosystem} dependencies against the Prechained archive`);

  if (ecosystem !== 'npm') {
    warn(`Tamper detection currently supports npm lockfiles. ` +
         `Ecosystem "${ecosystem}" will be skipped. (pypi/cargo lockfile support coming.)`);
    setOutput('verified-count', '0');
    setOutput('missing-count', '0');
    setOutput('mismatch-count', '0');
    return;
  }

  const lockPath = detectNpmLock(manifestInput);
  if (!lockPath) {
    error('No package-lock.json found. A lockfile is required for tamper detection — ' +
          'it contains the exact artifact hashes that will install. Run `npm install` to generate one.');
    process.exit(1);
  }
  log(`Reading resolved hashes from ${lockPath}`);

  const packages = parseNpmLock(lockPath);
  if (!packages || !packages.length) {
    warn('No resolved packages found in lockfile.');
    setOutput('verified-count', '0');
    setOutput('missing-count', '0');
    setOutput('mismatch-count', '0');
    return;
  }
  log(`Found ${packages.length} resolved packages to check`);

  const results = { verified: [], missing: [], mismatch: [], unverifiable: [], errors: [] };

  const batchSize = 5;
  for (let i = 0; i < packages.length; i += batchSize) {
    const batch = packages.slice(i, i + batchSize);
    const settled = await Promise.all(batch.map(p => verifyPackage(apiUrl, ecosystem, p)));
    for (const r of settled) {
      if (r.status === 'verified')          results.verified.push(r);
      else if (r.status === 'missing')      results.missing.push(r);
      else if (r.status === 'mismatch')     results.mismatch.push(r);
      else if (r.status === 'unverifiable') results.unverifiable.push(r);
      else                                  results.errors.push(r);
    }
    if (i + batchSize < packages.length) await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n📊 Prechained Tamper-Detection Summary');
  console.log('='.repeat(54));
  console.log(`✅ Verified (hash matches anchor): ${results.verified.length} / ${packages.length}`);
  console.log(`🚨 MISMATCH (artifact changed):    ${results.mismatch.length} / ${packages.length}`);
  console.log(`📦 Not yet archived:               ${results.missing.length} / ${packages.length}`);
  console.log(`➖ Recorded, not yet comparable:   ${results.unverifiable.length} / ${packages.length}`);
  if (results.errors.length) console.log(`⚠️  Lookup errors:                  ${results.errors.length} / ${packages.length}`);

  if (results.mismatch.length) {
    console.log('\n🚨 TAMPER DETECTED — these artifacts differ from the Bitcoin-anchored record:');
    for (const m of results.mismatch) {
      console.log(`   • ${m.name}@${m.version}`);
      console.log(`       recorded: ${m.recorded}`);
      console.log(`       observed: ${m.observed}`);
      if (m.btc_block) console.log(`       anchor:   BTC #${Number(m.btc_block).toLocaleString()}`);
      if (m.verify_url) console.log(`       verify:   ${m.verify_url}`);
    }
  }

  if (results.missing.length) {
    console.log('\n📦 Not in archive yet (capture at prechained.com/capture):');
    results.missing.slice(0, 10).forEach(p => console.log(`   • ${p.name}@${p.version}`));
    if (results.missing.length > 10) console.log(`   ... and ${results.missing.length - 10} more`);
  }

  // Honest coverage signal: a green check means little if most of the tree
  // could not actually be checked. Surface that explicitly so "passed" is not
  // mistaken for "verified clean".
  const checkable = results.verified.length + results.mismatch.length;
  const pct = packages.length ? Math.round((checkable / packages.length) * 100) : 0;
  console.log(`\nℹ️  Coverage: ${checkable}/${packages.length} (${pct}%) of resolved packages had an anchored hash to compare against.`);
  if (pct < 50) {
    console.log(`   Most dependencies are not yet in the archive, so this run verified little. A pass here does NOT mean "verified clean".`);
  }

  console.log(`\n🔗 Archive: https://prechained.com/browse`);

  setOutput('verified-count', String(results.verified.length));
  setOutput('missing-count', String(results.missing.length));
  setOutput('mismatch-count', String(results.mismatch.length));
  setOutput('coverage-percent', String(pct));
  setOutput('report', JSON.stringify(results));

  if (failOnMismatch && results.mismatch.length > 0) {
    error(`${results.mismatch.length} package(s) FAILED tamper check — artifact hash does not ` +
          `match the Bitcoin-anchored Prechained record. Build blocked.`);
    process.exit(1);
  }
  if (failOnMissing && results.missing.length > 0) {
    error(`${results.missing.length} package(s) not in archive and fail-on-missing is set.`);
    process.exit(1);
  }
}

run().catch(e => { error(e.message); process.exit(1); });
