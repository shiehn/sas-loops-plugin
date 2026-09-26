/**
 * "Recently imported" selection rules (S-015 / D-011): origin === 'import'
 * within the window, newest first, capped; session imports always count
 * (the fallback for hosts that report neither field).
 */

import { describe, it, expect } from '@jest/globals';
import type { PluginSampleInfo } from '@signalsandsorcery/plugin-sdk';
import {
  RECENT_IMPORT_MAX,
  RECENT_IMPORT_WINDOW_DAYS,
  RECENT_IMPORT_WINDOW_MS,
  importedTitle,
  parseImportedAt,
  selectRecentlyImported,
} from '../recently-imported';

const NOW = Date.parse('2026-09-26T18:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const NO_SESSION: ReadonlyMap<string, number> = new Map();

function row(id: string, extra: Partial<PluginSampleInfo> = {}): PluginSampleInfo {
  return {
    id,
    filename: `${id}.wav`,
    filePath: `/library/${id}.wav`,
    category: null,
    bpm: 94,
    keyTonic: null,
    keyMode: null,
    durationSeconds: 10,
    fileSizeBytes: 1024,
    tags: null,
    ...extra,
  };
}

function imported(id: string, agoMs: number): PluginSampleInfo {
  return row(id, { origin: 'import', importedAt: new Date(NOW - agoMs).toISOString() });
}

const ids = (rows: { sample: PluginSampleInfo }[]): string[] => rows.map((r) => r.sample.id);

describe('recently imported: constants', () => {
  it('the window is 7 days and the cap is 10', () => {
    expect(RECENT_IMPORT_WINDOW_DAYS).toBe(7);
    expect(RECENT_IMPORT_WINDOW_MS).toBe(7 * DAY);
    expect(RECENT_IMPORT_MAX).toBe(10);
  });
});

describe('selectRecentlyImported', () => {
  it('is empty when nothing qualifies (the panel then hides the section)', () => {
    expect(selectRecentlyImported([], NO_SESSION, NOW)).toEqual([]);
    expect(selectRecentlyImported([row('legacy'), row('pack', { origin: 'pack', importedAt: new Date(NOW).toISOString() })], NO_SESSION, NOW)).toEqual([]);
  });

  it("keeps only origin 'import': pack rows and rows with no origin are left out", () => {
    const rows = [
      imported('mine', DAY),
      row('pack', { origin: 'pack', importedAt: new Date(NOW - DAY).toISOString() }),
      row('fitted-copy', { importedAt: new Date(NOW - DAY).toISOString() }), // host-derived: no origin
      row('legacy'),
    ];
    expect(ids(selectRecentlyImported(rows, NO_SESSION, NOW))).toEqual(['mine']);
  });

  it('an import row with a missing or unparseable importedAt is unknown, not recent', () => {
    const rows = [row('no-date', { origin: 'import' }), row('bad-date', { origin: 'import', importedAt: 'yesterday' })];
    expect(selectRecentlyImported(rows, NO_SESSION, NOW)).toEqual([]);
    expect(parseImportedAt('yesterday')).toBeNull();
    expect(parseImportedAt(undefined)).toBeNull();
  });

  it('orders newest first', () => {
    const rows = [imported('old', 3 * DAY), imported('newest', 60_000), imported('mid', DAY)];
    const out = selectRecentlyImported(rows, NO_SESSION, NOW);
    expect(ids(out)).toEqual(['newest', 'mid', 'old']);
    expect(out[0].at).toBe(NOW - 60_000);
  });

  it('caps the section at RECENT_IMPORT_MAX, keeping the newest', () => {
    const rows = Array.from({ length: 14 }, (_, i) => imported(`s${i}`, (i + 1) * 60_000));
    const out = selectRecentlyImported(rows, NO_SESSION, NOW);
    expect(out).toHaveLength(RECENT_IMPORT_MAX);
    expect(ids(out)).toEqual(Array.from({ length: 10 }, (_, i) => `s${i}`));
  });

  it('cuts off at 7 days: exactly 7 days is in, a moment older is out', () => {
    const rows = [imported('edge', RECENT_IMPORT_WINDOW_MS), imported('stale', RECENT_IMPORT_WINDOW_MS + 1), imported('eight-days', 8 * DAY)];
    expect(ids(selectRecentlyImported(rows, NO_SESSION, NOW))).toEqual(['edge']);
  });

  it('a timestamp slightly in the future (clock skew) still counts as recent', () => {
    expect(ids(selectRecentlyImported([imported('skew', -5_000)], NO_SESSION, NOW))).toEqual(['skew']);
  });

  it('session fallback: with no host fields, this session\'s imports make the section', () => {
    const rows = [row('a'), row('b'), row('pack-unknown'), row('c')];
    const session = new Map([['a', NOW - 2_000], ['c', NOW - 1_000]]);
    const out = selectRecentlyImported(rows, session, NOW);
    expect(ids(out)).toEqual(['c', 'a']);
    expect(out.every((r) => r.isNew)).toBe(true);
  });

  it('session imports and host imports merge; only session rows are "new"', () => {
    const rows = [imported('host-only', DAY), imported('both', 2 * DAY), row('pack-dup', { origin: 'pack', importedAt: new Date(NOW - 9 * DAY).toISOString() })];
    const session = new Map([['both', NOW - 1_000], ['pack-dup', NOW - 500]]);
    const out = selectRecentlyImported(rows, session, NOW);
    // The session time wins for 'both' (newer), and a file the user just picked counts even when it matched a pack row.
    expect(ids(out)).toEqual(['pack-dup', 'both', 'host-only']);
    expect(out.map((r) => r.isNew)).toEqual([true, true, false]);
  });

  it('a session id that is not in the library is not shown', () => {
    expect(selectRecentlyImported([row('a')], new Map([['gone', NOW]]), NOW)).toEqual([]);
  });
});

describe('importedTitle', () => {
  it('names the import date for the hover text', () => {
    expect(importedTitle(NOW)).toMatch(/^Imported .*2026/);
  });
});
