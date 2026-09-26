/**
 * "Recently imported" in the + Library picker, and the "From disk" hand-off
 * when nothing could be placed (S-015 / D-011).
 *
 * Steve: "I imported EXB_90_SENSORY_MINIMAL_FLOW_94_000BPM.WAV, it worked,
 * but it was hard to find in my library ... a user who uploads a single file
 * most likely wants to use it imediately. can we maybe show a section in the
 * library like recently imported .. if infact something was recently
 * imported?"
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
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
}));

jest.mock('react-icons/gi', () => ({
  GiSoundWaves: () => <span data-testid="wave-icon" />,
}));

import { LoopsPanel } from '../LoopsPanel';
import { RECENT_HIGHLIGHT_MS } from '../recently-imported';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fn = (): jest.Mock<any> => jest.fn<any>();

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const STEVES_FILE = 'EXB_90_SENSORY_MINIMAL_FLOW_94_000BPM.WAV';

function base(p: string): string {
  return p.split('/').pop() ?? p;
}

function makeSample(id: string, filename: string, extra: Partial<PluginSampleInfo> = {}): PluginSampleInfo {
  return {
    id,
    filename,
    filePath: `/library/${filename}`,
    category: 'drums',
    bpm: 94,
    keyTonic: null,
    keyMode: null,
    durationSeconds: 10.213,
    fileSizeBytes: 1024,
    tags: null,
    ...extra,
  };
}

/** A library row the (SDK 3.18.0) host reports as a user import `agoMs` ago. */
function importedRow(id: string, agoMs: number, extra: Partial<PluginSampleInfo> = {}): PluginSampleInfo {
  return makeSample(id, `${id}.wav`, { origin: 'import', importedAt: new Date(Date.now() - agoMs).toISOString(), ...extra });
}

function makeHandle(id: string): PluginTrackHandle {
  return { id, name: id, dbId: `db-${id}` } as PluginTrackHandle;
}

interface LibraryOptions {
  /** Library rows before anything is imported. */
  initial?: PluginSampleInfo[];
  /** Host reports `origin` / `importedAt` (sas-app side of SDK 3.18.0). */
  hostFields?: boolean;
  /** Host returns per-file `samples` from importSamples (SDK 3.18.0). */
  withIds?: boolean;
  overrides?: Record<string, any>;
}

/**
 * A host backed by an in-memory library: importSamples adds rows (id
 * `lib:<file name>`), fitSampleToScene adds a host-derived copy with NO
 * origin (like the real host), getSamples lists them all.
 */
function makeLibraryHost({ initial = [], hostFields = false, withIds = true, overrides = {} }: LibraryOptions = {}): {
  host: PluginHost;
  library: PluginSampleInfo[];
} {
  const library: PluginSampleInfo[] = [...initial];
  const importSamples = fn().mockImplementation(async (paths: string[]): Promise<PluginSampleImportResult> => {
    const samples = paths.map((p: string) => {
      const id = `lib:${base(p)}`;
      const existing = library.find((s) => s.id === id);
      const fields = hostFields ? { origin: 'import' as const, importedAt: new Date().toISOString() } : {};
      if (existing) Object.assign(existing, hostFields ? { importedAt: fields.importedAt } : {});
      else library.push(makeSample(id, base(p), fields));
      return { id, sourcePath: p, duplicate: !!existing };
    });
    return { imported: paths.length, skipped: 0, errors: [], ...(withIds ? { samples } : {}) };
  });
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
    getSamples: fn().mockImplementation(async () => library.map((s) => ({ ...s }))),
    getSampleById: fn().mockImplementation(async (id: string) => library.find((s) => s.id === id) ?? null),
    importSamples,
    fitSampleToScene: fn().mockImplementation(async (id: string) => {
      const source = library.find((s) => s.id === id);
      const fitted = makeSample(`fit:${id}`, source?.filename ?? id, { bpm: 120, durationSeconds: 16 });
      if (!library.some((s) => s.id === fitted.id)) library.push(fitted);
      return fitted;
    }),
    createSampleTrack: fn().mockImplementation(async (id: string) => makeHandle(`track:${id}`)),
    deleteSampleTrack: fn().mockResolvedValue(undefined),
    previewSample: fn().mockResolvedValue(undefined),
    stopPreview: fn().mockResolvedValue(undefined),
    showToast: fn(),
    showOpenDialog: fn().mockResolvedValue(['/disk/a.wav']),
    ...overrides,
  };
  return { host: host as unknown as PluginHost, library };
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
  onSelectScene?: () => void;
  onOpenContract?: () => void;
  onExpandSelf?: () => void;
}

function Harness({ host, activeSceneId = 'scene-1', context = sceneContext, onSelectScene, onOpenContract, onExpandSelf }: HarnessProps): React.ReactElement {
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
        onSelectScene={onSelectScene}
        onOpenContract={onOpenContract}
        onExpandSelf={onExpandSelf}
      />
    </div>
  );
}

function toasts(host: PluginHost): any[][] {
  return (host.showToast as unknown as jest.Mock).mock.calls as any[][];
}

function lastToast(host: PluginHost): any[] {
  const calls = toasts(host);
  return calls[calls.length - 1];
}

async function openLibrary(): Promise<void> {
  const button = await screen.findByTestId('add-sample-button');
  await act(async () => { fireEvent.click(button); });
  await waitFor(() => expect(screen.queryByText('Loading samples...')).toBeNull());
}

async function clickFromDisk(): Promise<void> {
  const button = await screen.findByTestId('import-sample-button');
  await act(async () => { fireEvent.click(button); });
}

async function waitForIdle(host: PluginHost): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('import-sample-button').textContent).toBe('From disk');
    expect(toasts(host).length).toBeGreaterThan(0);
  });
}

/** Sample ids of the Recently imported rows, top to bottom. */
function recentIds(): string[] {
  return screen.queryAllByTestId('recent-import-item').map((el) => el.getAttribute('data-sample-id') ?? '');
}

function recentRow(id: string): HTMLElement {
  const row = screen.getAllByTestId('recent-import-item').find((el) => el.getAttribute('data-sample-id') === id);
  if (!row) throw new Error(`no recent row ${id}`);
  return row;
}

/** File names of the rows in the normal (BPM) groups below the section. */
function groupFilenames(): string[] {
  return [...screen.queryAllByTestId('sample-picker-item'), ...screen.queryAllByTestId('sample-picker-item-other')]
    .map((el) => el.querySelector('span.truncate')?.textContent ?? '');
}

describe('+ Library: the Recently imported section', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('is hidden when nothing was recently imported', async () => {
    const { host } = makeLibraryHost({
      initial: [
        makeSample('legacy', 'legacy.wav'),
        makeSample('pack', 'pack.wav', { origin: 'pack', importedAt: new Date().toISOString() }),
      ],
      hostFields: true,
    });
    render(<Harness host={host} />);
    await openLibrary();
    expect(screen.getByTestId('sample-picker')).toBeTruthy();
    expect(screen.queryByTestId('recently-imported-section')).toBeNull();
    expect(screen.queryByText('Recently imported')).toBeNull();
    expect(groupFilenames().sort()).toEqual(['legacy.wav', 'pack.wav']);
  });

  it("lists only 'import' rows (not pack, not absent-origin), newest first, capped at 10, within 7 days", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => importedRow(`imp${i + 1}`, (i + 1) * MINUTE));
    const { host } = makeLibraryHost({
      initial: [
        importedRow('eight-days-old', 8 * DAY),
        ...twelve.slice().reverse(), // library order is not the display order
        makeSample('pack', 'pack.wav', { origin: 'pack', importedAt: new Date().toISOString() }),
        makeSample('no-origin', 'no-origin.wav', { importedAt: new Date().toISOString() }),
      ],
      hostFields: true,
    });
    render(<Harness host={host} />);
    await openLibrary();

    const section = screen.getByTestId('recently-imported-section');
    expect(within(section).getByText('Recently imported')).toBeTruthy();
    expect(recentIds()).toEqual(Array.from({ length: 10 }, (_, i) => `imp${i + 1}`));
    // Everything else stays in the groups below, and nothing is listed twice.
    expect(groupFilenames().sort()).toEqual(['eight-days-old.wav', 'imp11.wav', 'imp12.wav', 'no-origin.wav', 'pack.wav']);
    // The section sits above the BPM groups.
    const firstGroupRow = screen.getAllByTestId('sample-picker-item-other')[0];
    expect(section.compareDocumentPosition(firstGroupRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Hover shows when it was imported.
    expect(recentRow('imp1').getAttribute('title')).toMatch(/^Imported /);
    // Host-reported imports from earlier sessions carry no "new" badge.
    expect(screen.queryByTestId('sample-new-badge')).toBeNull();
  });

  it('each row has the same Preview action as the rest of the list', async () => {
    const { host } = makeLibraryHost({ initial: [importedRow('mine', MINUTE)], hostFields: true });
    render(<Harness host={host} />);
    await openLibrary();
    await act(async () => { fireEvent.click(within(recentRow('mine')).getByTestId('sample-preview-button')); });
    expect(host.previewSample).toHaveBeenCalledWith('/library/mine.wav');
  });

  it('Add from the section fits the loop and places it on a new track', async () => {
    const onExpandSelf = fn();
    const { host } = makeLibraryHost({ initial: [importedRow('mine', MINUTE)], hostFields: true });
    render(<Harness host={host} onExpandSelf={onExpandSelf as unknown as () => void} />);
    await openLibrary();
    await act(async () => { fireEvent.click(within(recentRow('mine')).getByTestId('recent-import-add')); });

    await waitFor(() => expect(host.createSampleTrack).toHaveBeenCalledWith('fit:mine'));
    expect(host.fitSampleToScene).toHaveBeenCalledWith('mine');
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(1));
    expect(screen.queryByTestId('sample-picker')).toBeNull();
    expect(lastToast(host)).toEqual(['success', 'Sample fitted & added']);
  });

  it('search folds the recent rows into the normal results (section hidden, no duplicate rows)', async () => {
    const { host } = makeLibraryHost({
      initial: [
        importedRow('EXB_90_SENSORY', MINUTE),
        makeSample('kick', 'kick_120.wav', { bpm: 120 }),
        makeSample('sensory-pack', 'sensory_pad.wav', { origin: 'pack', bpm: 120 }),
      ],
      hostFields: true,
    });
    render(<Harness host={host} />);
    await openLibrary();
    expect(recentIds()).toEqual(['EXB_90_SENSORY']);
    expect(groupFilenames()).not.toContain('EXB_90_SENSORY.wav');

    const input = screen.getByTestId('sample-search-input');
    await act(async () => { fireEvent.change(input, { target: { value: 'sensory' } }); });
    expect(screen.queryByTestId('recently-imported-section')).toBeNull();
    expect(groupFilenames().sort()).toEqual(['EXB_90_SENSORY.wav', 'sensory_pad.wav']);
    expect(screen.getAllByText('EXB_90_SENSORY.wav')).toHaveLength(1);

    await act(async () => { fireEvent.change(input, { target: { value: 'nothing-like-this' } }); });
    expect(screen.getByText('No matching samples')).toBeTruthy();

    await act(async () => { fireEvent.change(input, { target: { value: '' } }); });
    expect(recentIds()).toEqual(['EXB_90_SENSORY']);
  });
});

describe('+ Library: this session\'s imports', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('host without origin/importedAt: the section is built from this session\'s imports; the single file is still placed at once', async () => {
    const { host } = makeLibraryHost({
      initial: [makeSample('old', 'old.wav')],
      hostFields: false,
      overrides: { showOpenDialog: fn().mockResolvedValue([`/Users/steve/Splice/${STEVES_FILE}`]) },
    });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitForIdle(host);

    // Placed immediately, one toast, and the picker is NOT opened (D-010 path unchanged).
    expect(host.createSampleTrack).toHaveBeenCalledTimes(1);
    expect(toasts(host)).toEqual([['success', `Added ${STEVES_FILE}`, '4 bars @ 94 BPM → added']]);
    expect(screen.queryByTestId('sample-picker')).toBeNull();

    await openLibrary();
    expect(recentIds()).toEqual([`lib:${STEVES_FILE}`]);
    expect(within(recentRow(`lib:${STEVES_FILE}`)).getByTestId('sample-new-badge').textContent).toBe('new');
    expect(recentRow(`lib:${STEVES_FILE}`).getAttribute('title')).toMatch(/^Imported /);
    // The host-made fitted copy is not an import.
    expect(recentIds()).not.toContain(`fit:lib:${STEVES_FILE}`);
  });

  it('the "new" badge marks only what this panel session imported', async () => {
    const { host } = makeLibraryHost({ initial: [importedRow('yesterday', DAY)], hostFields: true });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitForIdle(host);
    await openLibrary();

    expect(recentIds()).toEqual(['lib:a.wav', 'yesterday']);
    expect(within(recentRow('lib:a.wav')).queryByTestId('sample-new-badge')).not.toBeNull();
    expect(within(recentRow('yesterday')).queryByTestId('sample-new-badge')).toBeNull();

    // Searching keeps the badge on the folded row.
    await act(async () => { fireEvent.change(screen.getByTestId('sample-search-input'), { target: { value: 'a.wav' } }); });
    expect(screen.queryByTestId('recently-imported-section')).toBeNull();
    expect(screen.getAllByTestId('sample-new-badge')).toHaveLength(1);
  });
});

describe('"From disk" when nothing could be placed: open + Library on Recently imported', () => {
  beforeEach(() => { jest.clearAllMocks(); });
  afterEach(() => { jest.useRealTimers(); });

  it('no scene: opens the picker with the just-imported row highlighted; the toast says why', async () => {
    const onSelectScene = fn();
    const onExpandSelf = fn();
    const { host } = makeLibraryHost({
      initial: [makeSample('old', 'old.wav')],
      overrides: { showOpenDialog: fn().mockResolvedValue([`/disk/${STEVES_FILE}`]) },
    });
    render(<Harness host={host} activeSceneId={null} context={null}
      onSelectScene={onSelectScene as unknown as () => void} onExpandSelf={onExpandSelf as unknown as () => void} />);
    await clickFromDisk();
    await waitForIdle(host);

    const [type, title, message] = lastToast(host);
    expect(type).toBe('warning');
    expect(title).toBe(`Added ${STEVES_FILE} to your library`);
    expect(message).toMatch(/No scene is selected: select a scene, then use \+ Library to place it/);
    expect(onSelectScene).toHaveBeenCalled();
    expect(onExpandSelf).toHaveBeenCalled();

    await waitFor(() => expect(recentIds()).toEqual([`lib:${STEVES_FILE}`]));
    expect(screen.getByTestId('no-scene-placeholder-sample')).toBeTruthy();
    expect(recentRow(`lib:${STEVES_FILE}`).getAttribute('data-highlighted')).toBe('true');
    expect(within(recentRow(`lib:${STEVES_FILE}`)).getByTestId('sample-new-badge')).toBeTruthy();
    expect(host.createSampleTrack).not.toHaveBeenCalled();

    // Add without a scene: says so and opens the scene picker; nothing is placed.
    await act(async () => { fireEvent.click(within(recentRow(`lib:${STEVES_FILE}`)).getByTestId('recent-import-add')); });
    expect(lastToast(host)).toEqual(['warning', 'Select a scene', 'Loops are added to the selected scene.']);
    expect(onSelectScene).toHaveBeenCalledTimes(2);
    expect(host.createSampleTrack).not.toHaveBeenCalled();

    // The header button reads "Close" and closes it, even with no scene.
    const libraryButton = screen.getByTestId('add-sample-button');
    expect(libraryButton.textContent).toBe('Close');
    await act(async () => { fireEvent.click(libraryButton); });
    expect(screen.queryByTestId('sample-picker')).toBeNull();
  });

  it('then selecting a scene leaves the picker open, and Add places the loop', async () => {
    const { host } = makeLibraryHost({ overrides: { showOpenDialog: fn().mockResolvedValue(['/disk/a.wav']) } });
    const view = render(<Harness host={host} activeSceneId={null} context={null} />);
    await clickFromDisk();
    await waitForIdle(host);
    await waitFor(() => expect(recentIds()).toEqual(['lib:a.wav']));

    view.rerender(<Harness host={host} activeSceneId="scene-1" context={sceneContext} />);
    await waitFor(() => expect(screen.queryByTestId('no-scene-placeholder-sample')).toBeNull());
    await act(async () => { fireEvent.click(within(recentRow('lib:a.wav')).getByTestId('recent-import-add')); });
    await waitFor(() => expect(host.createSampleTrack).toHaveBeenCalledWith('fit:lib:a.wav'));
  });

  it('the highlight fades after RECENT_HIGHLIGHT_MS', async () => {
    jest.useFakeTimers();
    const { host } = makeLibraryHost({ overrides: { showOpenDialog: fn().mockResolvedValue(['/disk/a.wav']) } });
    render(<Harness host={host} activeSceneId={null} context={null} />);
    await clickFromDisk();
    await waitFor(() => expect(recentIds()).toEqual(['lib:a.wav']));
    expect(recentRow('lib:a.wav').getAttribute('data-highlighted')).toBe('true');

    await act(async () => { jest.advanceTimersByTime(RECENT_HIGHLIGHT_MS + 10); });
    expect(recentRow('lib:a.wav').getAttribute('data-highlighted')).toBeNull();
    expect(recentIds()).toEqual(['lib:a.wav']); // still listed, just not lit
  });

  it('track limit: opens the picker with every just-imported row highlighted', async () => {
    const existing: PluginSampleTrackInfo[] = Array.from({ length: 16 }, (_, i) => ({
      track: makeHandle(`t${i}`),
      sample: makeSample(`s${i}`, `s${i}.wav`),
      volume: 0.75,
      pan: 0,
    }));
    const { host } = makeLibraryHost({
      overrides: {
        getPluginSampleTracks: fn().mockResolvedValue(existing),
        showOpenDialog: fn().mockResolvedValue(['/disk/a.wav', '/disk/b.wav']),
      },
    });
    render(<Harness host={host} />);
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(16));
    await clickFromDisk();
    await waitForIdle(host);

    expect(host.createSampleTrack).not.toHaveBeenCalled();
    expect(lastToast(host)[2]).toMatch(/16-track loop limit/);
    await waitFor(() => expect(recentIds().sort()).toEqual(['lib:a.wav', 'lib:b.wav']));
    expect(recentIds().map((id) => recentRow(id).getAttribute('data-highlighted'))).toEqual(['true', 'true']);
  });

  it('a scene-wide stop on the first loop: opens the picker on the imported rows', async () => {
    const { host } = makeLibraryHost({
      overrides: {
        showOpenDialog: fn().mockResolvedValue(['/disk/a.wav', '/disk/b.wav', '/disk/c.wav']),
        createSampleTrack: fn().mockRejectedValue(
          Object.assign(new Error('Scene meter 7/8 is not supported by this plugin'), { code: 'TIME_SIGNATURE_UNSUPPORTED' }),
        ),
      },
    });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitForIdle(host);

    expect(lastToast(host)[2]).toMatch(/Scene meter 7\/8 is not supported/);
    await waitFor(() => expect(recentIds().sort()).toEqual(['lib:a.wav', 'lib:b.wav', 'lib:c.wav']));
    expect(recentIds().every((id) => recentRow(id).getAttribute('data-highlighted') === 'true')).toBe(true);
    expect(recentIds()).not.toContain('fit:lib:a.wav');
  });

  it('host without sample ids (no `samples`): opens the picker filtered to the file by name', async () => {
    const { host } = makeLibraryHost({
      initial: [makeSample('other', 'other.wav')],
      withIds: false,
      overrides: { showOpenDialog: fn().mockResolvedValue([`/disk/${STEVES_FILE}`]) },
    });
    render(<Harness host={host} />);
    await clickFromDisk();
    await waitForIdle(host);

    expect(lastToast(host)[0]).toBe('info');
    expect(lastToast(host)[2]).toMatch(/use \+ Library to place it/);
    await waitFor(() => expect(screen.getByTestId('sample-picker')).toBeTruthy());
    expect((screen.getByTestId('sample-search-input') as HTMLInputElement).value).toBe(STEVES_FILE);
    await waitFor(() => expect(groupFilenames()).toEqual([STEVES_FILE]));
  });

  it('no contract: opens the picker; Add asks for a contract instead of placing', async () => {
    const onOpenContract = fn();
    const { host } = makeLibraryHost();
    render(<Harness host={host} context={{ ...sceneContext, hasContract: false }} onOpenContract={onOpenContract as unknown as () => void} />);
    await clickFromDisk();
    await waitForIdle(host);
    await waitFor(() => expect(recentIds()).toEqual(['lib:a.wav']));
    expect(screen.getByTestId('no-contract-placeholder-sample')).toBeTruthy();

    await act(async () => { fireEvent.click(within(recentRow('lib:a.wav')).getByTestId('recent-import-add')); });
    expect(lastToast(host)[1]).toBe('Generate a contract first');
    expect(host.createSampleTrack).not.toHaveBeenCalled();
    expect(onOpenContract).toHaveBeenCalledTimes(2);
  });

  it('when some loops were placed, the picker stays closed', async () => {
    const existing: PluginSampleTrackInfo[] = Array.from({ length: 15 }, (_, i) => ({
      track: makeHandle(`t${i}`),
      sample: makeSample(`s${i}`, `s${i}.wav`),
      volume: 0.75,
      pan: 0,
    }));
    const { host } = makeLibraryHost({
      overrides: {
        getPluginSampleTracks: fn().mockResolvedValue(existing),
        showOpenDialog: fn().mockResolvedValue(['/disk/a.wav', '/disk/b.wav']),
      },
    });
    render(<Harness host={host} />);
    await waitFor(() => expect(screen.getAllByTestId('track-row')).toHaveLength(15));
    await clickFromDisk();
    await waitForIdle(host);

    expect(host.createSampleTrack).toHaveBeenCalledTimes(1);
    expect(lastToast(host)[1]).toBe('Added 1 loop · 1 left in library (track limit)');
    expect(screen.queryByTestId('sample-picker')).toBeNull();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
