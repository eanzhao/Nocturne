import { describe, expect, it } from 'bun:test';
import { __resetSpecsForTesting } from './pipeline.ts';
import { loadSpecs } from '../schema/aesthetic-spec.ts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import broadsheetRaw from '../renderer/specs/executive-broadsheet.json' with { type: 'json' };
import quietRaw from '../renderer/specs/quiet-ledger.json' with { type: 'json' };
import gujiRaw from '../renderer/specs/guji-classical.json' with { type: 'json' };
import frontPageRaw from '../renderer/specs/front-page-daily.json' with { type: 'json' };
import keynoteRaw from '../renderer/specs/keynote-sheet.json' with { type: 'json' };

// This test locks in that V0_RAW_SPECS and the on-disk specs stay in
// sync. If a new spec lands on disk but isn't added to the pipeline
// import list, this test fails and the generate path silently losing
// the spec is caught early.

describe('V0_RAW_SPECS ↔ on-disk specs parity', () => {
  it('contains every id found in src/renderer/specs/', async () => {
    __resetSpecsForTesting();
    const here = dirname(fileURLToPath(import.meta.url));
    const specsDir = join(here, '..', 'renderer', 'specs');
    const onDisk = await loadSpecs(specsDir);

    const importedIds = new Set(
      [broadsheetRaw, quietRaw, gujiRaw, frontPageRaw, keynoteRaw].map(
        (s) => (s as { id: string }).id,
      ),
    );
    const diskIds = new Set([...onDisk.keys()]);

    for (const id of diskIds) {
      expect(importedIds.has(id)).toBe(true);
    }
    expect(importedIds.size).toBe(diskIds.size);
  });
});
