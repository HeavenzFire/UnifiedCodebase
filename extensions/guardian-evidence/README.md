# Guardian Evidence Extension

Purpose: support auditable investigations into public spending, grants, contracts, healthcare funding, and service delivery while minimizing harm to vulnerable people.

## Required record contract
- record_id: stable local identifier (UUID recommended)
- source_url: public source URL where legally available
- retrieved_at_utc: retrieval timestamp
- claim: narrow, testable statement
- evidence_excerpt: minimal relevant excerpt
- confidence: low / medium / high with rationale
- contradicting_evidence: counter-evidence or "not yet checked"
- review_status: unreviewed / corroborated / disputed / corrected
- pii_review: passed / redacted / blocked

## Safety and integrity gates
1. Separate allegations, hypotheses, verified facts, and legal conclusions.
2. Require independent corroboration before escalating a claim.
3. Preserve provenance and corrections; never silently overwrite a finding.
4. Minimize personal data, especially information concerning children, patients, and survivors.
5. Do not infer guilt, fraud, or intent from anomalies alone.
6. Require human review before publication, referral, or contact with an accused party.
7. Do not bypass access controls or collect credentials.
8. This extension cannot issue payments, freeze accounts, redirect grants, or make eligibility decisions. It prepares evidence for authorized review.

## Initial integration seams
Inputs: public URLs, user-authorized documents, structured CSV/JSON.
Outputs: append-only evidence ledger, provenance manifest, discrepancy queue.
Acceptance: schema validation, PII checks, reproducible source hashes, correction history, and case export.
