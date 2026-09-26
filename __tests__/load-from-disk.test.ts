/**
 * Pure helpers behind the "From disk" flow (S-015 / D-010): per-loop wording,
 * blocked-state detection, host-error pairing and the closing summary toast.
 */

import { describe, it, expect } from '@jest/globals';
import {
  describeSourceLoop,
  emptyOutcome,
  fileBaseName,
  formatBars,
  importErrorFor,
  isSceneWideError,
  leftReasonHint,
  perLoopMessage,
  placementBlocker,
  summarizeLoad,
  type LoadOutcome,
} from '../load-from-disk';

const MAX = 16;

function outcome(partial: Partial<LoadOutcome>): LoadOutcome {
  return { ...emptyOutcome(partial.picked ?? 1), ...partial };
}

describe('fileBaseName', () => {
  it('handles POSIX and Windows paths', () => {
    expect(fileBaseName('/Users/me/loops/kick_94.wav')).toBe('kick_94.wav');
    expect(fileBaseName('C:\\loops\\snare.wav')).toBe('snare.wav');
    expect(fileBaseName('bare.wav')).toBe('bare.wav');
  });
});

describe('describeSourceLoop / formatBars', () => {
  it('reads "4 bars @ 94 BPM" from the log case (94 BPM, 10.213 s)', () => {
    expect(describeSourceLoop({ bpm: 94, durationSeconds: 10.213 })).toBe('4 bars @ 94 BPM');
  });

  it('keeps fractional bar lengths and singular "bar"', () => {
    expect(describeSourceLoop({ bpm: 120, durationSeconds: 6.5 })).toBe('3.25 bars @ 120 BPM');
    expect(describeSourceLoop({ bpm: 120, durationSeconds: 2 })).toBe('1 bar @ 120 BPM');
  });

  it('falls back to tempo only, or null, when metadata is missing', () => {
    expect(describeSourceLoop({ bpm: 94, durationSeconds: null })).toBe('@ 94 BPM');
    expect(describeSourceLoop({ bpm: null, durationSeconds: 8 })).toBeNull();
    expect(describeSourceLoop(null)).toBeNull();
  });

  it('snaps near-quarter values and rounds the rest', () => {
    expect(formatBars(3.99)).toBe('4');
    expect(formatBars(3.87)).toBe('3.87');
  });
});

describe('placementBlocker', () => {
  const ok = { activeSceneId: 's1', hasContract: true, isConnected: true, trackCount: 0 };

  it('returns null when loops can be placed', () => {
    expect(placementBlocker(ok, MAX)).toBeNull();
  });

  it('names the first blocking state, in order', () => {
    expect(placementBlocker({ ...ok, activeSceneId: null, hasContract: false }, MAX)).toBe('no-scene');
    expect(placementBlocker({ ...ok, hasContract: false, isConnected: false }, MAX)).toBe('no-contract');
    expect(placementBlocker({ ...ok, isConnected: false }, MAX)).toBe('not-connected');
    expect(placementBlocker({ ...ok, trackCount: 16 }, MAX)).toBe('track-limit');
  });
});

describe('isSceneWideError', () => {
  it('matches on the structural code only', () => {
    expect(isSceneWideError({ code: 'TIME_SIGNATURE_UNSUPPORTED', message: 'x' })).toBe(true);
    expect(isSceneWideError({ code: 'TRACK_LIMIT_EXCEEDED' })).toBe(true);
    expect(isSceneWideError({ code: 'ENGINE_ERROR', message: 'track limit' })).toBe(false);
    expect(isSceneWideError(new Error('TRACK_LIMIT_EXCEEDED'))).toBe(false);
    expect(isSceneWideError(null)).toBe(false);
  });
});

describe('importErrorFor', () => {
  it('pairs a "<path>: <message>" error with its own file', () => {
    const errors = ['/a.wav: unreadable', '/b.wav: too long'];
    expect(importErrorFor('/b.wav', errors, false)).toBe('too long');
  });

  it('uses the only message for the only failure, and never guesses otherwise', () => {
    expect(importErrorFor('/a.wav', ['disk full'], true)).toBe('disk full');
    expect(importErrorFor('/a.wav', ['disk full'], false)).toBeNull();
    expect(importErrorFor('/a.wav', [], true)).toBeNull();
  });
});

describe('perLoopMessage', () => {
  it('follows D-010 ("4 bars @94 → added") and notes duplicates', () => {
    expect(perLoopMessage({ detail: '4 bars @ 94 BPM', duplicate: false })).toBe('4 bars @ 94 BPM → added');
    expect(perLoopMessage({ detail: '4 bars @ 94 BPM', duplicate: true })).toBe('4 bars @ 94 BPM → added (already in library)');
    expect(perLoopMessage({ detail: null, duplicate: false })).toBe('Added');
  });
});

describe('summarizeLoad', () => {
  it('one clean loop: the per-loop line is the summary', () => {
    const t = summarizeLoad(outcome({ added: [{ name: 'a.wav', duplicate: false, detail: '4 bars @ 94 BPM' }] }), MAX);
    expect(t).toEqual({ type: 'success', title: 'Added a.wav', message: '4 bars @ 94 BPM → added' });
  });

  it('the brief\'s mixed case: added · already in library · left (track limit)', () => {
    const t = summarizeLoad(outcome({
      picked: 5,
      added: [
        { name: 'a.wav', duplicate: false, detail: null },
        { name: 'b.wav', duplicate: true, detail: null },
        { name: 'c.wav', duplicate: false, detail: null },
      ],
      left: [{ name: 'd.wav', duplicate: false }, { name: 'e.wav', duplicate: false }],
      leftReason: 'track-limit',
    }), MAX);
    expect(t.type).toBe('warning');
    expect(t.title).toBe('Added 3 loops · 1 already in library · 2 left in library (track limit)');
    expect(t.message).toMatch(/16-track loop limit/);
    expect(t.message).toMatch(/\+ Library to place them/);
  });

  it('nothing placed because no scene: imported, and says to select a scene', () => {
    const t = summarizeLoad(outcome({ left: [{ name: 'a.wav', duplicate: false }], leftReason: 'no-scene' }), MAX);
    expect(t.type).toBe('warning');
    expect(t.title).toBe('Added a.wav to your library');
    expect(t.message).toMatch(/select a scene/i);
  });

  it('a duplicate that could not be placed says it was already there', () => {
    const t = summarizeLoad(outcome({ left: [{ name: 'a.wav', duplicate: true }], leftReason: 'no-contract' }), MAX);
    expect(t.title).toBe('a.wav is already in your library');
    expect(t.message).toMatch(/no contract/);
  });

  it('old host (no sample ids): an info toast pointing at + Library', () => {
    const t = summarizeLoad(outcome({ left: [{ name: 'a.wav', duplicate: false }], leftReason: 'old-host' }), MAX);
    expect(t.type).toBe('info');
    expect(t.message).toMatch(/^Added to your library: use \+ Library to place it/);
  });

  it('a scene-wide host error carries the host message', () => {
    const t = summarizeLoad(outcome({
      picked: 2,
      left: [{ name: 'a.wav', duplicate: false }, { name: 'b.wav', duplicate: false }],
      leftReason: 'host-error',
      leftDetail: 'Scene meter 7/8 is not supported.',
    }), MAX);
    expect(t.title).toBe('Added 2 loops to your library');
    expect(t.message).toBe('Scene meter 7/8 is not supported. Fix that, then use + Library to place them.');
  });

  it('failures are counted and the first one is named', () => {
    const t = summarizeLoad(outcome({
      picked: 3,
      added: [{ name: 'a.wav', duplicate: false, detail: null }, { name: 'b.wav', duplicate: false, detail: null }],
      failedPlacements: [{ name: 'c.wav', error: 'fit failed' }],
    }), MAX);
    expect(t.type).toBe('warning');
    expect(t.title).toBe('Added 2 loops · 1 failed');
    expect(t.message).toBe('Failed: c.wav: fit failed');
  });

  it('everything failed: an error toast, never silent', () => {
    const one = summarizeLoad(outcome({ failedImports: [{ name: 'a.txt', error: null }] }), MAX);
    expect(one.type).toBe('error');
    expect(one.title).toBe("Couldn't add a.txt");
    expect(one.message).toMatch(/readable audio file/);

    const many = summarizeLoad(outcome({
      picked: 2,
      failedImports: [{ name: 'a.wav', error: 'unreadable' }, { name: 'b.wav', error: null }],
    }), MAX);
    expect(many.title).toBe("Couldn't add 2 files");
    expect(many.message).toBe('a.wav: unreadable');
  });

  it('every left reason has a hint that names + Library', () => {
    for (const reason of ['no-scene', 'no-contract', 'not-connected', 'track-limit', 'scene-changed', 'host-error', 'old-host'] as const) {
      expect(leftReasonHint(reason, 1, MAX)).toMatch(/\+ Library/);
    }
  });
});
