# HFWBC1 v3.2 outer-envelope validation

**Run:** Connected Windows desktop ZDH, Node.js `node --test`, 2026-11-14 UTC.

## Results

- v3.2 envelope tests: **22 passed, 0 failed**.
- Combined v3.1 + v3.2 suite: **35 passed, 0 failed** (13 v3.1 + 22 v3.2).
- AES-256-GCM backend known-answer test: NIST empty-message tag `530f8afbc74536b9a963b4f1c4cb738b` reproduced for a 256-bit all-zero key and 96-bit all-zero nonce.
- A direct `crypto.createCipheriv` calculation independently reproduced the envelope module's ciphertext and authentication tag over the exact header plus external context AAD.
- Tampered mode/header, ciphertext, tag, wrong key, and wrong context all failed authentication.
- A deterministic 500-case single-byte mutation sweep across every envelope region rejected all 500 mutations.
- RAW fallback selected HFWBC1 only when the candidate was strictly smaller and within the configured limit; tests verify the opened envelope mode matches the selected fallback mode.
- Fallback candidate lengths are checked before copying; oversized raw candidates can still use a smaller in-limit encoded candidate without copying the oversized raw bytes.
- A mandatory nonce allocator rejected reuse of the same nonce under the same key; a different key has a separate nonce namespace.
- A mandatory replay guard rejected a second acceptance of the same authenticated key/context/nonce tuple.
- Missing nonce allocator or replay guard fails closed.
- Exported MAGIC/OFFSETS mutation does not change internal protocol constants.
- FREQ_C and RANS parser output are compared byte-for-byte with their expected wire slices.
- Successful v3.1 CRC verification returns an immutable Base64 representation of the exact verified ACTIONS bytes, while parsed ACTIONS properties are defensive copies.
- Same-realm and cross-realm SharedArrayBuffer-backed inputs are rejected; ordinary cross-realm Uint8Array inputs are accepted and copied.
- Both sealing and parsing enforce the configured ciphertext limit; oversized input is rejected before the parser copies the envelope.
- CI checkout sets `persist-credentials: false`; test code cannot read the workflow token from the Git checkout configuration.

## Required production interfaces

`sealEnvelope` and `sealWithRawFallback` are async and require `nonceAllocator.claim(keyFingerprint, nonceHex)`. `openEnvelope` is async and requires `replayGuard.claim(keyFingerprint, contextFingerprint, nonceHex)`. Both claims must be atomic and durable across every process/device sharing the relevant key/context namespace. They must return true only for a new claim. The test implementation uses in-memory sets only; it does not satisfy production durability or cross-device coordination.

## Scope limits

This validates the draft envelope framing and use of Node.js AES-256-GCM on synthetic test payloads. It does not establish production key provisioning, key rotation, durable cross-device nonce allocation, replay-store deployment, Scarlet capture integration, or interoperability with another implementation. The fixed magic `HFWG` and envelope version `0x01` are provisional draft choices, not a published or externally approved HFWBC v3.2 standard.

Do not deploy until the nonce allocator and replay guard are integrated with durable atomic stores, key lifecycle is implemented, and independent external review passes.

**Status:** draft implementation; not production-ready.
