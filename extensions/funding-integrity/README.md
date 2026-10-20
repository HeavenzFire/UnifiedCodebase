# Funding Integrity Extension

This extension helps trace public funding from appropriation to award, disbursement, recipient reporting, and delivered services. It is an audit tool, not a payment processor.

Trace model:
appropriation -> award -> obligation -> disbursement -> recipient expenditure -> delivered service -> outcome

Every edge must cite a source, reporting period, currency, and accounting basis. Missing links are gaps, not proof of theft.

## Comparison rules
- Normalize fiscal year, currency, accounting basis, recipient identity, and program identifier.
- Distinguish authorized amount, obligated amount, cash disbursed, reported expenditure, and independently verified service delivery.
- Flag duplicate identifiers, unexplained deltas, late reports, inconsistent totals, and missing documentation for review.
- Show calculation steps and source links for every discrepancy.
- Account for timing differences, restricted funds, reversals, transfers, and legitimate administrative costs.
- Never label a discrepancy "fraud" without corroboration and due process.

## Guardrails
- Read-only data ingestion by default.
- No bank access, payment initiation, account freezing, or funds redirection.
- No automated accusations based solely on anomaly scores.
- Human authorization required for referrals or external disclosures.
- Publish aggregate findings when personal information is unnecessary.
- Keep a tamper-evident audit log and explicit correction process.

## First release acceptance criteria
1. Import a sample CSV with appropriation, award, and disbursement fields.
2. Validate required columns and report malformed rows.
3. Reconcile totals with deterministic arithmetic.
4. Emit an exceptions report with evidence references.
5. Missing data must yield "unknown", not "fraud".
6. The extension has no payment or account-control capability.
