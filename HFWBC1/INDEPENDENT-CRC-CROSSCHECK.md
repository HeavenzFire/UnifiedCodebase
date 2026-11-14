# Independent CRC cross-check

A separate Python run on the connected Windows desktop used the standard-library `zlib.crc32`, independently of the JavaScript CRC-32 implementation in this directory.

Observed output:

```text
python_zlib_check=0xcbf43926
independent_action_mutations=500
independent_crc_rejections=500
```

The Python run rebuilt the same synthetic 304-byte test envelope, computed CRC-32 over canonical-state fixture bytes followed by exact ACTIONS bytes, and ran 500 single-byte ACTIONS mutations with xorshift32 seed 999. All 500 mutations produced a CRC mismatch.

This is an independent implementation cross-check of the audit fixture and the ACTIONS coverage rule. It is not a decode or fuzz result for the missing production HFWBC1 v3.1 binary.
