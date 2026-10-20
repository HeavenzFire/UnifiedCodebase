# Guardian Evidence Ledger

A local, append-only JSONL ledger for source-backed claims. It records provenance and hashes; it does **not** prove a source is truthful or a claim is correct.

## Commands

Create a record in JavaScript:

```js
import { createEvidenceRecord, appendEvidenceRecord } from "./evidence-ledger.mjs";

const record = createEvidenceRecord({
  source: "https://agency.example/reports/annual-report.pdf",
  sourceContent: "optional exact captured source text",
  claim: "The report lists $120,000 allocated to program X.",
  capturedAt: "2026-10-20T10:00:00Z",
  state: "unreviewed",
  limitations: ["Primary document not independently corroborated"]
});
await appendEvidenceRecord("./evidence.jsonl", record);
```

Verify an existing ledger:

```powershell
node .\extensions\guardian-evidence\evidence-ledger.mjs verify .\evidence.jsonl
```

Append through the CLI:

```powershell
node .\extensions\guardian-evidence\evidence-ledger.mjs append .\evidence.jsonl '{"source":"https://example.org/report","claim":"Example claim","capturedAt":"2026-10-20T10:00:00Z"}'
```

## Integrity model and limits

- Records are append-only through this API; corrections are new records with `correctsRecordId`, never silent edits.
- SHA-256 hashes detect accidental or unsophisticated edits. They are not digital signatures, trusted timestamps, or proof of authorship; someone able to rewrite the entire file can recompute hashes.
- Source hashes cover supplied `sourceContent` when present, otherwise the source URI. The tool does not fetch, archive, or independently authenticate sources.
- Use HTTPS sources by default. Local or legacy HTTP sources require an explicit documented exception in the API.
- Keep personal, medical, child-identifying, credential, and otherwise sensitive data out of public ledgers. Apply human review before publication.
- Review states are workflow labels, not factual verdicts. Never infer fraud from a discrepancy or a single uncorroborated claim.
