# Prechained Supply Chain Verify

[![Prechained](https://img.shields.io/badge/anchored-prechained.com-orange?style=flat-square)](https://prechained.com)

Detect tampered dependencies in CI by comparing the artifact hashes in your
lockfile against the **Bitcoin-anchored** record in the
[Prechained](https://prechained.com) archive. If a published package's bytes
changed after Prechained recorded and anchored them, this action **fails the
build** — before the tampered code reaches production.

## How it works

1. Reads `package-lock.json` — the exact `integrity` (SRI sha512) hashes npm
   resolved for every dependency. These are the bytes that will actually install.
2. For each package version, asks the Prechained API for the artifact hash it
   recorded at capture time, anchored to a Bitcoin block.
3. Compares them:
   - **match** → verified against an immutable, independently checkable anchor
   - **mismatch** → the artifact changed after the anchor = tamper → build fails
   - **not in archive** → no record yet (does not fail by default)

The recorded side is anchored to Bitcoin, so neither the registry, nor an
attacker, nor Prechained itself can silently rewrite history. The observed side
comes from your own lockfile. Both are reproducible — this is a real check, not
a re-hash of metadata.

## Usage

```yaml
- name: Tamper-check dependencies with Prechained
  uses: ngr-dev1/prechained-action@v1
  with:
    ecosystem: npm
```

A `package-lock.json` must exist (run `npm install` first).

## Full example

```yaml
name: Supply Chain Verification

on: [push, pull_request]

jobs:
  prechained:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install (generates/uses lockfile)
        run: npm ci

      - name: Tamper-check with Prechained
        id: prechained
        uses: ngr-dev1/prechained-action@v1
        with:
          ecosystem: npm
          fail-on-mismatch: true

      - name: Report
        if: always()
        run: |
          echo "Verified: ${{ steps.prechained.outputs.verified-count }}"
          echo "Mismatch: ${{ steps.prechained.outputs.mismatch-count }}"
          echo "Missing:  ${{ steps.prechained.outputs.missing-count }}"
```

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `ecosystem` | Ecosystem (currently `npm`) | `npm` |
| `manifest` | Path to lockfile | auto-detected |
| `fail-on-mismatch` | Fail build on tamper | `true` |
| `fail-on-missing` | Fail build if not yet archived | `false` |
| `api-url` | Prechained API URL | prechained.com |

## Outputs

| Output | Description |
|--------|-------------|
| `verified-count` | Hashes matching the anchored record |
| `mismatch-count` | Tamper detected |
| `missing-count` | Not yet in archive |
| `report` | Full JSON report |

## What a failure proves

A `mismatch` means the artifact your build resolved is **not** the artifact
Prechained recorded and anchored to Bitcoin at the captured timestamp. Either
the package was republished/altered, or your resolution was redirected. Both are
supply-chain events worth stopping a build for.

- **prechained.com** — browse the archive
- **prechained.com/capture** — capture any package on-demand
- **prechained.com/verify** — verify a receipt ID
- **prechained.com/incidents** — incidents with pre-disclosure records

Built by [NextGenRails™](https://nextgenrails.net) · AGPL-3.0
