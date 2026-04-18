import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'bun:test';

import { AestheticSpecSchema, loadSpecs } from './aesthetic-spec.ts';

const specsDir = fileURLToPath(
  new URL('../renderer/specs/', import.meta.url),
);

describe('loadSpecs', () => {
  test('loads all v0 specs keyed by id', async () => {
    const specs = await loadSpecs(specsDir);
    expect(specs.size).toBe(5);
    expect(specs.has('executive-broadsheet')).toBe(true);
    expect(specs.has('quiet-ledger')).toBe(true);
    expect(specs.has('guji-classical')).toBe(true);
    expect(specs.has('front-page-daily')).toBe(true);
    expect(specs.has('keynote-sheet')).toBe(true);

    const guji = specs.get('guji-classical');
    expect(guji?.writing_mode).toBe('vertical-rl');
    expect(guji?.severity_style).toBe('traditional-mark');
    expect(guji?.severity_marks?.high).toBe('●');

    const ledger = specs.get('quiet-ledger');
    expect(ledger?.palette.accent).toBeNull();

    const broadsheet = specs.get('executive-broadsheet');
    expect(broadsheet?.severity_colors?.high).toBe('#b23d18');

    const frontPage = specs.get('front-page-daily');
    expect(frontPage?.hero_priority_treatment).toBe('dominant-lead');
    expect(frontPage?.print.orientation).toBe('portrait');

    const keynote = specs.get('keynote-sheet');
    expect(keynote?.severity_style).toBe('none');
    expect(keynote?.print.orientation).toBe('landscape');
    expect(keynote?.hero_priority_treatment).toBe('single-only');
  });

  test('mutating a required field in a copy causes parse failure', async () => {
    // Copy the real executive-broadsheet.json into a temp dir, corrupt the
    // writing_mode to an invalid value, and confirm loadSpecs rejects it.
    const original = JSON.parse(
      await readFile(join(specsDir, 'executive-broadsheet.json'), 'utf8'),
    );
    const corrupted = { ...original, writing_mode: 'diagonal-ul' };

    const tmp = await mkdtemp(join(tmpdir(), 'nocturne-specs-'));
    await writeFile(
      join(tmp, 'executive-broadsheet.json'),
      JSON.stringify(corrupted),
      'utf8',
    );

    await expect(loadSpecs(tmp)).rejects.toThrow(/validation failed/);
  });

  test('removing a required field causes parse failure', async () => {
    const original = JSON.parse(
      await readFile(join(specsDir, 'quiet-ledger.json'), 'utf8'),
    );
    const { fonts: _drop, ...missingFonts } = original;

    const result = AestheticSpecSchema.safeParse(missingFonts);
    expect(result.success).toBe(false);
  });

  test('the shipped specs round-trip through the schema unchanged', async () => {
    const specs = await loadSpecs(specsDir);
    for (const spec of specs.values()) {
      const result = AestheticSpecSchema.safeParse(spec);
      expect(result.success).toBe(true);
    }
  });

  test('unknown block_zones entry (typo) fails validation at load', async () => {
    const original = JSON.parse(
      await readFile(join(specsDir, 'executive-broadsheet.json'), 'utf8'),
    );
    // Typo: "priortities" instead of "top_priorities"
    const corrupted = {
      ...original,
      block_zones: { ...original.block_zones, front: ['priortities'] },
    };

    const tmp = await mkdtemp(join(tmpdir(), 'nocturne-specs-'));
    await writeFile(
      join(tmp, 'executive-broadsheet.json'),
      JSON.stringify(corrupted),
      'utf8',
    );

    await expect(loadSpecs(tmp)).rejects.toThrow(/validation failed/);
  });
});
