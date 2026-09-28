/**
 * "From disk" (import-sample-button) flow, S-015 / D-010: pick files → each is
 * imported, fitted to the scene and put on a new track, in order, with a
 * message per loop and a closing summary. Blocked states import only and say
 * why; hosts older than SDK 3.18.0 (no `samples` in the import result) import
 * only and say how to place the loop. Nothing is silent.
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

jest.mock('@signalsandsorcery/plugin-sdk', () => ({
  TrackRow: () => <div data-testid="track-row" />,
  ImportTrackModal: () => null,
  TransitionDesigner: () => <div data-testid="transition-designer" />,
  CrossfadeTrackRow: () => <div data-testid="crossfade-row" />,
  FadeTrackRow: () => <div data-testid="fade-row" />,
  useTrackLevels: () => null,
  useAnySolo: () => false,
  parseCrossfadePairs: () => [],
  parseFades: () => [],
  buildCrossfadeVolumeCurves: () => ({ origin: [], target: [] }),
  buildFadeVolumeCurve: () => [],
  // S-027 scene bus strip: this suite runs as a host without the bus surface
  // (no strip, no bus reads); LoopsPanel.panelBus.test.tsx covers the strip.
  usePanelBus: () => ({ supported: false, bus: null }),
  PanelMasterStrip: () => null,
}));

jest.mock('react-icons/gi', () => ({
  GiSoundWaves: () => <span data-testid="wave-icon" />,
}));

import { LoopsPanel } from '../LoopsPanel';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fn = (): jest.Mock<any> => jest.fn<any>();

function base(p: string): string {
  return p.split('/').pop() ?? p;
}

function makeSample(id: string, filename: string, bpm: number | null = 94, durationSeconds: number | null = 10.213): PluginSampleInfo {
  return {
    id,
    filename,
    filePath: `/library/${filename}`,
    category: 'drums',
    bpm,
    keyTonic: null,
    keyMode: null,
    durationSeconds,
    fileSizeBytes: 1024,
    tags: null,
  };
}

function makeHandle(id: string): PluginTrackHandle {
  return { id, name: id, dbId: `db-${id}` } as PluginTrackHandle;
}

/** An SDK 3.18.0 host: one PluginImportedSample per resolved file, in input order. */
function importWithIds(duplicates: Set<string> = new Set(), unreadable: Set<string> = new Set()) {
  return fn().mockImplementation(async (paths: string[]): Promise<PluginSampleImportResult> => {
    const ok = paths.filter((p) => !unreadable.has(p));
    return {
      imported: ok.length,
      skipped: paths.length - ok.length,
      errors: [],
      samples: ok.map((p) => ({ id: `lib:${base(p)}`, sourcePath: p, duplicate: duplicates.has(p) })),
    };
  });
}

function makeHost(overrides?: Record<string, any>): PluginHost {
  const host: Record<string, any> = {
    getPluginSampleTracks: fn().mockResolvedValue([]),
    getTrackInfo: fn().mockResolvedValue({ muted: false, soloed: false, volume: 0.75, pan: 0 }),
    setTrackMute: fn().mockResolvedValue(undefined),
    setTrackSolo: fn().mockResolvedValue(undefined),
    setTrackVolume: fn().mockResolvedValue(undefined),
    setTrackPan: fn().mockResolvedValue(undefined),
    onTrackStateChange: fn().mockReturnValue(() => {}),
    onEngineReady: fn().mockReturnValue(() => {}),
    onSamplePackProgress: fn().mockReturnValue(() => {}),
    startSamplePackDownload: fn().mockResolvedValue({ success: true }),
    getSamples: fn().mockResolvedValue([makeSample('existing', 'existing.wav')]),
    getSampleById: fn().mockImplementation(async (id: string) => makeSample(id, id.replace(/^lib:/, ''))),
    importSamples: importWithIds(),
    fitSampleToScene: fn().mockImplementation(async (id: string) => makeSample(`fit:${id}`, id.replace(/^lib:/, ''), 120, 16)),
    createSampleTrack: fn().mockImplementation(async (id: string) => makeHandle(`track:${id}`)),
    deleteSampleTrack: fn().mockResolvedValue(undefined),
    previewSample: fn().mockResolvedValue(undefined),
    stopPreview: fn().mockResolvedValue(undefined),
    showToast: fn(),
    showOpenDialog: fn().mockResolvedValue(['/disk/a.wav', '/disk/b.wav', '/disk/c.wav']),
  };
  return { ...host, ...overrides } as unknown as PluginHost;
}

const sceneContext: any = {
  hasContract: true,
  contractPrompt: 'test',
  genre: null,
  key: 'C',
  chords: [],
  bpm: 120,
  bars: 8,
  mode: 'major',
  timeSignature: '4/4',
};

interface HarnessProps {
  host: PluginHost;
  activeSceneId?: string | null;
  context?: any;
  isConnected?: boolean;
  onSelectScene?: () => void;
  onOpenContract?: () => void;
  onExpandSelf?: () => void;
}

function Harness({ host, activeSceneId = 'scene-1', context = sceneContext, isConnected = true, onSelectScene, onOpenContract, onExpandSelf }: HarnessProps): React.ReactElement {
  const [header, setHeader] = React.useState<React.ReactNode>(null);
  return (
    <div>
      <div data-testid="header-host">{header}</div>
      <LoopsPanel
        host={host}
        activeSceneId={activeSceneId}
        isAuthenticated={true}
        isConnected={isConnected}
        sceneContext={context}
        onHeaderContent={setHeader}
        onSelectScene={onSelectScene}
        onOpenContract={onOpenContract}
        onExpandSelf={onExpandSelf}
      />
    </div>
  );
}

/** First argument of every call to a mocked host method. */
function firstArgs(method: unknown): unknown[] {
  return (method as jest.Mock).mock.calls.map((c: unknown[]) => c[0]);
}

function toasts(host: PluginHost): any[][] {
  return (host.showToast as unknown as jest.Mock).mock.calls as any[][];
}

function lastToast(host: PluginHost): any[] {
  const calls = toasts(host);
  return calls[calls.length - 1];
}

async function clickFromDisk(): Promise<void> {
  const button = await screen.findByTestId('import-sample-button');
  await act(async () => { fireEvent.click(button); });
}

/** Resolves once the batch's closing summary toast has fired (the button returns to idle). */
async function waitForIdle(host: PluginHost): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('import-sample-button').textContent).toBe('From disk');
    expect(toasts(host).length).toBeGreaterThan(0);
  });
}

describe('LoopsPanel "From disk": labels and tooltips', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('the three add flows name their source; test ids are unchanged', async () => {
    const host = makeHost({ listImportableTracks: fn().mockResolvedValue([]) });
    render(<Harness host={host} />);
    expect((await screen.findByTestId('import-from-scene-loops-button')).textContent).toBe('From scene');
    expect(screen.getByTestId('import-sample-button').textContent).toBe('From disk');
    expect(screen.getByTestId('import-sample-button').getAttribute('title')).toBe('Add loop files from disk to this scene');
    expect(screen.getByTestId('add-sample-button').textContent).toBe('+ Library');
    expect(screen.getByTestId('add-sample-button').getAttribute('title')).toMatch(/Browse your loop library/);
  });
});

describe('LoopsPanel "From disk": placing loops', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('imports, fits and adds each file as a track, in pick order', async () => {
    const onExpandSelf = fn();
    const host = makeHost();
    render(<Harness host={host} onExpandSelf={onExpandSelf as unknown as () => void} />);
    await clickFromDisk();
    await waitForIdle(host);

    // One import per file, in order.
    expect(firstArgs(host.importSamples)).toEqual([
      ['/disk/a.wav'], ['/disk/b.wav'], ['/disk/c.wav'],
    ]);
    // Each is fitted, then placed from its FITTED id, in order.
    expect(firstArgs(host.fitSampleToScene)).toEqual(['lib:a.wav', 'lib:b.wav', 'lib:c.wav']);
    expect(firstArgs(host.createSampleTrack)).toEqual([
      'fit:lib:a.wav', 'fit:lib:b.wav', 'fit:lib:c.wav',
    ]);
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(3));
    expect(onExpandSelf).toHaveBeenCalled();

    // Progress toast, one message per loop (D-010), then the summary.
    const all = toasts(host);
    expect(all[0]).toEqual(['info', 'Adding 3 loops from disk…', expect.stringMatching(/few seconds per loop/)]);
    expect(all).toContainEqual(['success', 'Added a.wav', '4 bars @ 94 BPM → added']);
    expect(all).toContainEqual(['success', 'Added c.wav', '4 bars @ 94 BPM → added']);
    expect(lastToast(host)).toEqual(['success', 'Added 3 loops', undefined]);
  });

  it('a single file gets one toast naming the loop', async () => {
    const host = makeHost({ showOpenDialog: fn().mockResolvedValue(['/Users/me/EXB_90_Sensory_94_000bpm.wav']) });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitForIdle(host);
    expect(host.createSampleTrack).toHaveBeenCalledTimes(1);
    expect(toasts(host)).toEqual([
      ['success', 'Added EXB_90_Sensory_94_000bpm.wav', '4 bars @ 94 BPM → added'],
    ]);
  });

  it('a file already in the library is simply added, and the message says so', async () => {
    const host = makeHost({ importSamples: importWithIds(new Set(['/disk/b.wav'])) });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitForIdle(host);
    expect(host.createSampleTrack).toHaveBeenCalledTimes(3);
    expect(toasts(host)).toContainEqual(['success', 'Added b.wav', '4 bars @ 94 BPM → added (already in library)']);
    expect(lastToast(host)).toEqual(['success', 'Added 3 loops · 1 already in library', undefined]);
  });

  it('stops at the track limit and leaves the rest in the library', async () => {
    const existing: PluginSampleTrackInfo[] = Array.from({ length: 15 }, (_, i) => ({
      track: makeHandle(`t${i}`),
      sample: makeSample(`s${i}`, `s${i}.wav`),
      volume: 0.75,
      pan: 0,
    }));
    const host = makeHost({ getPluginSampleTracks: fn().mockResolvedValue(existing) });
    render(<Harness host={host} />);
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(15));

    await clickFromDisk();
    await waitForIdle(host);

    expect(firstArgs(host.createSampleTrack)).toEqual(['fit:lib:a.wav']);
    // The two that didn't fit are still imported, in one call.
    expect(firstArgs(host.importSamples)).toEqual([
      ['/disk/a.wav'], ['/disk/b.wav', '/disk/c.wav'],
    ]);
    const [type, title, message] = lastToast(host);
    expect(type).toBe('warning');
    expect(title).toBe('Added 1 loop · 2 left in library (track limit)');
    expect(message).toMatch(/16-track loop limit: delete a track, then use \+ Library/);
  });

  it('keeps going after one file fails, and names the failure', async () => {
    const host = makeHost({
      fitSampleToScene: fn().mockImplementation(async (id: string) => {
        if (id === 'lib:b.wav') throw Object.assign(new Error('Bars-fit failed'), { code: 'ENGINE_ERROR' });
        return makeSample(`fit:${id}`, id, 120, 16);
      }),
      importSamples: importWithIds(new Set(), new Set(['/disk/c.wav'])),
      showOpenDialog: fn().mockResolvedValue(['/disk/a.wav', '/disk/b.wav', '/disk/c.wav', '/disk/d.wav']),
    });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitForIdle(host);

    expect(firstArgs(host.createSampleTrack)).toEqual(['fit:lib:a.wav', 'fit:lib:d.wav']);
    const [type, title, message] = lastToast(host);
    expect(type).toBe('warning');
    expect(title).toBe('Added 2 loops · 2 failed');
    expect(message).toMatch(/^Failed: c\.wav: check that it is a readable audio file/);
  });

  it('a scene-wide host error stops placing and imports the rest', async () => {
    const host = makeHost({
      createSampleTrack: fn().mockRejectedValue(
        Object.assign(new Error('Scene meter 7/8 is not supported by this plugin'), { code: 'TIME_SIGNATURE_UNSUPPORTED' }),
      ),
    });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitForIdle(host);

    expect(host.createSampleTrack).toHaveBeenCalledTimes(1);
    expect(firstArgs(host.importSamples)).toEqual([
      ['/disk/a.wav'], ['/disk/b.wav', '/disk/c.wav'],
    ]);
    const [type, title, message] = lastToast(host);
    expect(type).toBe('warning');
    expect(title).toBe('Added 3 loops to your library');
    expect(message).toBe('Scene meter 7/8 is not supported by this plugin. Fix that, then use + Library to place them.');
  });

  it('shows a busy state on the button while loops are being fitted', async () => {
    const gate: { release: (() => void) | null } = { release: null };
    const host = makeHost({
      showOpenDialog: fn().mockResolvedValue(['/disk/a.wav', '/disk/b.wav']),
      fitSampleToScene: fn().mockImplementation((id: string) => new Promise((resolve) => {
        gate.release = () => resolve(makeSample(`fit:${id}`, id, 120, 16));
      })),
    });
    render(<Harness host={host} />);
    await clickFromDisk();

    await waitFor(() => expect(host.fitSampleToScene).toHaveBeenCalledTimes(1));
    const button = screen.getByTestId('import-sample-button');
    expect(button.textContent).toBe('Adding 1/2…');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');

    // A second click while busy does nothing.
    await act(async () => { fireEvent.click(button); });
    expect(host.showOpenDialog).toHaveBeenCalledTimes(1);

    await act(async () => { gate.release?.(); });
    await waitFor(() => expect(host.fitSampleToScene).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('import-sample-button').textContent).toBe('Adding 2/2…');
    await act(async () => { gate.release?.(); });
    await waitForIdle(host);
    expect((screen.getByTestId('import-sample-button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('a cancelled dialog imports nothing and shows nothing', async () => {
    const host = makeHost({ showOpenDialog: fn().mockResolvedValue(null) });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitFor(() => expect(host.showOpenDialog).toHaveBeenCalled());
    expect(host.importSamples).not.toHaveBeenCalled();
    expect(host.showToast).not.toHaveBeenCalled();
  });
});

describe('LoopsPanel "From disk": blocked states import only and say why', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('no scene: imports, places nothing, says "select a scene" and opens the scene picker', async () => {
    const onSelectScene = fn();
    const host = makeHost({ showOpenDialog: fn().mockResolvedValue(['/disk/a.wav']) });
    render(<Harness host={host} activeSceneId={null} context={null} onSelectScene={onSelectScene as unknown as () => void} />);
    expect(screen.getByTestId('import-sample-button').getAttribute('title')).toMatch(/no scene is selected/);

    await clickFromDisk();
    await waitForIdle(host);

    expect(host.importSamples).toHaveBeenCalledWith(['/disk/a.wav']);
    expect(host.fitSampleToScene).not.toHaveBeenCalled();
    expect(host.createSampleTrack).not.toHaveBeenCalled();
    const [type, title, message] = lastToast(host);
    expect(type).toBe('warning');
    expect(title).toBe('Added a.wav to your library');
    expect(message).toMatch(/select a scene, then use \+ Library to place it/);
    expect(onSelectScene).toHaveBeenCalled();
  });

  it('no contract: imports, says why, and opens the contract', async () => {
    const onOpenContract = fn();
    const host = makeHost({ showOpenDialog: fn().mockResolvedValue(['/disk/a.wav']) });
    render(<Harness host={host} context={{ ...sceneContext, hasContract: false }} onOpenContract={onOpenContract as unknown as () => void} />);
    await clickFromDisk();
    await waitForIdle(host);

    expect(host.importSamples).toHaveBeenCalledTimes(1);
    expect(host.createSampleTrack).not.toHaveBeenCalled();
    expect(lastToast(host)[2]).toMatch(/no contract yet/);
    expect(onOpenContract).toHaveBeenCalled();
  });

  it('not connected: imports and says so', async () => {
    const host = makeHost({ showOpenDialog: fn().mockResolvedValue(['/disk/a.wav']) });
    render(<Harness host={host} isConnected={false} />);
    await clickFromDisk();
    await waitForIdle(host);
    expect(host.createSampleTrack).not.toHaveBeenCalled();
    expect(lastToast(host)[2]).toMatch(/Systems are not connected/);
  });

  it('host without sample ids (pre-3.18.0): import only, with a clear message', async () => {
    const host = makeHost({
      showOpenDialog: fn().mockResolvedValue(['/disk/a.wav']),
      importSamples: fn().mockResolvedValue({ imported: 1, skipped: 0, errors: [] }),
    });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitForIdle(host);

    expect(host.fitSampleToScene).not.toHaveBeenCalled();
    expect(host.createSampleTrack).not.toHaveBeenCalled();
    const [type, title, message] = lastToast(host);
    expect(type).toBe('info');
    expect(title).toBe('Added a.wav to your library');
    expect(message).toMatch(/^Added to your library: use \+ Library to place it/);
  });

  it('host without sample ids, several files: imports the rest in one call', async () => {
    const host = makeHost({
      importSamples: fn().mockImplementation(async (paths: string[]) => ({ imported: paths.length, skipped: 0, errors: [] })),
    });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitForIdle(host);
    expect(firstArgs(host.importSamples)).toEqual([
      ['/disk/a.wav'], ['/disk/b.wav', '/disk/c.wav'],
    ]);
    expect(host.createSampleTrack).not.toHaveBeenCalled();
    expect(lastToast(host)[1]).toBe('Added 3 loops to your library');
  });

  it('a file the host cannot import is reported with its own error', async () => {
    const host = makeHost({
      showOpenDialog: fn().mockResolvedValue(['/disk/notes.txt']),
      importSamples: fn().mockResolvedValue({ imported: 0, skipped: 0, errors: ['/disk/notes.txt: unsupported format'], samples: [] }),
    });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitForIdle(host);
    expect(lastToast(host)).toEqual(['error', "Couldn't add notes.txt", 'unsupported format']);
  });
});

describe('LoopsPanel "+ Library": blocked states say why', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('no scene: toast + opens the scene picker instead of the contract', async () => {
    const onSelectScene = fn();
    const onOpenContract = fn();
    const host = makeHost();
    render(<Harness host={host} activeSceneId={null} context={null}
      onSelectScene={onSelectScene as unknown as () => void} onOpenContract={onOpenContract as unknown as () => void} />);
    await act(async () => { fireEvent.click(await screen.findByTestId('add-sample-button')); });
    expect(host.showToast).toHaveBeenCalledWith('warning', 'Select a scene', expect.any(String));
    expect(onSelectScene).toHaveBeenCalled();
    expect(onOpenContract).not.toHaveBeenCalled();
  });

  it('no contract: toast + opens the contract', async () => {
    const onOpenContract = fn();
    const host = makeHost();
    render(<Harness host={host} context={{ ...sceneContext, hasContract: false }} onOpenContract={onOpenContract as unknown as () => void} />);
    await act(async () => { fireEvent.click(await screen.findByTestId('add-sample-button')); });
    expect(host.showToast).toHaveBeenCalledWith('info', 'Generate a contract first', expect.any(String));
    expect(onOpenContract).toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
