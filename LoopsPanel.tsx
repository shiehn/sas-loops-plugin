/**
 * LoopsPanel — UI for the @signalsandsorcery/loops plugin
 *
 * Renders the sample / loop track list with browse/import controls,
 * volume slider, mute/solo, and delete. Uses ONLY PluginHost
 * methods — no EngineContext, no window.electronAPI.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { GiSoundWaves } from 'react-icons/gi';
import type {
  PluginUIProps,
  PluginSampleInfo,
  PluginSampleTrackInfo,
  PluginTrackHandle,
  PluginTrackRuntimeState,
  PluginTrackFxDetailState,
  PluginFxCategoryDetailState,
  FxCategory,
  TrackFxDetailState,
} from '@signalsandsorcery/plugin-sdk';
import { TrackRow, EMPTY_FX_DETAIL_STATE } from '@signalsandsorcery/plugin-sdk';

// ============================================================================
// Constants
// ============================================================================

const MAX_TRACKS = 16;
const AUDIO_EXTENSIONS = ['wav', 'mp3', 'aiff', 'flac', 'ogg'];

// ============================================================================
// Types
// ============================================================================

/** Internal track state combining handle + sample metadata + runtime state */
interface SampleTrackState {
  handle: PluginTrackHandle;
  sample: PluginSampleInfo;
  runtimeState: PluginTrackRuntimeState;
  fxDetailState: TrackFxDetailState;
  fxDrawerOpen: boolean;
}

// ============================================================================
// LoopsPanel
// ============================================================================

export function LoopsPanel({
  host,
  activeSceneId,
  isConnected,
  onHeaderContent,
  onLoading,
  sceneContext,
  onSelectScene,
  onOpenContract,
  onExpandSelf,
}: PluginUIProps): React.ReactElement {
  const [tracks, setTracks] = useState<SampleTrackState[]>([]);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [samples, setSamples] = useState<PluginSampleInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingSamples, setIsLoadingSamples] = useState(false);
  const [stretchingIds, setStretchingIds] = useState<Set<string>>(new Set());

  // ─── Load tracks when scene changes ──────────────────────────────
  const loadTracks = useCallback(async (): Promise<void> => {
    if (!activeSceneId) {
      setTracks([]);
      return;
    }

    setIsLoadingTracks(true);
    try {
      const sampleTracks: PluginSampleTrackInfo[] = await host.getPluginSampleTracks();

      const trackStates: SampleTrackState[] = [];
      for (const st of sampleTracks) {
        // Get runtime state
        let runtimeState: PluginTrackRuntimeState = {
          id: st.track.id,
          muted: false,
          solo: false,
          volume: st.volume,
          pan: st.pan,
        };
        try {
          const info = await host.getTrackInfo(st.track.id);
          runtimeState = {
            id: st.track.id,
            muted: info.muted,
            solo: info.soloed,
            volume: info.volume,
            pan: info.pan,
          };
        } catch {
          // Use defaults from sampleTrack info
        }

        // Get FX state
        let fxDetailState: TrackFxDetailState = { ...EMPTY_FX_DETAIL_STATE };
        try {
          const fxState = await host.getTrackFxState(st.track.id);
          fxDetailState = pluginFxToToggleFx(fxState);
        } catch {
          // Use defaults
        }

        trackStates.push({
          handle: st.track,
          sample: st.sample,
          runtimeState,
          fxDetailState,
          fxDrawerOpen: false,
        });
      }
      setTracks(trackStates);
    } catch (error: unknown) {
      console.error('[LoopsPanel] Failed to load tracks:', error);
    } finally {
      setIsLoadingTracks(false);
    }
  }, [host, activeSceneId]);

  useEffect(() => {
    loadTracks();
  }, [loadTracks]);

  // ─── Re-adopt tracks after engine finishes loading ───────────────
  // The initial adoption may run before the full reload creates engine tracks.
  // onEngineReady fires after the synthetic projectLoaded event, when tracks exist.
  useEffect(() => {
    const unsub = host.onEngineReady(() => {
      loadTracks();
    });
    return unsub;
  }, [host, loadTracks]);

  // ─── Subscribe to real-time track state changes ──────────────────
  useEffect(() => {
    const unsub = host.onTrackStateChange(
      (trackId: string, state: PluginTrackRuntimeState) => {
        setTracks((prev: SampleTrackState[]) =>
          prev.map((t: SampleTrackState) =>
            t.handle.id === trackId ? { ...t, runtimeState: state } : t
          )
        );
      }
    );
    return unsub;
  }, [host]);

  // ─── Load samples when picker opens ──────────────────────────────
  const openPicker = useCallback(async (): Promise<void> => {
    setPickerOpen(true);
    setSearchQuery('');
    setIsLoadingSamples(true);
    // Auto-focus the search input after picker renders
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('[data-testid="sample-search-input"]');
      input?.focus();
    }, 50);
    try {
      const result: PluginSampleInfo[] = await host.getSamples();
      setSamples(result);
    } catch (error: unknown) {
      console.error('[LoopsPanel] Failed to load samples:', error);
      setSamples([]);
    } finally {
      setIsLoadingSamples(false);
    }
  }, [host]);

  const closePicker = useCallback((): void => {
    setPickerOpen(false);
    setSearchQuery('');
  }, []);

  // ─── Add sample track (auto-timestretches if BPM mismatch) ──────
  const handleAddSample = useCallback(async (sample: PluginSampleInfo): Promise<void> => {
    if (!activeSceneId) {
      host.showToast('warning', 'Select SCENE');
      return;
    }
    if (tracks.length >= MAX_TRACKS) {
      host.showToast('warning', 'Track limit reached');
      return;
    }

    try {
      // Auto-timestretch if sample BPM doesn't match the project BPM
      const targetBpm = sceneContext?.bpm ?? null;
      const needsStretch = targetBpm != null && sample.bpm != null
        && Math.abs(sample.bpm - targetBpm) > BPM_TOLERANCE;

      let sampleToLoad: PluginSampleInfo = sample;
      if (needsStretch && targetBpm != null) {
        setStretchingIds(prev => new Set(prev).add(sample.id));
        try {
          sampleToLoad = await host.timeStretchSample(sample.id, targetBpm);
        } finally {
          setStretchingIds(prev => { const next = new Set(prev); next.delete(sample.id); return next; });
        }
      }

      const handle: PluginTrackHandle = await host.createSampleTrack(sampleToLoad.id);
      const newTrack: SampleTrackState = {
        handle,
        sample: sampleToLoad,
        runtimeState: {
          id: handle.id,
          muted: false,
          solo: false,
          volume: 0.75,
          pan: 0,
        },
        fxDetailState: { ...EMPTY_FX_DETAIL_STATE },
        fxDrawerOpen: false,
      };
      setTracks((prev: SampleTrackState[]) => [...prev, newTrack]);
      closePicker();
      onExpandSelf?.();
      host.showToast('success', needsStretch ? 'Sample stretched & added' : 'Sample added');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      host.showToast('error', 'Failed to add sample', msg);
    }
  }, [host, activeSceneId, tracks.length, closePicker, sceneContext, onExpandSelf]);

  // ─── Import samples ──────────────────────────────────────────────
  const handleImport = useCallback(async (): Promise<void> => {
    try {
      const filePaths: string[] | null = await host.showOpenDialog({
        title: 'Import Samples',
        filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
        multiSelections: true,
      });

      if (!filePaths || filePaths.length === 0) return;

      const result = await host.importSamples(filePaths);
      if (result.imported > 0) {
        host.showToast('success', `Imported ${result.imported} sample(s)`);
        // Refresh sample list if picker is open
        if (pickerOpen) {
          const refreshed: PluginSampleInfo[] = await host.getSamples();
          setSamples(refreshed);
        }
      }
      if (result.errors.length > 0) {
        host.showToast('warning', `${result.errors.length} import error(s)`, result.errors[0]);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Import failed';
      host.showToast('error', 'Import failed', msg);
    }
  }, [host, pickerOpen]);

  // ─── Push header content (Add + Import buttons) to accordion header ─
  const needsContract = !sceneContext?.hasContract;
  useEffect(() => {
    if (!onHeaderContent) return;
    const disabled = needsContract || !isConnected || !activeSceneId || tracks.length >= MAX_TRACKS;
    onHeaderContent(
      <div className="flex gap-1">
        <button
          data-testid="import-sample-button"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            if (needsContract) { onOpenContract?.(); return; }
            handleImport();
          }}
          className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
            needsContract || !isConnected
              ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
              : 'bg-sas-panel-alt border-sas-border text-sas-muted hover:border-sas-accent hover:text-sas-accent'
          }`}
        >
          Import
        </button>
        <button
          data-testid="add-sample-button"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            if (needsContract) { onOpenContract?.(); return; }
            pickerOpen ? closePicker() : openPicker();
          }}
          className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
            disabled
              ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
              : pickerOpen
                ? 'bg-sas-accent border-sas-accent text-sas-bg'
                : 'bg-sas-accent/10 border-sas-accent/30 text-sas-accent hover:bg-sas-accent/20'
          }`}
        >
          {pickerOpen ? 'Close' : '+ Add'}
        </button>
      </div>
    );
    return () => { onHeaderContent(null); };
  }, [onHeaderContent, isConnected, activeSceneId, tracks.length, pickerOpen, openPicker, closePicker, handleImport, needsContract, onOpenContract]);

  // ─── Push loading state to accordion header ────────────────────────
  useEffect(() => {
    if (!onLoading) return;
    onLoading(isLoadingTracks);
    return () => { onLoading(false); };
  }, [onLoading, isLoadingTracks]);

  // ─── Delete track ─────────────────────────────────────────────────
  const handleDeleteTrack = useCallback(async (trackId: string): Promise<void> => {
    try {
      await host.deleteSampleTrack(trackId);
      setTracks((prev: SampleTrackState[]) =>
        prev.filter((t: SampleTrackState) => t.handle.id !== trackId)
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      host.showToast('error', 'Failed to delete track', msg);
    }
  }, [host]);

  // ─── Mute/Solo/Volume ────────────────────────────────────────────
  const handleMuteToggle = useCallback((trackId: string): void => {
    const track = tracks.find((t: SampleTrackState) => t.handle.id === trackId);
    if (!track) return;
    const newMuted = !track.runtimeState.muted;
    // Optimistic update
    setTracks((prev: SampleTrackState[]) =>
      prev.map((t: SampleTrackState) =>
        t.handle.id === trackId
          ? { ...t, runtimeState: { ...t.runtimeState, muted: newMuted } }
          : t
      )
    );
    host.setTrackMute(trackId, newMuted).catch(() => {
      // Rollback on failure
      setTracks((prev: SampleTrackState[]) =>
        prev.map((t: SampleTrackState) =>
          t.handle.id === trackId
            ? { ...t, runtimeState: { ...t.runtimeState, muted: !newMuted } }
            : t
        )
      );
    });
  }, [host, tracks]);

  const handleSoloToggle = useCallback((trackId: string): void => {
    const track = tracks.find((t: SampleTrackState) => t.handle.id === trackId);
    if (!track) return;
    const newSolo = !track.runtimeState.solo;
    // Optimistic update
    setTracks((prev: SampleTrackState[]) =>
      prev.map((t: SampleTrackState) =>
        t.handle.id === trackId
          ? { ...t, runtimeState: { ...t.runtimeState, solo: newSolo } }
          : t
      )
    );
    host.setTrackSolo(trackId, newSolo).catch(() => {
      // Rollback on failure
      setTracks((prev: SampleTrackState[]) =>
        prev.map((t: SampleTrackState) =>
          t.handle.id === trackId
            ? { ...t, runtimeState: { ...t.runtimeState, solo: !newSolo } }
            : t
        )
      );
    });
  }, [host, tracks]);

  const handleVolumeChange = useCallback((trackId: string, volume: number): void => {
    setTracks((prev: SampleTrackState[]) =>
      prev.map((t: SampleTrackState) =>
        t.handle.id === trackId
          ? { ...t, runtimeState: { ...t.runtimeState, volume } }
          : t
      )
    );
    host.setTrackVolume(trackId, volume).catch(() => {});
  }, [host]);

  const handlePanChange = useCallback((trackId: string, pan: number): void => {
    setTracks((prev: SampleTrackState[]) =>
      prev.map((t: SampleTrackState) =>
        t.handle.id === trackId
          ? { ...t, runtimeState: { ...t.runtimeState, pan } }
          : t
      )
    );
    host.setTrackPan(trackId, pan).catch(() => {});
  }, [host]);

  // ─── FX handlers ───────────────────────────────────────────────────
  const handleFxToggle = useCallback((trackId: string, category: FxCategory, enabled: boolean): void => {
    setTracks((prev: SampleTrackState[]) => prev.map((t: SampleTrackState) =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], enabled } } }
        : t
    ));
    host.toggleTrackFx(trackId, category, enabled).catch(() => {
      // Rollback on failure
      setTracks((prev: SampleTrackState[]) => prev.map((t: SampleTrackState) =>
        t.handle.id === trackId
          ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], enabled: !enabled } } }
          : t
      ));
    });
  }, [host]);

  const handleFxPresetChange = useCallback((trackId: string, category: FxCategory, presetIndex: number): void => {
    setTracks((prev: SampleTrackState[]) => prev.map((t: SampleTrackState) =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], presetIndex } } }
        : t
    ));
    host.setTrackFxPreset(trackId, category, presetIndex).then((result: { dryWet?: number }) => {
      if (result.dryWet !== undefined) {
        setTracks((prev: SampleTrackState[]) => prev.map((t: SampleTrackState) =>
          t.handle.id === trackId
            ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], dryWet: result.dryWet as number } } }
            : t
        ));
      }
    }).catch(() => {});
  }, [host]);

  const handleFxDryWetChange = useCallback((trackId: string, category: FxCategory, value: number): void => {
    setTracks((prev: SampleTrackState[]) => prev.map((t: SampleTrackState) =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], dryWet: value } } }
        : t
    ));
    host.setTrackFxDryWet(trackId, category, value).catch(() => {});
  }, [host]);

  const toggleFxDrawer = useCallback((trackId: string): void => {
    setTracks((prev: SampleTrackState[]) => prev.map((t: SampleTrackState) =>
      t.handle.id === trackId ? { ...t, fxDrawerOpen: !t.fxDrawerOpen } : t
    ));
    // Refresh FX state when opening drawer
    const track = tracks.find((t: SampleTrackState) => t.handle.id === trackId);
    if (track && !track.fxDrawerOpen) {
      host.getTrackFxState(trackId).then((fxState: PluginTrackFxDetailState) => {
        setTracks((prev: SampleTrackState[]) => prev.map((t: SampleTrackState) =>
          t.handle.id === trackId ? { ...t, fxDetailState: pluginFxToToggleFx(fxState) } : t
        ));
      }).catch(() => {});
    }
  }, [host, tracks]);

  // ─── Filtered samples for picker ─────────────────────────────────
  const BPM_TOLERANCE = 2;
  const projectBpm = sceneContext?.bpm ?? null;

  const searchFiltered: PluginSampleInfo[] = searchQuery.trim()
    ? samples.filter((s: PluginSampleInfo) =>
        s.filename.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : samples;

  const matchedSamples: PluginSampleInfo[] = projectBpm != null
    ? searchFiltered.filter((s: PluginSampleInfo) =>
        s.bpm != null && Math.abs(s.bpm - projectBpm) <= BPM_TOLERANCE
      )
    : searchFiltered;

  const otherSamples: PluginSampleInfo[] = projectBpm != null
    ? searchFiltered.filter((s: PluginSampleInfo) =>
        s.bpm == null || Math.abs(s.bpm - projectBpm) > BPM_TOLERANCE
      )
    : [];

  // ─── Render ──────────────────────────────────────────────────────

  // No scene selected
  if (!activeSceneId) {
    return (
      <div data-testid="no-scene-placeholder-sample" className="flex items-center justify-center py-8">
        <button
          onClick={() => onSelectScene?.()}
          className="text-sas-muted text-xs hover:text-sas-accent transition-colors underline underline-offset-2"
        >
          Select a Scene
        </button>
      </div>
    );
  }

  // Scene selected but no contract generated yet
  if (!sceneContext?.hasContract) {
    return (
      <div data-testid="no-contract-placeholder-sample" className="flex items-center justify-center py-8">
        <button
          onClick={() => onOpenContract?.()}
          className="text-sas-muted text-xs hover:text-sas-accent transition-colors underline underline-offset-2"
        >
          Generate a Contract
        </button>
      </div>
    );
  }

  return (
    <div data-testid="sample-section" className="p-2 space-y-2">
      {/* Inline sample picker */}
      {pickerOpen && (
        <div
          data-testid="sample-picker"
          className="border border-sas-border bg-sas-bg rounded-sm p-2 space-y-1"
        >
          <input
            type="text"
            data-testid="sample-search-input"
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
            placeholder="Search samples..."
            className="sas-input w-full px-2 py-1 text-xs"
          />
          <div className="max-h-[240px] overflow-y-auto space-y-0.5">
            {isLoadingSamples ? (
              <div className="text-sas-muted text-xs text-center py-4">Loading samples...</div>
            ) : matchedSamples.length === 0 && otherSamples.length === 0 ? (
              <div className="text-sas-muted text-xs text-center py-4">
                {searchQuery.trim() ? 'No matching samples' : 'No samples available'}
              </div>
            ) : (
              <>
                {/* BPM-matched section */}
                {matchedSamples.length > 0 && (
                  <>
                    {projectBpm != null && (
                      <div className="text-[10px] text-sas-accent uppercase tracking-wide px-2 pt-1 pb-0.5 font-medium">
                        Matching {projectBpm} BPM
                      </div>
                    )}
                    {matchedSamples.map((sample: PluginSampleInfo) => (
                      <button
                        key={sample.id}
                        data-testid="sample-picker-item"
                        onClick={() => handleAddSample(sample)}
                        className="w-full text-left px-2 py-1 rounded-sm text-xs hover:bg-sas-panel-alt transition-colors flex items-center gap-2"
                      >
                        <GiSoundWaves size={14} className="text-sas-accent flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-sas-text">{sample.filename}</div>
                          <div className="flex gap-1 text-[10px] text-sas-muted/60">
                            {sample.bpm != null && <span>{sample.bpm} BPM</span>}
                            {sample.keyTonic != null && (
                              <span>{sample.keyTonic}{sample.keyMode ? ` ${sample.keyMode}` : ''}</span>
                            )}
                          </div>
                        </div>
                        {sample.category && (
                          <span className="text-[10px] px-1 py-0.5 rounded bg-sas-accent/10 text-sas-accent flex-shrink-0">
                            {sample.category}
                          </span>
                        )}
                      </button>
                    ))}
                  </>
                )}

                {/* Other BPM section */}
                {otherSamples.length > 0 && (
                  <>
                    <div className="text-[10px] text-sas-muted/60 uppercase tracking-wide px-2 pt-2 pb-0.5 font-medium border-t border-sas-border mt-1">
                      Other BPM — will auto-stretch to {projectBpm}
                    </div>
                    {otherSamples.map((sample: PluginSampleInfo) => (
                      <button
                        key={sample.id}
                        data-testid="sample-picker-item-other"
                        onClick={() => handleAddSample(sample)}
                        disabled={stretchingIds.has(sample.id)}
                        className={`w-full text-left px-2 py-1 rounded-sm text-xs flex items-center gap-2 transition-colors ${
                          stretchingIds.has(sample.id)
                            ? 'cursor-wait opacity-60'
                            : 'hover:bg-sas-panel-alt'
                        }`}
                      >
                        <GiSoundWaves size={14} className="text-sas-muted/40 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-sas-muted">{sample.filename}</div>
                          <div className="flex gap-1 text-[10px] text-sas-muted/40">
                            {sample.bpm != null && <span>{sample.bpm} BPM</span>}
                            {sample.keyTonic != null && (
                              <span>{sample.keyTonic}{sample.keyMode ? ` ${sample.keyMode}` : ''}</span>
                            )}
                          </div>
                        </div>
                        {sample.category && (
                          <span className="text-[10px] px-1 py-0.5 rounded bg-sas-panel text-sas-muted/40 flex-shrink-0">
                            {sample.category}
                          </span>
                        )}
                        <span className="text-[10px] text-sas-accent flex-shrink-0">
                          {stretchingIds.has(sample.id) ? 'Stretching...' : `→ ${projectBpm}`}
                        </span>
                      </button>
                    ))}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Track list */}
      {isLoadingTracks ? (
        <div className="text-sas-muted text-xs text-center py-4">Loading tracks...</div>
      ) : (
        tracks.map((track: SampleTrackState) => (
          <TrackRow
            key={track.handle.id}
            track={{ id: track.handle.id, name: track.handle.name }}
            runtimeState={{
              muted: track.runtimeState.muted,
              solo: track.runtimeState.solo,
              volume: track.runtimeState.volume,
              pan: track.runtimeState.pan,
            }}
            fxDetailState={track.fxDetailState}
            fxDrawerOpen={track.fxDrawerOpen}
            onDelete={() => handleDeleteTrack(track.handle.id)}
            onMuteToggle={() => handleMuteToggle(track.handle.id)}
            onSoloToggle={() => handleSoloToggle(track.handle.id)}
            onVolumeChange={(vol: number) => handleVolumeChange(track.handle.id, vol)}
            onPanChange={(pan: number) => handlePanChange(track.handle.id, pan)}
            onFxToggle={(cat: FxCategory, enabled: boolean) => handleFxToggle(track.handle.id, cat, enabled)}
            onFxPresetChange={(cat: FxCategory, idx: number) => handleFxPresetChange(track.handle.id, cat, idx)}
            onFxDryWetChange={(cat: FxCategory, val: number) => handleFxDryWetChange(track.handle.id, cat, val)}
            onToggleFxDrawer={() => toggleFxDrawer(track.handle.id)}
            accentColor="#6AF2C5"
            contentSlot={
              <div className="flex items-center gap-1.5 px-2 py-1 min-w-0">
                <span className="text-xs text-sas-text truncate" title={track.sample.filename}>
                  {track.sample.filename}
                </span>
                {track.sample.category && (
                  <span className="text-[10px] px-1 py-0.5 rounded bg-sas-accent/10 text-sas-accent flex-shrink-0">
                    {track.sample.category}
                  </span>
                )}
                {track.sample.bpm != null && (
                  <span className="text-[10px] text-sas-muted/60 flex-shrink-0">{track.sample.bpm} BPM</span>
                )}
                {track.sample.keyTonic != null && (
                  <span className="text-[10px] text-sas-muted/60 flex-shrink-0">
                    {track.sample.keyTonic}{track.sample.keyMode ? ` ${track.sample.keyMode}` : ''}
                  </span>
                )}
              </div>
            }
          />
        ))
      )}
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

/** Convert SDK PluginTrackFxDetailState to the FxToggleBar's expected TrackFxDetailState */
function pluginFxToToggleFx(sdkState: PluginTrackFxDetailState): TrackFxDetailState {
  const result = { ...EMPTY_FX_DETAIL_STATE };
  for (const category of ['eq', 'compressor', 'chorus', 'phaser', 'delay', 'reverb'] as const) {
    const sdkCat = sdkState[category] as PluginFxCategoryDetailState | undefined;
    if (sdkCat) {
      result[category] = {
        enabled: sdkCat.enabled,
        presetIndex: sdkCat.presetIndex,
        dryWet: sdkCat.dryWet,
      };
    }
  }
  return result;
}

export default LoopsPanel;
