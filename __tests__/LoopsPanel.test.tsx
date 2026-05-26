/**
 * Tests for LoopsPanel — Add button auto-expand and preview button.
 *
 * Coverage:
 * - Add button calls onExpandSelf when picker is closed (so the accordion opens)
 * - Add button does NOT call onExpandSelf when closing the picker
 * - Preview button calls host.previewSample on first click
 * - Clicking preview on the same sample again calls host.stopPreview
 * - Clicking preview on a different sample stops the previous and starts the new one
 * - Closing the picker stops any active preview
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { PluginHost, PluginTrackHandle, PluginSampleInfo } from '@signalsandsorcery/plugin-sdk';

// Mock the SDK package used by LoopsPanel — only the runtime exports.
jest.mock('@signalsandsorcery/plugin-sdk', () => ({
  TrackRow: () => <div data-testid="track-row" />,
  EMPTY_FX_DETAIL_STATE: {
    eq: { enabled: false, presetIndex: 0, dryWet: 1.0 },
    compressor: { enabled: false, presetIndex: 0, dryWet: 1.0 },
    chorus: { enabled: false, presetIndex: 0, dryWet: 1.0 },
    phaser: { enabled: false, presetIndex: 0, dryWet: 1.0 },
    delay: { enabled: false, presetIndex: 0, dryWet: 1.0 },
    reverb: { enabled: false, presetIndex: 0, dryWet: 1.0 },
  },
}));

jest.mock('react-icons/gi', () => ({
  GiSoundWaves: () => <span data-testid="wave-icon" />,
}));

import { LoopsPanel } from '../LoopsPanel';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeHandle(id: string, name: string): PluginTrackHandle {
  return { id, name, dbId: `db-${id}`, role: undefined, prompt: undefined };
}

function makeSample(id: string, filename: string, bpm: number | null = 120): PluginSampleInfo {
  return {
    id,
    filename,
    filePath: `/samples/${filename}`,
    bpm,
    keyTonic: null,
    keyMode: null,
    category: null,
    durationSeconds: 4,
    sizeBytes: 1024,
    importedAt: new Date().toISOString(),
  } as unknown as PluginSampleInfo;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const fn = (): jest.Mock<any> => jest.fn<any>();

function makeMockHost(overrides?: Record<string, any>): PluginHost {
  const base: Record<string, any> = {
    // Track ops
    createTrack: fn().mockResolvedValue(makeHandle('new', 'new')),
    deleteTrack: fn().mockResolvedValue(undefined),
    getPluginSampleTracks: fn().mockResolvedValue([]),
    getTrackInfo: fn().mockResolvedValue({
      id: 'track-1', name: 'sample-1', dbId: 'db-track-1',
      muted: false, soloed: false, volume: 0.75, pan: 0,
      plugins: [], hasMidi: false, hasAudio: true,
    }),
    setTrackMute: fn().mockResolvedValue(undefined),
    setTrackVolume: fn().mockResolvedValue(undefined),
    setTrackPan: fn().mockResolvedValue(undefined),
    setTrackSolo: fn().mockResolvedValue(undefined),
    setTrackName: fn().mockResolvedValue(undefined),
    getTrackFxState: fn().mockResolvedValue({
      eq: { enabled: false, presetIndex: 0, dryWet: 1.0 },
      compressor: { enabled: false, presetIndex: 0, dryWet: 1.0 },
      chorus: { enabled: false, presetIndex: 0, dryWet: 0.5 },
      phaser: { enabled: false, presetIndex: 0, dryWet: 0.5 },
      delay: { enabled: false, presetIndex: 0, dryWet: 0.3 },
      reverb: { enabled: false, presetIndex: 0, dryWet: 0.3 },
    }),
    toggleTrackFx: fn().mockResolvedValue(undefined),
    setTrackFxPreset: fn().mockResolvedValue({}),
    setTrackFxDryWet: fn().mockResolvedValue(undefined),

    // Listeners
    onTrackStateChange: fn().mockReturnValue(() => {}),
    onEngineReady: fn().mockReturnValue(() => {}),
    onSceneChange: fn().mockReturnValue(() => {}),

    // Sample-pack download (factory loop library) — the panel subscribes to
    // progress on mount and triggers the download when the library is empty.
    onSamplePackProgress: fn().mockReturnValue(() => {}),
    startSamplePackDownload: fn().mockResolvedValue({ success: true }),

    // Samples
    getSamples: fn().mockResolvedValue([
      makeSample('s1', 'kick.wav', 120),
      makeSample('s2', 'snare.wav', 120),
    ]),
    createSampleTrack: fn().mockResolvedValue(makeHandle('new-sample', 'new-sample')),
    deleteSampleTrack: fn().mockResolvedValue(undefined),
    importSamples: fn().mockResolvedValue({ imported: 0, errors: [] }),
    timeStretchSample: fn().mockImplementation((id: string) => Promise.resolve(makeSample(id, 'stretched.wav', 120))),

    // Preview (NEW)
    previewSample: fn().mockResolvedValue(undefined),
    stopPreview: fn().mockResolvedValue(undefined),

    // UX feedback
    showToast: fn(),
    setProgress: fn(),
    setStatusMessage: fn(),

    // Dialogs
    showOpenDialog: fn().mockResolvedValue(null),
  };

  return { ...base, ...overrides } as unknown as PluginHost;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const defaultSceneContext: any = {
  hasContract: true,
  contractPrompt: 'test prompt',
  genre: null,
  key: 'C',
  chords: [],
  bpm: 120,
  bars: 4,
  mode: 'major',
  timeSignature: '4/4',
};

interface RenderResult {
  host: PluginHost;
  onExpandSelf: jest.Mock;
}

/**
 * Test wrapper that captures the panel's header content (which is normally
 * rendered into the accordion header by the parent) and renders it inline
 * so it ends up in the DOM and tests can interact with it.
 */
function PanelHarness({ host, onExpandSelf }: {
  host: PluginHost;
  onExpandSelf: () => void;
}): React.ReactElement {
  const [headerContent, setHeaderContent] = React.useState<React.ReactNode>(null);
  return (
    <div>
      <div data-testid="header-host">{headerContent}</div>
      <LoopsPanel
        host={host}
        activeSceneId="scene-1"
        isAuthenticated={true}
        isConnected={true}
        sceneContext={defaultSceneContext}
        onExpandSelf={onExpandSelf}
        onHeaderContent={setHeaderContent}
      />
    </div>
  );
}

function renderPanel(overrides?: Record<string, any>): RenderResult {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const host = makeMockHost(overrides);
  const onExpandSelf = fn();
  /* eslint-enable @typescript-eslint/no-explicit-any */

  act(() => {
    render(
      <PanelHarness
        host={host}
        onExpandSelf={onExpandSelf as unknown as () => void}
      />
    );
  });

  return { host, onExpandSelf };
}

describe('LoopsPanel - Add button auto-expand', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls onExpandSelf when Add button is clicked while picker is closed', async () => {
    const { onExpandSelf } = renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('add-sample-button')).toBeTruthy();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId('add-sample-button'));
    });

    expect(onExpandSelf).toHaveBeenCalledTimes(1);
  });

  it('does NOT call onExpandSelf when Add button is clicked to CLOSE the picker', async () => {
    const { onExpandSelf } = renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('add-sample-button')).toBeTruthy();
    });

    // First click opens picker — calls onExpandSelf once
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-sample-button'));
    });
    expect(onExpandSelf).toHaveBeenCalledTimes(1);

    // Second click closes the picker — should NOT call onExpandSelf again
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-sample-button'));
    });
    expect(onExpandSelf).toHaveBeenCalledTimes(1);
  });
});

describe('LoopsPanel - Preview button', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls host.previewSample with file path when preview button is clicked', async () => {
    const { host } = renderPanel();

    // Open the picker so the sample list renders
    await waitFor(() => {
      expect(screen.getByTestId('add-sample-button')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-sample-button'));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('sample-preview-button').length).toBeGreaterThan(0);
    });

    const previewButtons = screen.getAllByTestId('sample-preview-button');
    await act(async () => {
      fireEvent.click(previewButtons[0]);
    });

    expect(host.previewSample).toHaveBeenCalledWith('/samples/kick.wav');
  });

  it('calls host.stopPreview when the same sample is clicked again', async () => {
    const { host } = renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('add-sample-button')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-sample-button'));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('sample-preview-button').length).toBeGreaterThan(0);
    });

    const previewButtons = screen.getAllByTestId('sample-preview-button');
    await act(async () => {
      fireEvent.click(previewButtons[0]);
    });
    await act(async () => {
      fireEvent.click(previewButtons[0]);
    });

    expect(host.stopPreview).toHaveBeenCalled();
  });

  it('switches preview when a different sample is clicked', async () => {
    const { host } = renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('add-sample-button')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-sample-button'));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('sample-preview-button').length).toBeGreaterThanOrEqual(2);
    });

    const previewButtons = screen.getAllByTestId('sample-preview-button');
    await act(async () => {
      fireEvent.click(previewButtons[0]);
    });
    await act(async () => {
      fireEvent.click(previewButtons[1]);
    });

    // First call started kick.wav
    expect(host.previewSample).toHaveBeenNthCalledWith(1, '/samples/kick.wav');
    // Second call started snare.wav (after stopping kick)
    expect(host.previewSample).toHaveBeenNthCalledWith(2, '/samples/snare.wav');
  });

  it('stops the preview when the picker is closed', async () => {
    const { host } = renderPanel();

    await waitFor(() => {
      expect(screen.getByTestId('add-sample-button')).toBeTruthy();
    });
    // Open picker
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-sample-button'));
    });
    await waitFor(() => {
      expect(screen.getAllByTestId('sample-preview-button').length).toBeGreaterThan(0);
    });

    // Start a preview
    const previewButtons = screen.getAllByTestId('sample-preview-button');
    await act(async () => {
      fireEvent.click(previewButtons[0]);
    });

    // Close picker
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-sample-button'));
    });

    expect(host.stopPreview).toHaveBeenCalled();
  });
});

describe('LoopsPanel - BPM-distance sort order', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('orders out-of-tolerance samples by closest BPM to the project BPM first', async () => {
    // Project BPM is 120 (defaultSceneContext). Samples at 50, 90, 80 all fall
    // outside the ±2 tolerance, so they land in the "other" bucket. Expected
    // render order: 90 (Δ30), 80 (Δ40), 50 (Δ70).
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const getSamples = jest.fn<any>().mockResolvedValue([
      makeSample('s-far', 'far.wav', 50),
      makeSample('s-near', 'near.wav', 90),
      makeSample('s-mid', 'mid.wav', 80),
    ]);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    renderPanel({ getSamples });

    await waitFor(() => {
      expect(screen.getByTestId('add-sample-button')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-sample-button'));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('sample-picker-item-other').length).toBe(3);
    });

    const items = screen.getAllByTestId('sample-picker-item-other');
    const order = items.map((el: HTMLElement): string => el.textContent ?? '');
    expect(order[0]).toContain('near.wav');
    expect(order[1]).toContain('mid.wav');
    expect(order[2]).toContain('far.wav');
  });

  it('places samples with null BPM after samples with known BPMs', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const getSamples = jest.fn<any>().mockResolvedValue([
      makeSample('s-null', 'unknown.wav', null),
      makeSample('s-known', 'known.wav', 90),
    ]);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    renderPanel({ getSamples });

    await waitFor(() => {
      expect(screen.getByTestId('add-sample-button')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-sample-button'));
    });

    await waitFor(() => {
      expect(screen.getAllByTestId('sample-picker-item-other').length).toBe(2);
    });

    const items = screen.getAllByTestId('sample-picker-item-other');
    expect(items[0].textContent).toContain('known.wav');
    expect(items[1].textContent).toContain('unknown.wav');
  });
});

describe('LoopsPanel - factory library download (host-driven, no back door)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the download prompt when the library is empty and calls host.startSamplePackDownload', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const startSamplePackDownload = fn().mockResolvedValue({ success: true });
    renderPanel({
      getSamples: fn().mockResolvedValue([]), // empty library → prompt shows
      startSamplePackDownload,
    } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const button = await screen.findByTestId('download-factory-library-text-button');
    expect(button.textContent).toMatch(/Download sample library/i);

    fireEvent.click(button);

    // Drives the HOST capability with the loop pack id — no window.electronAPI.
    await waitFor(() => {
      expect(startSamplePackDownload).toHaveBeenCalledWith('sas-loop-library');
    });
  });

  it('reflects host.onSamplePackProgress updates on the download button', async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    let emit: ((p: { status: string; progress: number; message?: string }) => void) | null = null;
    renderPanel({
      getSamples: fn().mockResolvedValue([]),
      onSamplePackProgress: fn().mockImplementation((_packId: string, cb: any) => {
        emit = cb;
        return () => {};
      }),
    } as any);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    await screen.findByTestId('download-factory-library-text-button');

    act(() => emit?.({ status: 'downloading', progress: 42 }));
    expect(screen.getByTestId('download-factory-library-text-button').textContent).toMatch(/42%/);

    // The host's 'installing' phase is where it imports samples into the library.
    act(() => emit?.({ status: 'installing', progress: 95 }));
    expect(screen.getByTestId('download-factory-library-text-button').textContent).toMatch(/Importing samples/i);
  });
});
