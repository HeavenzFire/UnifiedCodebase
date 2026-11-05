# HeavenzFire Temporal Runtime v0.1

**Status:** deterministic virtual-time kernel with Node.js contract tests. This is a simulation substrate, not a physical digital twin and not evidence of a measured speedup.

## Purpose

MicroFederation/temporal-runtime.cjs provides a deterministic event scheduler for emulated systems. It separates simulation time from wall-clock time and is intended to support later compute, energy, quantum-circuit, and multi-agent models.

## Contract

- Virtual time is a finite, non-negative numeric domain. It does not read or alter the host clock.
- Events execute in stable (virtual timestamp, insertion sequence) order.
- Handlers are registered by stable identifier and receive JSON payloads.
- Handlers must be synchronous. This restriction keeps event ordering and replay deterministic.
- Handlers may schedule additional events; eligible events execute in the same advancement.
- advanceTo() and advanceBy() enforce monotonic virtual time.
- Cancellation is explicit and only applies to pending events.
- Snapshots contain schema version, virtual time, sequence state, and pending events. Restore requires the matching handler registry.
- An event budget bounds each advancement to prevent an accidental unbounded zero-delay event loop.

## Quick start

```js
const { TemporalRuntime } = require('./temporal-runtime.cjs');

const observations = [];
const runtime = new TemporalRuntime({
  handlers: {
    sample(payload, context) {
      observations.push({ virtualTime: context.now, sensor: payload.sensor });
    }
  }
});

runtime.scheduleAt(100, 'sample', { sensor: 'compute-node-01' });
runtime.advanceTo(1000);
const checkpoint = runtime.snapshot();
```

Run tests:

```sh
node --test MicroFederation/test-temporal-runtime.cjs
```

## What this does not claim

- No physical process, material, grid, processor, or quantum system is currently modeled by this kernel.
- Advancing virtual time by 1000 units does not mean 1000 seconds of physical work completed.
- The runtime does not make compute-bound calculations run faster. Acceleration is useful when a model can skip idle intervals or execute abstract events without simulating every wall-clock instant.
- Snapshots are simulation checkpoints, not a durable research ledger or tamper-proof evidence store.
- A simulation result is not an experimental result. Real-world claims require calibrated models, documented assumptions, uncertainty bounds, measured baselines, and independent validation.

## Fidelity roadmap

1. Temporal kernel (this slice): deterministic event ordering, bounded advancement, cancellation, snapshots, and restore.
2. Model contracts: versioned model metadata, units, parameters, initial conditions, boundary conditions, and explicit assumptions.
3. Calibration and validation: measured input datasets, calibration/holdout separation, residuals, uncertainty estimates, and reproducible baselines.
4. Domain twins: separately validated compute, energy, thermal, and quantum-model adapters. No domain adapter should be called high-fidelity until validated against appropriate measurements.
5. Experiment fabric: resource-limited isolated workers, experiment manifests, content hashes, checkpoint/recovery, and append-only result provenance.
6. Agent research workflow: use the existing 16-role command center for hypothesis generation, model review, implementation, adversarial analysis, and independent verification. Agents propose work; policy gates control execution and publication.

## Safety and operations

- Keep model execution isolated and resource-bounded.
- Do not expose local inference or the Command Center beyond loopback without a separately reviewed authenticated transport.
- Do not give research agents unrestricted shell, filesystem, credentials, or deployment authority.
- Preserve experiment inputs, code revision, environment, random seeds, outputs, and validation status.
- A failed or interrupted run must remain visibly incomplete; recovery must not silently mark it successful.
