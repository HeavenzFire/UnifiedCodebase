# HFWBC1 v3.1 audit — local test result

**Run:** Windows desktop ZDH, Node.js `node --test`, 2026-11-14 UTC.

## Results

- Structural/CRC audit unit tests: 9 passed, 0 failed.
- Deterministic ACTIONS-only mutation test: 500/500 mutations rejected by the CRC verifier.
- Mutation PRNG: xorshift32, seed 999.
- Mutation scope: one independently mutated byte per trial, selected only from wire offsets 54–303.
- Each mutation starts from the same synthetic 304-byte fixture; the original fixture CRC verifies before mutation.

## Scope limits

This is not the reported full-wire v3.1 fuzz test. It does not test mutations to the baseline, reconstructed state sequence, magic bytes, frequency table semantics, rANS decoding, canonical ACTIONS parsing, or any production 304-byte sample. The fixture magic `TEST01`, baseline-independent state bytes, and byte-order choices are test scaffolding only.

**Interpretation:** the implemented CRC-32 routine and its exact ACTIONS-byte coverage behave as specified for these synthetic fixtures. The production v3.1 claim `0xccec3394` and 500/500 full-wire HARD_FAIL result remain unverified until the original binary, baseline, encoder/decoder, canonical serialization rules, and fuzz corpus are recovered.
