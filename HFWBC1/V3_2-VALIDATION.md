# HFWBC1 v3.2 outer-envelope validation

**Run:** Connected Windows desktop ZDH, Node.js `node --test`, 2026-11-14 UTC.

## Results

- v3.2 envelope tests: **15 passed, 0 failed**.
- Combined v3.1 + v3.2 suite after parser and envelope hardening: **28 passed, 0 failed**.
- AES-256-GCM backend known-answer test: NIST empty-message tag `530f8afbc74536b9a963b4f1c4cb738b` reproduced for a 256-bit all-zero key and 96-bit all-zero nonce.
- A direct `crypto.createCipheriv` calculation independently reproduced the envelope module's ciphertext and authentication tag over the exact header plus external context AAD.
- Tampered mode/header, ciphertext, tag, wrong key, and wrong context all failed authentication.
- A deterministic 500-case single-byte mutation sweep across every envelope region (header, nonce, length, ciphertext, and tag) rejected all 500 mutations.
- RAW fallback selected HFWBC1 only when the candidate was strictly smaller; equal, larger, or absent compressed candidates selected RAW.
- Both sealing and parsing enforce the configured ciphertext limit; oversized input is rejected before the parser copies the envelope.

## Scope limits

This validates the draft envelope framing and use of Node.js AES-256-GCM on synthetic test payloads. It does not establish production key provisioning, key rotation, durable nonce allocation, replay protection, Scarlet capture integration, or interoperability with another implementation. The fixed magic `HFWG` and envelope version `0x01` are provisional draft choices, not a published or externally approved HFWBC v3.2 standard.

Production must provide a unique 96-bit nonce for every encryption under each key. The current API requires a caller-supplied nonce but intentionally does not implement a durable allocator. Do not deploy until key lifecycle and nonce uniqueness are implemented and independently reviewed.

**Status:** draft implementation; not production-ready.
