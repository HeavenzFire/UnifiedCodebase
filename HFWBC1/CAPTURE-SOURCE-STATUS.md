# Capture-source audit: Scarlet and existing camera path

## Findings

- Searches of the connected HeavenzFire GitHub code and the desktop `HeavenzFire` checkout found no `Scarlet` symbol, adapter, device definition, capture SDK, or test fixture. No Scarlet integration is implemented by this PR.
- The separate `HeavenzFire/HeavenzFire` repository does contain an existing browser-camera path in `UnifiedField/QuantumLab/HeavenzFire-DigitalBrain.html`.
- That page calls `navigator.mediaDevices.getUserMedia` for a user-facing camera stream (ideal 640×480), downsamples frames to 320×240 in a canvas, and throttles frame analysis to approximately 2 Hz.
- The same-origin Digital Brain server accepts JPEG frames at `/api/vision/analyze`, rejects non-JPEG content, enforces a 262,144-byte frame limit, and forwards to the loopback OpenCV service at `127.0.0.1:11802/analyze` with a 3.5-second timeout.
- The existing browser camera path is real camera capture when a user grants permission and a device is present. It is not a Scarlet adapter, and this audit did not execute a live camera capture.
- The existing local-first voice plan describes push-to-talk microphone capture as a planned milestone; it does not establish that microphone capture is implemented.

## Why this is not yet an HFWBC1 capture adapter

The current HFWBC1 audit accepts a 304-byte state-batch wire envelope plus caller-supplied canonical reconstructed-state bytes for CRC verification. JPEG image bytes from the Digital Brain camera path are a different data type. There is no verified transform from those frames into the HFWBC1 predictor state schema or ACTIONS format, so feeding camera JPEGs into HFWBC1 would be an invalid integration.

## Integration gate

To implement Scarlet as a real source adapter, the project needs the actual Scarlet source identity and interface: device/application, transport (USB, serial, network, SDK, or browser API), raw sample format, timestamp/sequence semantics, and one captured sample or vendor/API contract. The adapter must preserve raw capture provenance and must not label synthetic or browser-camera data as Scarlet.

## Source references

- [Digital Brain camera capture](https://github.com/HeavenzFire/HeavenzFire/blob/main/UnifiedField/QuantumLab/HeavenzFire-DigitalBrain.html)
- [Digital Brain local vision server](https://github.com/HeavenzFire/HeavenzFire/blob/main/UnifiedField/QuantumLab/HeavenzFire-DigitalBrain-Server.cjs)
- [Local-first voice plan](https://github.com/HeavenzFire/HeavenzFire/blob/main/docs/LOCAL_FIRST_VOICE_PLAN.md)
