# Unified Field — Evidence and Verification Infrastructure

**Status:** Proposed measurement protocol  
**Purpose:** Build an auditable, reproducible, local-first AI system and evaluate claims about platform limits, cost, reliability, determinism, and user control.

## Claim discipline

The project does not treat an unexpected quota reset, a paywall, or a product change as proof of individualized targeting. Each claim must be paired with an observable measure, a reproducible method, and a falsification condition.

Distinguish:
1. **Usage extraction:** user activity, data, attention, or compute is converted into provider value.
2. **Paywall pressure:** a free-tier limit blocks a workflow and a paid plan is the only provider-supported continuation path.
3. **Individualized restriction:** evidence links a specific account action to a specific account. Inferring motive requires additional evidence.
4. **Reliability and determinism:** measurable system properties under a declared workload, not marketing adjectives.

## Initial deliverables

### 1. Quota-change evidence ledger
For each observation record:
- product and plan as displayed;
- timestamp with time zone;
- exact reset time/date and usage percentage;
- screenshot or original notice, stored with a SHA-256 digest;
- client/app version and relevant status-page incident;
- whether the observation was independently repeated.

Never edit original evidence. Put annotations in separate files. Redact personal identifiers before public release.

### 2. Repeatable quota protocol
- Capture the displayed quota/reset state at a consistent interval without bypassing access controls.
- Record timezone, clock source, client version, plan label, and observed usage.
- Compare against official documentation and status notices.
- Repeat across multiple normal billing/reset cycles where practical.
- Separate observed facts, plausible explanations, and unresolved questions.
- Do not automate high-volume requests or attempt to evade provider limits.

### 3. Free, local-first Muse-compatible assistant
- Use documented, legally usable open-weight models and runtimes.
- Default to local inference; make network calls explicit and visible.
- Provide an OpenAI-compatible API adapter where technically feasible.
- Keep user data exportable and stored in documented formats.
- Make model, quantization, sampling parameters, seed support, context length, and hardware visible.
- Never claim identical outputs across different hardware/model builds unless tests demonstrate it.

### 4. Determinism and reliability test suite
Publish workload, environment, dependency versions, commands, raw outputs, and failures.
Measure:
- exact-repeat agreement with fixed model/runtime/settings;
- structured-output schema pass rate;
- task success rate on a frozen test set;
- latency p50/p95 and throughput;
- crash/restart recovery;
- offline operation and data-egress behavior;
- memory and disk footprint;
- cost per successful task, including hardware amortization assumptions.

Report confidence intervals where applicable. Baselines must use equivalent prompts, hardware budgets, and workloads.

### 5. Resilience and security
- Local health checks, bounded retries, exponential backoff, circuit breakers, and durable task queues.
- Idempotency keys and append-only event logs.
- Explicit authorization for destructive, privileged, or network-changing actions.
- Secrets excluded from logs; least-privilege tokens; dependency and artifact hashes.
- Backups with tested restore procedures.
- Failure-injection tests and a recovery runbook.

### 6. Multi-agent verification
Agents do not count as independent confirmation merely because there are multiple of them. Record each agent's role, input evidence, tool actions, output, and shared dependencies. Require a separate verifier to reproduce important claims from primary evidence; disclose correlated models or shared sources.

## Minimum evidence bundle

Each published result should include:
- claim ID and precise claim;
- date, scope, and test environment;
- protocol and version;
- raw evidence and SHA-256 hashes;
- expected result and observed result;
- known confounders;
- independent reproduction status;
- limitations and falsification criteria.

## First milestone / acceptance criteria

The first milestone is **an evidence-backed local inference baseline**, not a superlative claim:
1. A clean install runs a supported local model offline.
2. A documented test command emits machine-readable results.
3. Repeated runs preserve configuration and record output variance.
4. A quota-observation record can be created and verified without claiming motive.
5. CI runs the smoke tests and publishes artifacts.
6. A new contributor can reproduce the baseline from the documentation.

Only after these pass should the project make comparative claims such as "more deterministic," "more reliable," or "lower cost." Claims that the Unified Field is "the first" require a defined category, dated prior-art search, and independently reviewable comparison.

## Suggested record format

Use one JSON Lines record per observation, with UTC timestamps and a separate local timezone field:

```json
{
  "schema_version": "1.0",
  "claim_id": "quota-reset-YYYYMMDD-001",
  "product": "product name as displayed",
  "plan": "plan label as displayed",
  "observed_at_utc": "2026-10-20T00:00:00Z",
  "observed_timezone": "America/Chicago",
  "usage_percent": 100,
  "reset_display": "verbatim UI text",
  "evidence_sha256": "hex digest of original screenshot",
  "client_version": "unknown",
  "official_incident_checked": false,
  "notes": "Observation only; cause and motive unconfirmed"
}
```

Replace example values with actual observations. Do not include account IDs, private tokens, or other secrets in public records.
