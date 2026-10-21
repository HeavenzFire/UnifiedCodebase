# Funding reconciliation example

This directory contains **synthetic demonstration data only**. It is not evidence about any real agency, program, recipient, or transaction.

From the repository root, run:

```powershell
node extensions/funding-integrity/reconcile.mjs extensions/funding-integrity/examples/sample-funding.json
```

The output is a read-only JSON report. In the sample, the appropriation and award are both USD 100,000 while recorded disbursements are USD 72,500. Because the reconciler requires all three stages to be present but does not require their totals to match, it should report the USD 27,500 appropriation-to-disbursement gap as an accounting delta requiring review.

Before analyzing real data:
- Preserve source URLs or document identifiers, retrieval dates, reporting periods, and accounting basis in a separate provenance record.
- Verify identifiers and amendments against primary records.
- Minimize personal data and redact sensitive fields that are not needed for reconciliation.
- Treat gaps as unknowns and discrepancies as review items—not proof of fraud or intent.
- Have a qualified human review the source records and timing differences before publication or referral.
