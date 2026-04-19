import { describe, expect, it } from 'bun:test';
import { __getV0SpecIdsForTesting } from './pipeline.ts';
import { loadSpecs } from '../schema/aesthetic-spec.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// This test locks in that V0_RAW_SPECS (the compile-time spec list
// embedded in the binary via JSON import attributes) and the on-disk
// spec JSON files stay in sync. If a new spec lands on disk but isn't
// added to the V0_RAW_SPECS array, this test fails — preventing the
// generate path from silently losing the spec.

describe('V0_RAW_SPECS ↔ on-disk specs parity', () => {
  it('contains every id found in src/renderer/specs/', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const specsDir = join(here, '..', 'renderer', 'specs');
    const onDisk = await loadSpecs(specsDir);

    const v0Ids = new Set(__getV0SpecIdsForTesting());
    const diskIds = new Set([...onDisk.keys()]);

    for (const id of diskIds) {
      expect(v0Ids.has(id)).toBe(true);
    }
    expect(v0Ids.size).toBe(diskIds.size);
  });
});
