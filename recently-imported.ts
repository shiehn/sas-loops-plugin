/**
 * "Recently imported" section of the + Library picker (S-015 / D-011): pure
 * selection rules, kept out of LoopsPanel so they can be unit-tested without
 * rendering.
 *
 * Steve: a single imported Splice WAV "worked, but it was hard to find in my
 * library ... show a section in the library like recently imported .. if
 * infact something was recently imported?"
 *
 * A sample qualifies when EITHER
 *   - the host says the user brought it in recently: `origin === 'import'`
 *     and `importedAt` within {@link RECENT_IMPORT_WINDOW_MS} (SDK 3.18.0;
 *     a `'pack'` row or a row with no `origin` is left out, so a pack
 *     download never floods the section and host-made fitted/stretched
 *     copies never show), OR
 *   - this panel session imported it ("From disk"). That keeps the section
 *     working on a host that reports neither field, and it always shows what
 *     the user just picked.
 * Newest first, capped at {@link RECENT_IMPORT_MAX}. Empty → the panel hides
 * the section.
 */

import type { PluginSampleInfo } from '@signalsandsorcery/plugin-sdk';

/** How far back "recent" reaches, in days. */
export const RECENT_IMPORT_WINDOW_DAYS = 7;
/** {@link RECENT_IMPORT_WINDOW_DAYS} in milliseconds. */
export const RECENT_IMPORT_WINDOW_MS = RECENT_IMPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** Most rows the section shows. */
export const RECENT_IMPORT_MAX = 10;
/** How long the just-imported rows stay highlighted after "From disk" opens the picker. */
export const RECENT_HIGHLIGHT_MS = 4000;

/** One row of the section. */
export interface RecentImport {
  sample: PluginSampleInfo;
  /** When it was imported (ms since epoch): the newer of the host's `importedAt` and this session's import. */
  at: number;
  /** Imported in THIS panel session (the "new" badge). */
  isNew: boolean;
}

/** `importedAt` as ms since epoch, or null when absent or unparseable. */
export function parseImportedAt(importedAt: string | undefined): number | null {
  if (!importedAt) return null;
  const ms = Date.parse(importedAt);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The section's rows, newest first.
 *
 * @param samples       the library rows the picker lists (`host.getSamples()`)
 * @param sessionImports sample id → when this panel session imported it (ms)
 * @param now           the current time (ms), injectable for tests
 */
export function selectRecentlyImported(
  samples: readonly PluginSampleInfo[],
  sessionImports: ReadonlyMap<string, number>,
  now: number,
  windowMs: number = RECENT_IMPORT_WINDOW_MS,
  max: number = RECENT_IMPORT_MAX,
): RecentImport[] {
  const rows: RecentImport[] = [];
  const seen = new Set<string>();
  for (const sample of samples) {
    if (seen.has(sample.id)) continue;
    const sessionAt = sessionImports.get(sample.id);
    const hostAt = sample.origin === 'import' ? parseImportedAt(sample.importedAt) : null;
    // A timestamp in the future (clock skew) counts as recent, never as old.
    const hostRecent = hostAt !== null && now - hostAt <= windowMs;
    if (sessionAt === undefined && !hostRecent) continue;
    seen.add(sample.id);
    const at = Math.max(hostRecent && hostAt !== null ? hostAt : -Infinity, sessionAt ?? -Infinity);
    rows.push({ sample, at, isNew: sessionAt !== undefined });
  }
  // Newest first; stable for equal times (library order).
  rows.sort((a: RecentImport, b: RecentImport) => b.at - a.at);
  return rows.slice(0, Math.max(0, max));
}

/** Hover text for a row: "Imported Sep 26, 2026, 2:42 PM". */
export function importedTitle(at: number): string {
  const date = new Date(at);
  let when: string;
  try {
    when = date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    when = date.toISOString();
  }
  return `Imported ${when}`;
}
