/**
 * "From disk" (Load) flow: pure helpers, kept out of LoopsPanel so the wording
 * and the placement rules can be unit-tested without rendering.
 *
 * D-010 (Steve): pick one or more files; each is imported, fitted to the
 * project tempo and scene length, and put on a new track in the active scene,
 * with a message per loop ("4 bars @ 94 BPM → added"). A file already in the
 * library is simply added. When the loop can't be placed (no scene, no
 * contract, not connected, track limit) it is still imported and the message
 * says why and what to do next: nothing is silent.
 */

import type { PluginSampleInfo } from '@signalsandsorcery/plugin-sdk';

/** Label of the library-picker button: the messages below point the user at it. */
export const LIBRARY_BUTTON_LABEL = '+ Library';

/** A state that stops ANY loop from being placed; checked before placing starts. */
export type PlacementBlocker = 'no-scene' | 'no-contract' | 'not-connected' | 'track-limit';

/**
 * Why loops were left in the library instead of placed:
 * - a {@link PlacementBlocker};
 * - `scene-changed`: the user switched scenes mid-batch;
 * - `host-error`: the host refused with a scene-wide error code (the host's
 *   message is carried in `LoadOutcome.leftDetail`);
 * - `old-host`: the host predates SDK 3.18.0 and returns no sample ids, so the
 *   panel can import but not place.
 */
export type LeftReason = PlacementBlocker | 'scene-changed' | 'host-error' | 'old-host';

/**
 * Host error codes that apply to the whole scene, not to one file: once one of
 * these comes back, every later loop would fail the same way, so the batch
 * stops and imports the rest into the library. Matched on the structural
 * `code` field (never on message text).
 */
export const SCENE_WIDE_ERROR_CODES: ReadonlySet<string> = new Set([
  'TRACK_LIMIT_EXCEEDED',
  'NO_ACTIVE_SCENE',
  'TIME_SIGNATURE_UNSUPPORTED',
]);

/** A file named by the user; `name` is null when an old host can't say which one. */
export interface LoadedFile {
  name: string | null;
  /** True when the file was already in the library (content match). */
  duplicate: boolean;
}

export interface PlacedLoop extends LoadedFile {
  name: string;
  /** e.g. "4 bars @ 94 BPM"; null when the library has no tempo for it. */
  detail: string | null;
}

export interface FailedFile {
  name: string | null;
  /** Host message, when the host gave one. */
  error: string | null;
}

export interface LoadOutcome {
  /** Number of files the user picked. */
  picked: number;
  /** Loops placed on new tracks, in pick order. */
  added: PlacedLoop[];
  /** Loops that are in the library but were not placed. */
  left: LoadedFile[];
  /** Why `left` is non-empty (null when it is empty). */
  leftReason: LeftReason | null;
  /** The host's message for `leftReason === 'host-error'`. */
  leftDetail?: string | null;
  /** Files the host could not import. */
  failedImports: FailedFile[];
  /** Files imported but not placed because their fit or track creation failed. */
  failedPlacements: FailedFile[];
}

export interface ToastSpec {
  type: 'info' | 'success' | 'warning' | 'error';
  title: string;
  message?: string;
}

export function emptyOutcome(picked: number): LoadOutcome {
  return { picked, added: [], left: [], leftReason: null, failedImports: [], failedPlacements: [] };
}

/** Last path segment; handles both POSIX and Windows separators. */
export function fileBaseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter((p: string) => p.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : filePath;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function itOrThem(n: number): string {
  return n === 1 ? 'it' : 'them';
}

/** 4 → "4", 3.25 → "3.25", 3.97 → "3.97". Quarter-bar values within 0.03 snap. */
export function formatBars(bars: number): string {
  const quarter = Math.round(bars * 4) / 4;
  const value = Math.abs(bars - quarter) < 0.03 ? quarter : Math.round(bars * 100) / 100;
  return String(value);
}

function formatBpm(bpm: number): string {
  return Number.isInteger(bpm) ? String(bpm) : String(Math.round(bpm * 10) / 10);
}

/**
 * "4 bars @ 94 BPM" from the library row of the SOURCE loop (before the fit),
 * so the message tells the user what they picked. Bars assume 4/4, like the
 * library's own duration_bars. Null when the library has no tempo.
 */
export function describeSourceLoop(
  sample: Pick<PluginSampleInfo, 'bpm' | 'durationSeconds'> | null | undefined,
): string | null {
  if (!sample || sample.bpm == null || !(sample.bpm > 0)) return null;
  const bpm = formatBpm(sample.bpm);
  if (sample.durationSeconds == null || !(sample.durationSeconds > 0)) return `@ ${bpm} BPM`;
  const bars = (sample.durationSeconds * sample.bpm) / 240;
  const label = formatBars(bars);
  return `${label} bar${label === '1' ? '' : 's'} @ ${bpm} BPM`;
}

/** The first state that stops any placement, or null when loops can be placed. */
export function placementBlocker(
  state: { activeSceneId: string | null; hasContract: boolean; isConnected: boolean; trackCount: number },
  maxTracks: number,
): PlacementBlocker | null {
  if (!state.activeSceneId) return 'no-scene';
  if (!state.hasContract) return 'no-contract';
  if (!state.isConnected) return 'not-connected';
  if (state.trackCount >= maxTracks) return 'track-limit';
  return null;
}

/** True when a thrown host error means the rest of the batch can't be placed either. */
export function isSceneWideError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && SCENE_WIDE_ERROR_CODES.has(code);
}

/**
 * The host's import error for one file. Hosts report `"<path>: <message>"`
 * per failed file; a message that names this path belongs to it. When there
 * is exactly one failure and one message, that message is its own. Otherwise
 * null (the summary falls back to a generic hint rather than misattribute).
 */
export function importErrorFor(filePath: string, errors: readonly string[], soleFailure: boolean): string | null {
  const prefix = `${filePath}: `;
  const own = errors.find((e: string) => e.startsWith(prefix));
  if (own) return own.slice(prefix.length);
  return soleFailure && errors.length === 1 ? errors[0] : null;
}

/** Short tag for the summary title: "2 left in library (track limit)". */
export function leftReasonTag(reason: LeftReason): string | null {
  switch (reason) {
    case 'no-scene': return 'no scene';
    case 'no-contract': return 'no contract';
    case 'not-connected': return 'not connected';
    case 'track-limit': return 'track limit';
    case 'scene-changed': return 'scene changed';
    case 'host-error': return 'not placed';
    case 'old-host': return null;
  }
}

/** What the user should do to place the loops that stayed in the library. */
export function leftReasonHint(
  reason: LeftReason,
  count: number,
  maxTracks: number,
  detail?: string | null,
): string {
  const place = `use ${LIBRARY_BUTTON_LABEL} to place ${itOrThem(count)}`;
  switch (reason) {
    case 'no-scene':
      return `No scene is selected: select a scene, then ${place}.`;
    case 'no-contract':
      return `This scene has no contract yet: generate one, then ${place}.`;
    case 'not-connected':
      return `Systems are not connected: ${place} once they reconnect.`;
    case 'track-limit':
      return `This scene is at the ${maxTracks}-track loop limit: delete a track, then ${place}.`;
    case 'scene-changed':
      return `The scene changed while loops were being added: ${place} in the scene you want.`;
    case 'host-error':
      return `${detail ? `${detail.replace(/\.$/, '')}. ` : ''}Fix that, then ${place}.`;
    case 'old-host':
      // Host older than SDK 3.18.0: import returns no ids, so nothing can be placed.
      return `Added to your library: ${place} (this app build can't place loops from disk directly yet).`;
  }
}

function firstFailureLine(outcome: LoadOutcome): string | null {
  const failure = outcome.failedImports[0] ?? outcome.failedPlacements[0];
  if (!failure) return null;
  const what = failure.error ?? 'check that it is a readable audio file (wav, mp3, aiff, flac, ogg)';
  return failure.name ? `${failure.name}: ${what}` : what;
}

/** One loop's line, D-010 style: "4 bars @ 94 BPM → added (already in library)". */
export function perLoopMessage(loop: Pick<PlacedLoop, 'detail' | 'duplicate'>): string {
  const head = loop.detail ? `${loop.detail} → added` : 'Added';
  return loop.duplicate ? `${head} (already in library)` : head;
}

/**
 * The one toast that closes a "From disk" batch. Never silent: every outcome,
 * including "nothing could be placed", produces a title that says what
 * happened and, when something was left or failed, a message that says why.
 */
export function summarizeLoad(outcome: LoadOutcome, maxTracks: number): ToastSpec {
  const nAdded = outcome.added.length;
  const nDupAdded = outcome.added.filter((l: PlacedLoop) => l.duplicate).length;
  const nLeft = outcome.left.length;
  const nFailed = outcome.failedImports.length + outcome.failedPlacements.length;
  const failureLine = firstFailureLine(outcome);
  const hint = nLeft > 0 && outcome.leftReason
    ? leftReasonHint(outcome.leftReason, nLeft, maxTracks, outcome.leftDetail)
    : null;
  const message = [hint, nFailed > 0 && failureLine ? `Failed: ${failureLine}` : null]
    .filter((s): s is string => !!s)
    .join(' ');

  // Exactly one loop, placed cleanly: the per-loop line IS the summary.
  if (nAdded === 1 && nLeft === 0 && nFailed === 0) {
    return { type: 'success', title: `Added ${outcome.added[0].name}`, message: perLoopMessage(outcome.added[0]) };
  }

  if (nAdded > 0) {
    const parts = [`Added ${plural(nAdded, 'loop')}`];
    if (nDupAdded > 0) parts.push(`${nDupAdded} already in library`);
    if (nLeft > 0 && outcome.leftReason) {
      const tag = leftReasonTag(outcome.leftReason);
      parts.push(`${nLeft} left in library${tag ? ` (${tag})` : ''}`);
    }
    if (nFailed > 0) parts.push(`${nFailed} failed`);
    return {
      type: nLeft > 0 || nFailed > 0 ? 'warning' : 'success',
      title: parts.join(' · '),
      ...(message ? { message } : {}),
    };
  }

  if (nLeft > 0) {
    // Imported (or already there) but nothing placed.
    const nNew = outcome.left.filter((l: LoadedFile) => !l.duplicate).length;
    const nDup = nLeft - nNew;
    const single = nLeft === 1 && outcome.left[0].name ? outcome.left[0].name : null;
    let title: string;
    if (nNew > 0) {
      title = single ? `Added ${single} to your library` : `Added ${plural(nNew, 'loop')} to your library`;
      if (nDup > 0) title += ` · ${nDup} already there`;
    } else {
      title = single ? `${single} is already in your library` : `${plural(nDup, 'loop')} already in your library`;
    }
    if (nFailed > 0) title += ` · ${nFailed} failed`;
    return {
      type: outcome.leftReason === 'old-host' && nFailed === 0 ? 'info' : 'warning',
      title,
      ...(message ? { message } : {}),
    };
  }

  // Nothing imported, nothing placed: every file failed.
  const onlyFailure = nFailed === 1 ? (outcome.failedImports[0] ?? outcome.failedPlacements[0]) : null;
  return {
    type: 'error',
    title: onlyFailure?.name ? `Couldn't add ${onlyFailure.name}` : `Couldn't add ${plural(nFailed, 'file')}`,
    message: onlyFailure
      ? (onlyFailure.error ?? 'Check that it is a readable audio file (wav, mp3, aiff, flac, ogg).')
      : (failureLine ?? 'Check that they are readable audio files (wav, mp3, aiff, flac, ogg).'),
  };
}
