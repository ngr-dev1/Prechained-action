# Prechained Supply Chain Verify

[![Prechained](https://img.shields.io/badge/archived-prechained.com-orange?style=flat-square)](https://prechained.com)

Verify your dependencies against the [Prechained](https://prechained.com) cryptographic archive — a free, public, Bitcoin-anchored record of the software supply chain.

Every major npm, PyPI, and Cargo package is captured and fingerprinted every 10 minutes. This action checks whether your dependencies have pre-incident records, giving you forensic proof that you were using clean versions before any attack occurred.

## Usage

```yaml
- name: Verify dependencies with Prechained
  uses: ngr-dev1/prechained-action@v1
  with:
    ecosystem: npm
```

## Full example

```yaml
name: Supply Chain Verification

on: [push, pull_request]

jobs:
  prechained:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Verify dependencies with Prechained
        uses: ngr-dev1/prechained-action@v1
        with:
          ecosystem: npm
          manifest: package.json
          fail-on-missing: false
        
      - name: Print verification report
        run: |
          echo "Verified: ${{ steps.prechained.outputs.verified-count }}"
          echo "Missing:  ${{ steps.prechained.outputs.missing-count }}"
```

## Inputs

| Input | Description | Default |
|-------|-------------|---------|
| `ecosystem` | Package ecosystem (`npm`, `pypi`, `cargo`) | `npm` |
| `manifest` | Path to manifest file | Auto-detected |
| `fail-on-missing` | Fail build if packages not in archive | `false` |
| `api-url` | Prechained API URL | `https://prechained.com/.netlify/functions/api` |

## Outputs

| Output | Description |
|--------|-------------|
| `verified-count` | Number of packages found in archive |
| `missing-count` | Number of packages not yet archived |
| `report` | JSON verification report |

## What this proves

When a supply chain attack is disclosed, Prechained receipts prove your CI/CD was pulling from clean, pre-attack package versions. Every verified package has a SHA-384 fingerprint and Bitcoin block height anchoring it in time.

- **prechained.com** — Browse the archive
- **prechained.com/capture** — Capture any package on-demand
- **prechained.com/verify** — Verify a receipt ID
- **prechained.com/incidents** — Incidents where Prechained had pre-disclosure records

Built by [NextGenRails™](https://nextgenrails.net) · AGPL-3.0
