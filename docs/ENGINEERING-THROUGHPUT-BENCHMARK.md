# Engineering Throughput Benchmark — Measurement Contract

**Status:** schema and structural validator implemented; no session records are stored in this repository.  
**Scope:** measure verified engineering output without turning human activity into surveillance or a personal productivity score.

## Measurement rules

- Human active minutes are an explicit contributor-entered value or null. Never infer them from timestamps, commits, PR activity, model latency, token counts, or workflow duration.
- AI/tool elapsed minutes are separate and explicit or null. Do not treat tool time as human labor.
- Start/end timestamps are optional context only. They are not used to calculate human active time or lead time.
- Rework minutes are a subset of explicit human active minutes. If human time is unknown, rework time must also be null.
- First-pass status is a change-level observation repeated consistently across every session with the same change_ref. The summary counts each change once, not each session.
- First-pass yield is reported only when every distinct change has a known first-pass value.
- Rework ratio is reported only when every session has explicit human and rework minutes. Partial datasets do not produce a ratio.
- Preserve blocked, revised, abandoned, and failed work. Do not backfill historical hours or omit unsuccessful sessions.

## Privacy and non-extractive use

- Do not commit session JSONL files, individual records, prompts, personal notes, raw logs, screenshots, provider payloads, credentials, local paths, or case data.
- Keep any private session log outside the repository and apply local access controls, encryption, and a user-defined retention period.
- Use project-scoped pseudonymous references in the form actor_ followed by random lowercase hexadecimal characters. Keep any mapping outside the repository. Do not store names, email addresses, phone numbers, or stable public profile URLs.
- The validator emits aggregate totals only; it does not output actor references or rank contributors.
- This is not employee monitoring. Do not use these measurements to rank individuals or make employment, compensation, benefits, disciplinary, or access decisions.
- Do not compare people. If the benchmark is published, aggregate by task class/workstream and disclose missing data, rework, scope, and uncertainty.

## Acceptance evidence boundary

An accepted capability record must structurally include:
1. A commit SHA.
2. A successful GitHub Actions run URL whose declared head SHA exactly matches that commit.
3. An approved GitHub pull-request review URL whose declared reviewed SHA exactly matches that commit.
4. Distinct project-scoped contributor and reviewer references.

The validator checks format, exact-SHA equality, and distinct references. It does not call GitHub, authenticate a reviewer, verify the workflow run, or prove that the review belongs to the referenced person. These fields remain self-asserted evidence references.

Accordingly, the summary field structurallyEligibleAcceptedCapabilityClaims is not a verified capability count. independentlyVerifiedAcceptedCapabilities is null because this tool does not perform authenticated GitHub API verification. A later trusted attestation layer must independently resolve the run and review through GitHub's read-only API before any result is described as independently verified.

## Files and commands

- Schema: schemas/engineering-session.schema.json
- Validator and aggregate helper: scripts/engineering-session-contract.cjs
- Deterministic tests: scripts/engineering-session-contract.test.cjs
- GitHub Actions workflow: .github/workflows/engineering-session-contract.yml

Validate a private JSONL file without uploading it:

    node scripts/engineering-session-contract.cjs /absolute/path/to/private-session-log.jsonl

The command reads the supplied file locally and prints aggregate counts only. It does not make network requests or write to the file.

The GitHub Actions workflow runs only schema/validator tests on Node 20 and 22. It uses contents: read, does not receive provider credentials, does not upload artifacts, and never reads real session records.

## Metric interpretation

- Verified throughput per human active hour is not calculated until accepted capabilities have independently authenticated evidence and complete human-time observations.
- Lead time is not inferred from session timestamps in this first slice.
- First-pass yield and rework ratio are withheld when their required observations are incomplete.
- A missing value is not zero.
- Commit, PR, test, or generated-code counts are not accepted capability counts.
- No speedup claim is permitted without a comparable conventional baseline and complete active-time data.

## Rollback

Revert the feature-branch commit that adds this contract. No existing task ledger, production service, provider configuration, user data, or runtime path is modified.
