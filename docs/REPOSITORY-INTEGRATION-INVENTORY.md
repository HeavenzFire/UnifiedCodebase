# Repository Integration Inventory

This catalog is deliberately a starter set, not a claim that the entire GitHub account has been inventoried. Entries marked `candidate-not-reverified` come from an earlier audit summary and must be rechecked against the current default branch before integration.

## Integration gate

A repository can move from `unassessed` to an integration candidate only after recording:
- Exact repository URL, default branch, and inspected commit SHA.
- Root file listing and detected languages/runtime.
- Build/test commands and observed results (including failures).
- Network listeners, credentials, data flows, and write/destructive capabilities.
- Proposed adapter contract and a test proving its behavior.
- Maintainer review before any merge into `main`.

## Status definitions

- `unassessed`: not yet inspected in this stage.
- `candidate-not-reverified`: candidate surfaced by prior work; current source has not yet been reconfirmed.
- `verified-component`: inspected commit, reproducible checks, and explicit interface contract exist.
- `integrated`: adapter is merged and contract tests pass against the component.
- `blocked`: dependency, security, provenance, or test gap prevents integration.

## Safety boundaries

The catalog must not treat a repository name, README claim, HTTP 200, or green health endpoint as proof of functional integration. No credentials or personal data belong in this file. Keep external-provider calls opt-in, local-first by default, and consequential actions human-approved.
