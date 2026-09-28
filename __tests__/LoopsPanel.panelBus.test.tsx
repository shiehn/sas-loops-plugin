/**
 * The loops panel's scene bus strip (S-027 S2, D-018 / D-020).
 *
 * Steve: "the sas-loops-plugin needs a plugin bus similar to drums such that a
 * compressor or any fx can be applied". His picks: "Fader + FX + Duck/WOB"
 * (loops are duck/WOB TARGETS, amount 0 = off, never a duck source).
 *
 * What the panel owns (the host routes; the SDK hook reads and coalesces):
 *   - mount `PanelMasterStrip` at the top of the track list, inside the
 *     hook's `meterVisibilityRef`, only when the host has the bus surface
 *     and the bus has been read;
 *   - pass the Duck (sidechain) and WOB (motion) clusters when the host has
 *     them, and never write either on its own (the host default is 0 = off);
 *   - call `notifyTracksChanged()` at the end of every non-stale track load
 *     and after every placed loop, never `reload()` (reload can overlap);
 *   - survive a runtime SDK older than 3.19.0 (no `notifyTracksChanged`).
 *
 * The SDK is stubbed wholesale (the sas-instrument-plugin recipe), so the
 * only React here is the panel's; the real hook's read coalescing is covered
 * by the SDK's own suites.
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type {
  PluginHost,
  PluginTrackHandle,
  PluginSampleInfo,
  PluginSampleImportResult,
  PluginSampleTrackInfo,
} from '@signalsandsorcery/plugin-sdk';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── SDK stub ───────────────────────────────────────────────────────────
// Swapped per test: what usePanelBus returns (stable across renders, like the
// real hook's callbacks). `mockUsePanelBusArgs` records the scene it was
// asked for on every render.
let mockPanelBus: Record<string, any> = {};
const mockUsePanelBusArgs: Array<{ host: unknown; sceneId: string | null }> = [];
// Every render of the strip, newest last.
const mockStripRenders: Array<Record<string, any>> = [];
// The latest ImportTrackModal props ("From scene").
const mockImportModal: { props: Record<string, any> | null } = { props: null };
let mockAnySolo = false;

jest.mock('@signalsandsorcery/plugin-sdk', () => ({
  TrackRow: () => <div data-testid="track-row" />,
  ImportTrackModal: (props: Record<string, any>) => {
    mockImportModal.props = props;
    return null;
  },
  TransitionDesigner: () => <div data-testid="transition-designer" />,
  CrossfadeTrackRow: () => <div data-testid="crossfade-row" />,
  FadeTrackRow: () => <div data-testid="fade-row" />,
  useTrackLevels: () => null,
  useAnySolo: () => mockAnySolo,
  parseCrossfadePairs: () => [],
  parseFades: () => [],
  buildCrossfadeVolumeCurves: () => ({ origin: [], target: [] }),
  buildFadeVolumeCurve: () => [],
  usePanelBus: (host: unknown, sceneId: string | null) => {
    mockUsePanelBusArgs.push({ host, sceneId });
    return mockPanelBus;
  },
  PanelMasterStrip: (props: Record<string, any>) => {
    mockStripRenders.push(props);
    return <div data-testid="panel-master-strip" />;
  },
}));

jest.mock('react-icons/gi', () => ({
  GiSoundWaves: () => <span data-testid="wave-icon" />,
}));

import { LoopsPanel } from '../LoopsPanel';

const fn = (): jest.Mock<any> => jest.fn<any>();

// ─── Fixtures ───────────────────────────────────────────────────────────

const NEUTRAL_BUS = { engaged: true, volume: 0, muted: false, soloed: false, fx: [] };
const SIDECHAIN_OFF = {
  engaged: false, amount: 0, presetId: 'classic', source: 'kicks', length: 'preset',
  kickTrackCount: 0, kickOnsetCount: 0,
};
const MOTION_OFF = {
  engaged: false, amount: 0, target: 'filter', mode: 'lfo', filter: 'lp', shape: 'sine', rateQn: 1,
  patternQn: [], phase01: 0, baseHz: 800, depthOct: 2, resonance01: 0.2,
  sweepFromHz: 200, sweepToHz: 8000, sweepCurve: 'exp',
};

/** What the hook returns on a host with the full bus surface (SDK 3.19.0). */
function makePanelBus(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    supported: true,
    bus: NEUTRAL_BUS,
    levels: null,
    meterVisibilityRef: fn(),
    availableFx: [],
    fxLoading: false,
    fxPickerOpen: false,
    setFxPickerOpen: fn(),
    refreshFx: fn(),
    reload: fn().mockResolvedValue(undefined),
    notifyTracksChanged: fn(),
    onVolumeChange: fn(),
    onMuteToggle: fn(),
    onSoloToggle: fn(),
    onAddFx: fn(),
    onRemoveFx: fn(),
    onToggleFxEnabled: fn(),
    onShowFxEditor: fn(),
    fxReorderSupported: true,
    onMoveFx: fn(),
    sidechain: SIDECHAIN_OFF,
    sidechainSupported: true,
    onSidechainAmountChange: fn(),
    onSidechainPresetChange: fn(),
    onSidechainSourceChange: fn(),
    onSidechainLengthChange: fn(),
    motion: MOTION_OFF,
    motionSupported: true,
    onMotionAmountChange: fn(),
    onMotionRateChange: fn(),
    onMotionShapeChange: fn(),
    onMotionTargetChange: fn(),
    ...overrides,
  };
}

/** A hook result from a host with no bus surface. */
function noBusSurface(): Record<string, any> {
  return makePanelBus({
    supported: false, bus: null, sidechain: null, sidechainSupported: false,
    motion: null, motionSupported: false, fxReorderSupported: false,
  });
}

function makeSample(id: string, filename: string, bpm: number | null = 120): PluginSampleInfo {
  return {
    id, filename, filePath: `/library/${filename}`, category: 'drums', bpm,
    keyTonic: null, keyMode: null, durationSeconds: 8, fileSizeBytes: 1024, tags: null,
  } as unknown as PluginSampleInfo;
}

function makeHandle(id: string): PluginTrackHandle {
  return { id, name: id, dbId: `db-${id}` } as PluginTrackHandle;
}

function makeSampleTrack(id: string): PluginSampleTrackInfo {
  return { track: makeHandle(id), sample: makeSample(`s-${id}`, `${id}.wav`), volume: 0.75, pan: 0 } as unknown as PluginSampleTrackInfo;
}

function makeHost(overrides?: Record<string, any>): PluginHost {
  const host: Record<string, any> = {
    getPluginSampleTracks: fn().mockResolvedValue([makeSampleTrack('loop-1')]),
    getTrackInfo: fn().mockResolvedValue({ muted: false, soloed: false, volume: 0.75, pan: 0 }),
    setTrackMute: fn().mockResolvedValue(undefined),
    setTrackSolo: fn().mockResolvedValue(undefined),
    setTrackVolume: fn().mockResolvedValue(undefined),
    setTrackPan: fn().mockResolvedValue(undefined),
    onTrackStateChange: fn().mockReturnValue(() => {}),
    onEngineReady: fn().mockReturnValue(() => {}),
    onSamplePackProgress: fn().mockReturnValue(() => {}),
    startSamplePackDownload: fn().mockResolvedValue({ success: true }),
    getSamples: fn().mockResolvedValue([makeSample('lib-a', 'loop-a.wav')]),
    getSampleById: fn().mockImplementation(async (id: string) => makeSample(id, `${id}.wav`)),
    importSamples: fn().mockImplementation(async (paths: string[]): Promise<PluginSampleImportResult> => ({
      imported: paths.length,
      skipped: 0,
      errors: [],
      samples: paths.map((p: string) => ({ id: `lib:${p.split('/').pop()}`, sourcePath: p, duplicate: false })),
    })),
    fitSampleToScene: fn().mockImplementation(async (id: string) => makeSample(`fit:${id}`, `${id}.wav`)),
    createSampleTrack: fn().mockImplementation(async (id: string) => makeHandle(`track:${id}`)),
    deleteSampleTrack: fn().mockResolvedValue(undefined),
    previewSample: fn().mockResolvedValue(undefined),
    stopPreview: fn().mockResolvedValue(undefined),
    showToast: fn(),
    showOpenDialog: fn().mockResolvedValue(['/disk/a.wav', '/disk/b.wav', '/disk/c.wav']),
    // The bus surface itself: the (stubbed) hook reads it, the panel never does.
    getPanelBusState: fn().mockResolvedValue(NEUTRAL_BUS),
    setPanelBusSidechain: fn().mockResolvedValue(undefined),
    setPanelBusMotion: fn().mockResolvedValue(undefined),
  };
  return { ...host, ...overrides } as unknown as PluginHost;
}

const sceneContext: any = {
  hasContract: true, contractPrompt: 'test', genre: null, key: 'C', chords: [],
  bpm: 120, bars: 8, mode: 'major', timeSignature: '4/4',
};

interface HarnessProps {
  host: PluginHost;
  activeSceneId?: string | null;
  context?: any;
}

function Harness({ host, activeSceneId = 'scene-1', context = sceneContext }: HarnessProps): React.ReactElement {
  const [header, setHeader] = React.useState<React.ReactNode>(null);
  return (
    <div>
      <div data-testid="header-host">{header}</div>
      <LoopsPanel
        host={host}
        activeSceneId={activeSceneId}
        isAuthenticated={true}
        isConnected={true}
        sceneContext={context}
        onHeaderContent={setHeader}
      />
    </div>
  );
}

function notifyCount(): number {
  return (mockPanelBus.notifyTracksChanged as jest.Mock).mock.calls.length;
}

function lastStrip(): Record<string, any> {
  return mockStripRenders[mockStripRenders.length - 1];
}

/** A promise the test resolves by hand. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Mount and wait for the first track load to land. */
async function mount(host: PluginHost, props: Partial<HarnessProps> = {}): Promise<ReturnType<typeof render>> {
  const utils = render(<Harness host={host} {...props} />);
  await waitFor(() => expect(host.getPluginSampleTracks).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText('Loading tracks...')).toBeNull());
  return utils;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPanelBus = makePanelBus();
  mockUsePanelBusArgs.length = 0;
  mockStripRenders.length = 0;
  mockImportModal.props = null;
  mockAnySolo = false;
});

// ─── The strip ──────────────────────────────────────────────────────────

describe('LoopsPanel scene bus strip: when it shows', () => {
  it('asks the hook for the active scene of this host', async () => {
    const host = makeHost();
    await mount(host);
    expect(mockUsePanelBusArgs.length).toBeGreaterThan(0);
    for (const call of mockUsePanelBusArgs) {
      expect(call.host).toBe(host);
      expect(call.sceneId).toBe('scene-1');
    }
  });

  it('renders the strip when the host has the bus surface and the bus is read', async () => {
    const host = makeHost();
    await mount(host);
    expect(screen.getByTestId('panel-master-strip')).toBeTruthy();
    expect(lastStrip().bus).toBe(NEUTRAL_BUS);
  });

  it('mounts it inside the meter-visibility ref (bus meters only stream while on screen)', async () => {
    const host = makeHost();
    await mount(host);
    const strip = screen.getByTestId('panel-master-strip');
    const refCalls = (mockPanelBus.meterVisibilityRef as jest.Mock).mock.calls;
    const attached = refCalls.map((c: unknown[]) => c[0]).filter((el: unknown) => el instanceof HTMLElement);
    expect(attached.length).toBeGreaterThan(0);
    expect(attached[attached.length - 1]).toBe(strip.parentElement);
  });

  it('sits at the top of the track list, above the loop rows', async () => {
    const host = makeHost();
    await mount(host);
    const strip = screen.getByTestId('panel-master-strip');
    const row = screen.getByTestId('track-row');
    // eslint-disable-next-line no-bitwise
    expect(strip.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is hidden on a host without the bus surface', async () => {
    mockPanelBus = noBusSurface();
    const host = makeHost({ getPanelBusState: undefined });
    await mount(host);
    expect(screen.getAllByTestId('track-row')).toHaveLength(1);
    expect(screen.queryByTestId('panel-master-strip')).toBeNull();
    expect(mockStripRenders).toHaveLength(0);
  });

  it('is hidden until the first bus read comes back', async () => {
    mockPanelBus = makePanelBus({ bus: null });
    const host = makeHost();
    await mount(host);
    expect(screen.queryByTestId('panel-master-strip')).toBeNull();
  });

  it('is absent under the no-scene and no-contract placeholders', async () => {
    const host = makeHost();
    const { rerender } = render(<Harness host={host} activeSceneId={null} />);
    expect(screen.getByTestId('no-scene-placeholder-sample')).toBeTruthy();
    expect(screen.queryByTestId('panel-master-strip')).toBeNull();
    rerender(<Harness host={host} context={{ ...sceneContext, hasContract: false }} />);
    expect(screen.getByTestId('no-contract-placeholder-sample')).toBeTruthy();
    expect(screen.queryByTestId('panel-master-strip')).toBeNull();
  });

  it('dims (soloedOut) when another track is soloed and the bus is not', async () => {
    mockAnySolo = true;
    const host = makeHost();
    await mount(host);
    expect(lastStrip().soloedOut).toBe(true);
  });

  it('is not dimmed when the bus itself is soloed', async () => {
    mockAnySolo = true;
    mockPanelBus = makePanelBus({ bus: { ...NEUTRAL_BUS, soloed: true } });
    const host = makeHost();
    await mount(host);
    expect(lastStrip().soloedOut).toBe(false);
  });

  it('wires the fader, mute, solo and FX chain to the hook, like the drum panel', async () => {
    const host = makeHost();
    await mount(host);
    const props = lastStrip();
    expect(props.onVolumeChange).toBe(mockPanelBus.onVolumeChange);
    expect(props.onMuteToggle).toBe(mockPanelBus.onMuteToggle);
    expect(props.onSoloToggle).toBe(mockPanelBus.onSoloToggle);
    expect(props.onAddFx).toBe(mockPanelBus.onAddFx);
    expect(props.onRemoveFx).toBe(mockPanelBus.onRemoveFx);
    expect(props.onToggleFxEnabled).toBe(mockPanelBus.onToggleFxEnabled);
    expect(props.onShowFxEditor).toBe(mockPanelBus.onShowFxEditor);
    expect(props.onToggleFxPicker).toBe(mockPanelBus.setFxPickerOpen);
    expect(props.onRefreshFx).toBe(mockPanelBus.refreshFx);
    expect(props.onMoveFx).toBe(mockPanelBus.onMoveFx);
  });

  it('offers no FX drag-reorder on a host without it', async () => {
    mockPanelBus = makePanelBus({ fxReorderSupported: false });
    const host = makeHost();
    await mount(host);
    expect(lastStrip().onMoveFx).toBeUndefined();
  });
});

// ─── Duck / WOB ─────────────────────────────────────────────────────────

describe('LoopsPanel scene bus strip: Duck and WOB (loops are targets, off until touched)', () => {
  it('passes both clusters and their controls, at the host default of amount 0', async () => {
    const host = makeHost();
    await mount(host);
    const props = lastStrip();
    expect(props.sidechain).toBe(SIDECHAIN_OFF);
    expect(props.sidechain.amount).toBe(0);
    expect(props.onSidechainAmountChange).toBe(mockPanelBus.onSidechainAmountChange);
    expect(props.onSidechainPresetChange).toBe(mockPanelBus.onSidechainPresetChange);
    expect(props.onSidechainSourceChange).toBe(mockPanelBus.onSidechainSourceChange);
    expect(props.onSidechainLengthChange).toBe(mockPanelBus.onSidechainLengthChange);
    expect(props.motion).toBe(MOTION_OFF);
    expect(props.motion.amount).toBe(0);
    expect(props.onMotionAmountChange).toBe(mockPanelBus.onMotionAmountChange);
    expect(props.onMotionRateChange).toBe(mockPanelBus.onMotionRateChange);
    expect(props.onMotionShapeChange).toBe(mockPanelBus.onMotionShapeChange);
    expect(props.onMotionTargetChange).toBe(mockPanelBus.onMotionTargetChange);
  });

  it('never writes Duck or WOB on its own (mount, a place, an engine-ready reload)', async () => {
    let engineReady: (() => void) | null = null;
    const host = makeHost({
      onEngineReady: fn().mockImplementation((cb: () => void) => { engineReady = cb; return () => {}; }),
    });
    await mount(host);
    // Place one loop from the library picker.
    fireEvent.click(screen.getByTestId('add-sample-button'));
    fireEvent.click((await screen.findByText('loop-a.wav')).closest('button') as HTMLElement);
    await waitFor(() => expect(host.createSampleTrack).toHaveBeenCalledTimes(1));
    await act(async () => { engineReady?.(); });
    await waitFor(() => expect(host.getPluginSampleTracks).toHaveBeenCalledTimes(2));

    expect(host.setPanelBusSidechain).not.toHaveBeenCalled();
    expect(host.setPanelBusMotion).not.toHaveBeenCalled();
    for (const handler of [
      'onSidechainAmountChange', 'onSidechainPresetChange', 'onSidechainSourceChange', 'onSidechainLengthChange',
      'onMotionAmountChange', 'onMotionRateChange', 'onMotionShapeChange', 'onMotionTargetChange',
      'onVolumeChange', 'onMuteToggle', 'onSoloToggle', 'onAddFx',
    ]) {
      expect(mockPanelBus[handler]).not.toHaveBeenCalled();
    }
    expect(lastStrip().sidechain.amount).toBe(0);
    expect(lastStrip().motion.amount).toBe(0);
  });

  it('hides both clusters on a host without the sidechain and motion surfaces', async () => {
    mockPanelBus = makePanelBus({ sidechainSupported: false, sidechain: null, motionSupported: false, motion: null });
    const host = makeHost();
    await mount(host);
    const props = lastStrip();
    expect(props.sidechain).toBeNull();
    expect(props.onSidechainAmountChange).toBeUndefined();
    expect(props.onSidechainPresetChange).toBeUndefined();
    expect(props.onSidechainSourceChange).toBeUndefined();
    expect(props.onSidechainLengthChange).toBeUndefined();
    expect(props.motion).toBeNull();
    expect(props.onMotionAmountChange).toBeUndefined();
    expect(props.onMotionRateChange).toBeUndefined();
    expect(props.onMotionShapeChange).toBeUndefined();
    expect(props.onMotionTargetChange).toBeUndefined();
  });
});

// ─── Re-reading the bus when the loop set changes ───────────────────────

describe('LoopsPanel scene bus: notifyTracksChanged after every loop-set change', () => {
  it('notifies once the mount track load lands, not before', async () => {
    const load = deferred<PluginSampleTrackInfo[]>();
    const host = makeHost({ getPluginSampleTracks: fn().mockReturnValue(load.promise) });
    render(<Harness host={host} />);
    await waitFor(() => expect(host.getPluginSampleTracks).toHaveBeenCalledTimes(1));
    expect(notifyCount()).toBe(0);
    await act(async () => { load.resolve([makeSampleTrack('loop-1')]); });
    await waitFor(() => expect(notifyCount()).toBe(1));
    expect(screen.getAllByTestId('track-row')).toHaveLength(1);
  });

  it('never calls reload() (it reads at once and can overlap)', async () => {
    let engineReady: (() => void) | null = null;
    const host = makeHost({
      onEngineReady: fn().mockImplementation((cb: () => void) => { engineReady = cb; return () => {}; }),
    });
    await mount(host);
    fireEvent.click(screen.getByTestId('add-sample-button'));
    fireEvent.click((await screen.findByText('loop-a.wav')).closest('button') as HTMLElement);
    await waitFor(() => expect(host.createSampleTrack).toHaveBeenCalledTimes(1));
    await act(async () => { engineReady?.(); });
    await waitFor(() => expect(host.getPluginSampleTracks).toHaveBeenCalledTimes(2));
    expect(mockPanelBus.reload).not.toHaveBeenCalled();
  });

  it('never reads the bus itself: the hook owns every getPanelBusState', async () => {
    const host = makeHost();
    await mount(host);
    fireEvent.click(screen.getByTestId('add-sample-button'));
    fireEvent.click((await screen.findByText('loop-a.wav')).closest('button') as HTMLElement);
    await waitFor(() => expect(host.createSampleTrack).toHaveBeenCalledTimes(1));
    expect(host.getPanelBusState).not.toHaveBeenCalled();
  });

  it('notifies after a loop is placed from the library picker', async () => {
    const host = makeHost();
    await mount(host);
    expect(notifyCount()).toBe(1);
    fireEvent.click(screen.getByTestId('add-sample-button'));
    fireEvent.click((await screen.findByText('loop-a.wav')).closest('button') as HTMLElement);
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(2));
    expect(notifyCount()).toBe(2);
    // The notify came after the track exists (the host routes on that read).
    const createdAt = (host.createSampleTrack as jest.Mock).mock.invocationCallOrder[0];
    const notifiedAt = (mockPanelBus.notifyTracksChanged as jest.Mock).mock.invocationCallOrder[1];
    expect(notifiedAt).toBeGreaterThan(createdAt);
  });

  it('notifies once per loop placed by "From disk"', async () => {
    const host = makeHost();
    await mount(host);
    expect(notifyCount()).toBe(1);
    await act(async () => { fireEvent.click(screen.getByTestId('import-sample-button')); });
    await waitFor(() => expect(screen.getByTestId('import-sample-button').textContent).toBe('From disk'));
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(4));
    expect(host.createSampleTrack).toHaveBeenCalledTimes(3);
    expect(notifyCount()).toBe(1 + 3);
  });

  it('does not notify when "From disk" places nothing (the loops only go to the library)', async () => {
    const host = makeHost();
    await mount(host, { context: { ...sceneContext } });
    const before = notifyCount();
    // Every placement fails with a per-loop error: nothing new joins the scene.
    (host.createSampleTrack as jest.Mock<any>).mockImplementation(async () => { throw new Error('boom'); });
    await act(async () => { fireEvent.click(screen.getByTestId('import-sample-button')); });
    await waitFor(() => expect((host.createSampleTrack as jest.Mock).mock.calls.length).toBe(3));
    await waitFor(() => expect(screen.getByTestId('import-sample-button').textContent).toBe('From disk'));
    expect(notifyCount()).toBe(before);
  });

  it('notifies after a "From scene" import (via the track reload)', async () => {
    const host = makeHost({ listImportableTracks: fn().mockResolvedValue([]) });
    await mount(host);
    expect(notifyCount()).toBe(1);
    (host.getPluginSampleTracks as jest.Mock<any>).mockResolvedValue([makeSampleTrack('loop-1'), makeSampleTrack('loop-2')]);
    expect(mockImportModal.props).not.toBeNull();
    await act(async () => { mockImportModal.props?.onImported(); });
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(2));
    expect(notifyCount()).toBe(2);
  });

  it('notifies after an engine-ready reload (reopen)', async () => {
    let engineReady: (() => void) | null = null;
    const host = makeHost({
      onEngineReady: fn().mockImplementation((cb: () => void) => { engineReady = cb; return () => {}; }),
    });
    await mount(host);
    expect(notifyCount()).toBe(1);
    await act(async () => { engineReady?.(); });
    await waitFor(() => expect(notifyCount()).toBe(2));
  });

  it('a stale load (scene switched mid-load) never notifies; the new scene\'s load does', async () => {
    const first = deferred<PluginSampleTrackInfo[]>();
    const second = deferred<PluginSampleTrackInfo[]>();
    const host = makeHost({
      getPluginSampleTracks: fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    });
    const { rerender } = render(<Harness host={host} activeSceneId="scene-1" />);
    await waitFor(() => expect(host.getPluginSampleTracks).toHaveBeenCalledTimes(1));
    rerender(<Harness host={host} activeSceneId="scene-2" />);
    await waitFor(() => expect(host.getPluginSampleTracks).toHaveBeenCalledTimes(2));

    await act(async () => { second.resolve([makeSampleTrack('scene-2-loop')]); });
    await waitFor(() => expect(notifyCount()).toBe(1));
    await act(async () => { first.resolve([makeSampleTrack('scene-1-loop')]); });
    await act(async () => { await Promise.resolve(); });
    expect(notifyCount()).toBe(1);
    expect(mockUsePanelBusArgs[mockUsePanelBusArgs.length - 1].sceneId).toBe('scene-2');
  });

  it('a failed track load does not notify', async () => {
    const host = makeHost({ getPluginSampleTracks: fn().mockRejectedValue(new Error('No project is bound')) });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    render(<Harness host={host} />);
    await waitFor(() => expect(host.getPluginSampleTracks).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByText('Loading tracks...')).toBeNull());
    expect(notifyCount()).toBe(0);
    spy.mockRestore();
  });

  it('no read storm: re-renders neither reload tracks nor re-notify', async () => {
    const host = makeHost();
    await mount(host);
    expect(host.getPluginSampleTracks).toHaveBeenCalledTimes(1);
    expect(notifyCount()).toBe(1);
    // Churn the panel: open/close the picker and type, which re-render it.
    fireEvent.click(screen.getByTestId('add-sample-button'));
    const search = await screen.findByTestId('sample-search-input');
    for (const q of ['l', 'lo', 'loo', 'loop']) fireEvent.change(search, { target: { value: q } });
    fireEvent.click(screen.getByTestId('add-sample-button'));
    await act(async () => { await Promise.resolve(); });
    expect(host.getPluginSampleTracks).toHaveBeenCalledTimes(1);
    expect(notifyCount()).toBe(1);
  });

  it('an older runtime SDK (no notifyTracksChanged) still places loops and shows the strip', async () => {
    const older = makePanelBus();
    delete older.notifyTracksChanged;
    mockPanelBus = older;
    const host = makeHost();
    await mount(host);
    expect(screen.getByTestId('panel-master-strip')).toBeTruthy();
    fireEvent.click(screen.getByTestId('add-sample-button'));
    fireEvent.click((await screen.findByText('loop-a.wav')).closest('button') as HTMLElement);
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(2));
    const toasts = (host.showToast as jest.Mock).mock.calls as any[][];
    expect(toasts).toContainEqual(['success', 'Sample fitted & added']);
    expect(mockPanelBus.reload).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
