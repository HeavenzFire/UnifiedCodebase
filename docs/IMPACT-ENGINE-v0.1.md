# HeavenzFire Impact Engine v0.1

**Status:** deterministic prioritization prototype; not an emergency-response, financial-advice, clinical, or infrastructure-control system.

## Purpose

Rank candidate interventions across three dimensions: life safety, financial efficiency, and resource conservation. The engine makes assumptions visible, requires evidence references, and keeps prioritization separate from authorization and execution.

## Implementation

- `MicroFederation/impact-engine.cjs`: pure CommonJS validation, scoring, ranking, and baseline/outcome comparison.
- `MicroFederation/test-impact-engine.cjs`: Node built-in test suite.
- `schemas/impact-opportunity.schema.json`: machine-readable input contract.

## Score

Each impact dimension is rated 0–5. The weighted impact score is life safety 50%, financial 30%, and resource 20%. It is adjusted by declared evidence quality and feasibility (each multiplier 0.5–1.0) and urgency (0.8–1.0). The resulting 0–100 score is a triage aid, not a prediction of lives saved, dollars saved, or physical resources conserved.

Evidence quality, feasibility, and urgency are explicit human-supplied assessments. They must be supported in the evidence bundle; the engine does not infer their truth.

## Evidence and outcomes

Every candidate requires at least one evidence reference. Evidence levels distinguish unverified, source-supported, and independently reproduced material. Optional SHA-256 digests bind a record to captured evidence; they do not prove that the source itself is truthful.

`compareOutcome()` compares baseline and observed measurements only when units match. It deliberately returns `verified: false`; an independent reviewer, measurement protocol, time window, and source evidence are still required before reporting verified impact. Estimates remain estimates and must not be presented as realized savings.

## Safety and governance

- No automated execution is authorized by this module.
- Any candidate with a non-zero life-safety impact requires human review and safe pilot design.
- No clinical triage, emergency dispatch, autonomous control of utilities, movement of money, or contact with authorities is implemented.
- Real-world deployment requires domain experts, appropriate institutional approvals, privacy review, operational safeguards, and a rollback plan.
- Do not put personal, medical, child, or other sensitive case data in public opportunity records.

## Run tests

From the repository root:

```sh
node --test MicroFederation/test-impact-engine.cjs
```

## Initial pilot selection

Start with non-invasive, reversible measurement pilots (for example, metering-based water/energy loss audits or administrative process-time baselines). Do not claim savings until a pre-registered baseline and post-intervention measurement are independently reviewed.
