/**
 * LoopsPanel — UI for the @signalsandsorcery/loops plugin
 *
 * Renders the sample track list with browse/import controls,
 * volume slider, mute/solo, and delete. Uses PluginHost methods
 * for all plugin-scoped operations.
 *
 * The empty-library state offers a one-click download of the factory loop
 * library (the `sas-loop-library` pack) through host.startSamplePackDownload /
 * host.onSamplePackProgress — the host downloads, extracts, and imports the
 * samples into the library, after which host.getSamples() returns them. No
 * window.electronAPI, no shared/constants import (W9 — no back doors).
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
import { TrackRow, type DrawerTab, useAnySolo, EMPTY_FX_DETAIL_STATE, ImportTrackModal, useTrackLevels, TransitionDesigner, CrossfadeTrackRow, FadeTrackRow, parseCrossfadePairs, parseFades, buildCrossfadeVolumeCurves, buildFadeVolumeCurve, type CrossfadeSlot, type CrossfadeSelection, type CrossfadeMeta, type CrossfadePairMeta, type FadeDirection, type FadeGesture, type FadeMeta, type FadeEntry, type FadeSelection } from '@signalsandsorcery/plugin-sdk';

// The factory loop/sample library ships as the `sas-loop-library` pack. The
// plugin only needs the packId — the HOST owns the download + the post-extract
// import into the sample library (host.startSamplePackDownload /
// onSamplePackProgress). Declared locally so the plugin doesn't import the
// app's shared/constants/sample-packs (W9 — no back doors).
const LOOP_LIBRARY_PACK_ID = 'sas-loop-library';

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
  // Unified drawer state. Loops support only the FX tab, so the strip is hidden
  // and the drawer renders FX directly (drawerTab is always 'fx').
  drawerOpen: boolean;
  drawerTab: DrawerTab;
}

/** A committed crossfade pair resolved against live sample tracks. */
interface ResolvedCrossfadePair extends CrossfadePairMeta {
  origin: SampleTrackState;
  target: SampleTrackState;
}
/** A committed fade resolved against its live sample track. */
interface ResolvedFade extends FadeEntry {
  track: SampleTrackState;
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
  // Cosmetic per-track peak meters. Poll while the panel is mounted + visible;
  // NOT gated on transport state (this app plays via decks/clip-launcher, so the
  // linear "is playing" flag is unreliable). Stopped tracks just read the floor.
  // The host coalesces the read so playback always wins over the GUI. Older
  // hosts (no getTrackLevels) degrade to no meter via the `supportsMeters` guard.
  const supportsMeters = typeof host.getTrackLevels === 'function';
  const trackLevels = useTrackLevels(host);

  const [tracks, setTracks] = useState<SampleTrackState[]>([]);
  // Cross-panel: dim non-soloed rows when ANY track (any panel) is soloed.
  const anySolo = useAnySolo(host);
  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [samples, setSamples] = useState<PluginSampleInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingSamples, setIsLoadingSamples] = useState(false);
  const [stretchingIds, setStretchingIds] = useState<Set<string>>(new Set());
  const [previewingSampleId, setPreviewingSampleId] = useState<string | null>(null);

  // ─── Factory sample library availability ───────────────────────────
  // `hasAnySamples` starts as null (unknown) and becomes true/false after
  // the first host.getSamples() query. The download prompt is shown only
  // when it is known to be false (no samples anywhere in the library).
  const [hasAnySamples, setHasAnySamples] = useState<boolean | null>(null);
  type FactoryDownloadStatus = 'idle' | 'downloading' | 'extracting' | 'importing' | 'error';
  const [factoryDownloadStatus, setFactoryDownloadStatus] = useState<FactoryDownloadStatus>('idle');
  const [factoryDownloadProgress, setFactoryDownloadProgress] = useState(0);

  // ─── Transition Designer (audio crossfade / fade in transition scenes) ───
  const [designerView, setDesignerView] = useState(false);
  const [transitionSourceTotal, setTransitionSourceTotal] = useState(0);
  const [crossfadePairsMeta, setCrossfadePairsMeta] = useState<CrossfadePairMeta[]>([]);
  const [fadesMeta, setFadesMeta] = useState<FadeEntry[]>([]);
  // Engine track ids whose fade curve was applied this session (re-applied on load;
  // the curve is NOT engine-persisted — recomputed from sliderPos/gesture).
  const appliedFadeAutomationRef = useRef<Set<string>>(new Set());
  const xfFromId = sceneContext?.transitionFromSceneId ?? null;
  const xfToId = sceneContext?.transitionToSceneId ?? null;
  const canCrossfade =
    sceneContext?.sceneType === 'transition' && !!xfFromId && !!xfToId && !!host.listSceneFamilyTracks;
  // Leaving a transition scene drops back to the Tracks view (the toggle is hidden).
  useEffect(() => { if (!canCrossfade) setDesignerView(false); }, [canCrossfade]);
  // Fetch the source-track total once per transition scene (stable denominator).
  useEffect(() => {
    if (!canCrossfade || !xfFromId || !xfToId || !host.listSceneFamilyTracks) {
      setTransitionSourceTotal(0);
      return;
    }
    let cancelled = false;
    void Promise.all([host.listSceneFamilyTracks(xfFromId), host.listSceneFamilyTracks(xfToId)])
      .then(([a, b]) => { if (!cancelled) setTransitionSourceTotal(a.length + b.length); })
      .catch(() => { if (!cancelled) setTransitionSourceTotal(0); });
    return () => { cancelled = true; };
  }, [canCrossfade, xfFromId, xfToId, host]);
  // Loops already turned into transitions: 2 sources per crossfade pair, 1 per fade.
  const transitionDone = crossfadePairsMeta.length * 2 + fadesMeta.length;

  // ─── Sample preview (one-shot audition through cue output) ───────
  // Reuses the dedicated preview SimpleLoopPlayer instance via the
  // PluginHost — no track/clip is created and loop-b is unaffected.
  const handlePreviewClick = useCallback(async (sample: PluginSampleInfo): Promise<void> => {
    if (previewingSampleId === sample.id) {
      // Toggle off — stop the active preview
      setPreviewingSampleId(null);
      try {
        await host.stopPreview();
      } catch (error: unknown) {
        // best-effort stop — never surfaces errors to the user
        console.warn('[LoopsPanel] stopPreview failed:', error);
      }
      return;
    }
    setPreviewingSampleId(sample.id);
    try {
      await host.previewSample(sample.filePath);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Preview failed';
      host.showToast('error', 'Preview failed', msg);
      setPreviewingSampleId(null);
    }
  }, [host, previewingSampleId]);

  // Stop any active preview when the picker closes or the component unmounts.
  useEffect(() => {
    if (!pickerOpen && previewingSampleId !== null) {
      setPreviewingSampleId(null);
      host.stopPreview().catch(() => { /* best-effort */ });
    }
  }, [pickerOpen, previewingSampleId, host]);

  useEffect(() => {
    return () => {
      // Component unmounting — make sure preview isn't left playing
      host.stopPreview().catch(() => { /* best-effort */ });
    };
  }, [host]);

  // ─── Load tracks when scene changes ──────────────────────────────
  // Stale-scene guard: `tracks` is keyed implicitly by activeSceneId, but
  // React keeps the prior scene's tracks until loadTracks finishes its
  // async fetch (DB query + per-track getTrackInfo + per-track
  // getTrackFxState — several hundred ms in practice). During that window
  // the new scene's panel renders the OLD scene's sample rows. Clear on
  // real scene transitions so the gap is empty, not stale.
  const tracksLoadedForSceneRef = useRef<string | null>(null);
  const loadTracks = useCallback(async (): Promise<void> => {
    // Snapshot the scene this load is for. If activeSceneId changes (or a
    // newer loadTracks starts) before the awaits finish, this load must
    // NOT call setTracks — otherwise the old scene's results overwrite the
    // new scene's panel state.
    const sceneAtStart = activeSceneId;
    if (!sceneAtStart) {
      setTracks([]);
      tracksLoadedForSceneRef.current = null;
      // No scene → not loading. Without this, a load that already set
      // isLoadingTracks=true and is then superseded by a flip to a null
      // activeSceneId (the platform's effectiveSceneId briefly returns null
      // while project.scenes repopulates during load) leaves the spinner
      // stuck on "Loading tracks..." forever.
      setIsLoadingTracks(false);
      return;
    }

    // Scene changed since the last load → clear immediately so the user
    // sees the new (empty) state, not the prior scene's tracks. Same-scene
    // refetches (onAfterAgentMutation, onEngineReady) leave the existing
    // rows up so they re-render in place.
    if (tracksLoadedForSceneRef.current !== sceneAtStart) {
      setTracks([]);
    }
    tracksLoadedForSceneRef.current = sceneAtStart;

    const isStale = (): boolean => tracksLoadedForSceneRef.current !== sceneAtStart;

    setIsLoadingTracks(true);
    try {
      const sampleTracks: PluginSampleTrackInfo[] = await host.getPluginSampleTracks();
      if (isStale()) return;

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
          drawerOpen: false,
          drawerTab: 'fx',
        });
      }
      if (isStale()) return;
      setTracks(trackStates);
      // Parse committed crossfade/fade metadata for the Transition Designer.
      if (host.getAllSceneData) {
        try {
          const sceneData = (await host.getAllSceneData(sceneAtStart)) as Record<string, unknown>;
          if (!isStale()) {
            setCrossfadePairsMeta(parseCrossfadePairs(sceneData));
            setFadesMeta(parseFades(sceneData));
          }
        } catch { /* best effort — transition meta is optional */ }
      }
    } catch (error: unknown) {
      console.error('[LoopsPanel] Failed to load tracks:', error);
    } finally {
      // Only clear the loading indicator if no newer loadTracks has taken
      // over — otherwise we'd race with the newer load's own loading state.
      if (tracksLoadedForSceneRef.current === sceneAtStart) {
        setIsLoadingTracks(false);
      }
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

  // ─── Re-adopt tracks after agent/CLI tool mutations ──────────────
  // Tools like add_sample_track or compose_scene may add sample tracks
  // via the HTTP API path, which bypasses host methods. Without this
  // listener the panel doesn't see the new tracks until the user manually
  // switches scenes. Debounced 500ms so tool bursts coalesce.
  useEffect(() => {
    if (typeof host.onAfterAgentMutation !== 'function') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = host.onAfterAgentMutation(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        loadTracks();
      }, 500);
    });
    return () => {
      unsub?.();
      if (timer) clearTimeout(timer);
    };
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

  // ─── Check whether any samples exist in the library ─────────────
  // Used to decide whether to show the factory-library download prompt
  // in the panel body. Cheap enough to re-run after import/download.
  const refreshHasAnySamples = useCallback(async (): Promise<void> => {
    try {
      const result: PluginSampleInfo[] = await host.getSamples();
      setHasAnySamples(result.length > 0);
    } catch (error: unknown) {
      console.warn('[LoopsPanel] Failed to probe sample library:', error);
      // Leave hasAnySamples as-is on error (don't show the prompt on transient failures)
    }
  }, [host]);

  useEffect(() => {
    refreshHasAnySamples();
  }, [refreshHasAnySamples]);

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
      setHasAnySamples(result.length > 0);
    } catch (error: unknown) {
      console.error('[LoopsPanel] Failed to load samples:', error);
      setSamples([]);
    } finally {
      setIsLoadingSamples(false);
    }
  }, [host]);

  // ─── Factory sample library download (mirrors ConnectionStatus) ──
  // Subscribe to download progress events so the text button can
  // reflect status while a download is in flight.
  useEffect(() => {
    const unsubscribe = host.onSamplePackProgress(
      LOOP_LIBRARY_PACK_ID,
      (update: { status: string; progress: number; message?: string }) => {
        switch (update.status) {
          case 'downloading':
            setFactoryDownloadStatus('downloading');
            setFactoryDownloadProgress(update.progress);
            break;
          case 'verifying':
          case 'extracting':
            setFactoryDownloadStatus('extracting');
            setFactoryDownloadProgress(update.progress);
            break;
          case 'installing':
            // The host analyzes + imports each sample into the library during
            // the 'installing' phase — surface it as "Importing samples…".
            setFactoryDownloadStatus('importing');
            setFactoryDownloadProgress(update.progress);
            break;
          case 'complete':
            setFactoryDownloadStatus('idle');
            setFactoryDownloadProgress(0);
            // Refresh to hide the prompt now that samples exist
            refreshHasAnySamples();
            break;
          case 'error':
            setFactoryDownloadStatus('error');
            break;
          default:
            break;
        }
      }
    );
    return unsubscribe;
  }, [host, refreshHasAnySamples]);

  const handleDownloadFactoryLibrary = useCallback(async (): Promise<void> => {
    if (factoryDownloadStatus !== 'idle' && factoryDownloadStatus !== 'error') return;
    try {
      setFactoryDownloadStatus('downloading');
      setFactoryDownloadProgress(0);
      const result = await host.startSamplePackDownload(LOOP_LIBRARY_PACK_ID);
      if (!result.success) {
        setFactoryDownloadStatus('error');
        host.showToast('error', 'Download failed', result.error || 'Unknown error');
      }
      // Success is handled by the progress subscription (sets status to 'idle' on 'complete')
    } catch (error: unknown) {
      console.error('[LoopsPanel] Factory download error:', error);
      setFactoryDownloadStatus('error');
      const msg = error instanceof Error ? error.message : 'Download failed';
      host.showToast('error', 'Download failed', msg);
    }
  }, [host, factoryDownloadStatus]);

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
      // Fit the sample to the active scene's (bpm, length_bars). This
      // composes time-stretch + chop/loop-stitch in a single host call
      // (see `fitSampleToScene` in the SDK). Was a plain time-stretch
      // before per-scene bar lengths shipped, which left 4-bar samples
      // overflowing 2-bar scenes / under-filling 8-bar scenes.
      const targetBpm = sceneContext?.bpm ?? null;
      const targetBars = sceneContext?.bars ?? null;
      const needsFit = targetBpm != null && targetBars != null && (
        (sample.bpm != null && Math.abs(sample.bpm - targetBpm) > 0) ||
        // Always fit when bars are available — the host may also need to
        // chop / loop-stitch even when BPM already matches.
        true
      );

      let sampleToLoad: PluginSampleInfo = sample;
      if (needsFit) {
        setStretchingIds(prev => new Set(prev).add(sample.id));
        try {
          sampleToLoad = await host.fitSampleToScene(sample.id);
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
        drawerOpen: false,
        drawerTab: 'fx',
      };
      setTracks((prev: SampleTrackState[]) => [...prev, newTrack]);
      closePicker();
      onExpandSelf?.();
      host.showToast('success', needsFit ? 'Sample fitted & added' : 'Sample added');
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
        // Any successful import means the library is no longer empty —
        // hide the factory-download prompt.
        setHasAnySamples(true);
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
      <div className="flex gap-1 items-center">
        {(!canCrossfade || !designerView) && host.listImportableTracks && (
          <button
            data-testid="import-from-scene-loops-button"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onExpandSelf?.();
              setImportOpen(true);
            }}
            disabled={!activeSceneId || needsContract}
            className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
              !activeSceneId || needsContract
                ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
                : 'bg-sas-panel-alt border-sas-border text-sas-muted hover:border-sas-accent hover:text-sas-accent'
            }`}
          >
            Import
          </button>
        )}
        {(!canCrossfade || !designerView) && (
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
            Load
          </button>
        )}
        {(!canCrossfade || !designerView) && (
          <button
            data-testid="add-sample-button"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              if (needsContract) { onOpenContract?.(); return; }
              if (pickerOpen) {
                closePicker();
              } else {
                openPicker();
                onExpandSelf?.();
              }
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
        )}
        {canCrossfade && (
          <button
            data-testid="loops-view-toggle"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              if (!designerView) {
                if (needsContract) { onOpenContract?.(); return; }
                onExpandSelf?.();
              }
              setDesignerView((v) => !v);
            }}
            disabled={!designerView && needsContract}
            title={designerView ? 'Back to the loop list' : 'Open the transition designer'}
            className="relative overflow-hidden px-2 py-0.5 text-[10px] font-medium rounded-sm border border-sas-accent/40 text-sas-accent transition-colors hover:border-sas-accent disabled:opacity-50"
          >
            {transitionSourceTotal > 0 && (
              <span
                className="absolute inset-y-0 left-0 bg-sas-accent/25"
                style={{ width: `${Math.min(100, (transitionDone / transitionSourceTotal) * 100)}%` }}
                aria-hidden
              />
            )}
            <span className="relative">
              ⇄ {designerView ? 'Transition' : 'Loops'}
              {transitionSourceTotal > 0 ? ` ${transitionDone}/${transitionSourceTotal}` : ''}
            </span>
          </button>
        )}
      </div>
    );
    return () => { onHeaderContent(null); };
  }, [onHeaderContent, isConnected, activeSceneId, tracks.length, pickerOpen, openPicker, closePicker, handleImport, needsContract, onOpenContract, host, designerView, canCrossfade, transitionDone, transitionSourceTotal, onExpandSelf]);

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
    setTracks((prev: SampleTrackState[]) => prev.map((t: SampleTrackState) => {
      if (t.handle.id !== trackId) return t;
      const onFx = t.drawerOpen && t.drawerTab === 'fx';
      return { ...t, drawerOpen: !onFx, drawerTab: 'fx' };
    }));
    // Refresh FX state when opening the FX tab
    const track = tracks.find((t: SampleTrackState) => t.handle.id === trackId);
    const wasOnFx = !!track && track.drawerOpen && track.drawerTab === 'fx';
    if (track && !wasOnFx) {
      host.getTrackFxState(trackId).then((fxState: PluginTrackFxDetailState) => {
        setTracks((prev: SampleTrackState[]) => prev.map((t: SampleTrackState) =>
          t.handle.id === trackId ? { ...t, fxDetailState: pluginFxToToggleFx(fxState) } : t
        ));
      }).catch(() => {});
    }
  }, [host, tracks]);

  // ─── Transition Designer handlers (audio crossfade / fade) ──────────
  const applyCrossfadeAutomation = useCallback(
    async (originTrackId: string, targetTrackId: string, bars: number, bpm: number, sliderPos: number): Promise<void> => {
      if (!host.setTrackVolumeAutomation) return;
      const curves = buildCrossfadeVolumeCurves(bars, bpm, sliderPos);
      await host.setTrackVolumeAutomation(originTrackId, curves.origin).catch(() => {});
      await host.setTrackVolumeAutomation(targetTrackId, curves.target).catch(() => {});
    }, [host]);
  const applyFadeAutomation = useCallback(
    async (trackId: string, direction: FadeDirection, bars: number, bpm: number, sliderPos: number, gesture: FadeGesture): Promise<void> => {
      if (!host.setTrackVolumeAutomation) return;
      const points = buildFadeVolumeCurve(bars, bpm, direction, sliderPos, gesture);
      await host.setTrackVolumeAutomation(trackId, points).catch(() => {});
    }, [host]);

  // Resolve a source loop → fit it to the transition scene → create a sample track
  // in the active (transition) scene. Returns the new handle + a caption label.
  const placeLoop = useCallback(async (sourceDbId: string): Promise<{ handle: PluginTrackHandle; label: string } | null> => {
    if (!host.getSampleTrackInfo) return null;
    const info = await host.getSampleTrackInfo(sourceDbId);
    if (!info) return null;
    let sampleId = info.sampleId;
    try { sampleId = (await host.fitSampleToScene(sampleId)).id; } catch { /* fit best-effort */ }
    const handle = await host.createSampleTrack(sampleId);
    return { handle, label: info.fileName ?? handle.name };
  }, [host]);

  const handleCreateCrossfade = useCallback(
    async (origin: CrossfadeSelection, target: CrossfadeSelection): Promise<void> => {
      const scene = activeSceneId;
      const fromSceneId = sceneContext?.transitionFromSceneId ?? '';
      const toSceneId = sceneContext?.transitionToSceneId ?? '';
      if (!scene) throw new Error('No active scene.');
      if (!isConnected) throw new Error('Systems not connected.');
      if (tracks.length + 2 > MAX_TRACKS) throw new Error('Not enough track slots for a crossfade.');
      const created: PluginTrackHandle[] = [];
      try {
        const mc = await host.getMusicalContext();
        // Audio crossfade: place loop A + loop B; A fades out, B fades in. No MIDI.
        const originPlaced = await placeLoop(origin.dbId);
        if (!originPlaced) throw new Error('Origin loop is no longer available.');
        created.push(originPlaced.handle);
        const targetPlaced = await placeLoop(target.dbId);
        if (!targetPlaced) throw new Error('Target loop is no longer available.');
        created.push(targetPlaced.handle);
        await applyCrossfadeAutomation(originPlaced.handle.id, targetPlaced.handle.id, mc.bars, mc.bpm, 0.5);
        const groupId = originPlaced.handle.dbId;
        const originMeta: CrossfadeMeta = {
          groupId, slot: 'origin', partnerDbId: targetPlaced.handle.dbId, sourceTrackDbId: origin.dbId,
          sourceSceneId: fromSceneId, sourceName: origin.name, soundLabel: originPlaced.label, sliderPos: 0.5,
        };
        const targetMeta: CrossfadeMeta = {
          groupId, slot: 'target', partnerDbId: originPlaced.handle.dbId, sourceTrackDbId: target.dbId,
          sourceSceneId: toSceneId, sourceName: target.name, soundLabel: targetPlaced.label, sliderPos: 0.5,
        };
        await host.setSceneData(scene, `track:${originPlaced.handle.dbId}:crossfade`, originMeta);
        await host.setSceneData(scene, `track:${targetPlaced.handle.dbId}:crossfade`, targetMeta);
        await loadTracks();
        host.showToast('success', 'Crossfade created', `${origin.name} → ${target.name}`);
      } catch (err: unknown) {
        for (const h of [...created].reverse()) { try { await host.deleteSampleTrack(h.id); } catch { /* best effort */ } }
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    [host, activeSceneId, isConnected, tracks.length, sceneContext, placeLoop, applyCrossfadeAutomation, loadTracks],
  );

  const handleCreateFade = useCallback(
    async (selection: FadeSelection, direction: FadeDirection, _gesture: FadeGesture): Promise<void> => {
      const scene = activeSceneId;
      const fromSceneId = sceneContext?.transitionFromSceneId ?? '';
      const toSceneId = sceneContext?.transitionToSceneId ?? '';
      if (!scene) throw new Error('No active scene.');
      if (!isConnected) throw new Error('Systems not connected.');
      if (tracks.length + 1 > MAX_TRACKS) throw new Error('Not enough track slots for a fade.');
      // Audio fades are always a level ramp — the MIDI 'build' gesture has no analog.
      const gesture: FadeGesture = 'volume';
      const sourceSceneId = direction === 'out' ? fromSceneId : toSceneId;
      const created: PluginTrackHandle[] = [];
      try {
        const mc = await host.getMusicalContext();
        const placed = await placeLoop(selection.dbId);
        if (!placed) throw new Error('Loop is no longer available.');
        created.push(placed.handle);
        await applyFadeAutomation(placed.handle.id, direction, mc.bars, mc.bpm, 0.5, gesture);
        appliedFadeAutomationRef.current.add(placed.handle.id);
        const meta: FadeMeta = {
          direction, gesture, sourceTrackDbId: selection.dbId, sourceSceneId,
          sourceName: selection.name, soundLabel: placed.label, sliderPos: 0.5,
        };
        await host.setSceneData(scene, `track:${placed.handle.dbId}:fade`, meta);
        await loadTracks();
        host.showToast('success', direction === 'in' ? 'Fade in created' : 'Fade out created', selection.name);
      } catch (err: unknown) {
        for (const h of [...created].reverse()) { try { await host.deleteSampleTrack(h.id); } catch { /* best effort */ } }
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    [host, activeSceneId, isConnected, tracks.length, sceneContext, placeLoop, applyFadeAutomation, loadTracks],
  );

  // Audio-only one-sided transition (stutter / chopped / delay). Stutter & chopped
  // RENDER a new WAV (renderSampleEffect); delay places the loop + a delay-throw FX.
  // All three ramp the loop in/out across the transition.
  const handleCreateAudioTransition = useCallback(
    async (selection: FadeSelection, direction: FadeDirection, effect: 'stutter' | 'chopped' | 'delay'): Promise<void> => {
      const scene = activeSceneId;
      const fromSceneId = sceneContext?.transitionFromSceneId ?? '';
      const toSceneId = sceneContext?.transitionToSceneId ?? '';
      if (!scene) throw new Error('No active scene.');
      if (!isConnected) throw new Error('Systems not connected.');
      if (tracks.length + 1 > MAX_TRACKS) throw new Error('Not enough track slots.');
      if (!host.getSampleTrackInfo) throw new Error('Audio transitions are unavailable on this host.');
      const sourceSceneId = direction === 'out' ? fromSceneId : toSceneId;
      const created: PluginTrackHandle[] = [];
      try {
        const mc = await host.getMusicalContext();
        const info = await host.getSampleTrackInfo(selection.dbId);
        if (!info) throw new Error('Loop is no longer available.');
        let sampleId = info.sampleId;
        // Stutter / chopped re-render the loop's audio offline into a new sample.
        if (effect === 'stutter' || effect === 'chopped') {
          if (!host.renderSampleEffect) throw new Error(`${effect} requires a newer host build.`);
          const rendered = await host.renderSampleEffect(sampleId, { effect, bars: mc.bars, bpm: mc.bpm });
          sampleId = rendered.id;
        }
        try { sampleId = (await host.fitSampleToScene(sampleId)).id; } catch { /* fit best-effort */ }
        const handle = await host.createSampleTrack(sampleId);
        created.push(handle);
        await applyFadeAutomation(handle.id, direction, mc.bars, mc.bpm, 0.5, 'volume');
        appliedFadeAutomationRef.current.add(handle.id);
        // Delay → add a delay-throw FX preset on top of the fade.
        if (effect === 'delay' && host.setTrackFxPreset) {
          try { await host.setTrackFxPreset(handle.id, 'delay' as FxCategory, 0); } catch { /* fx best-effort */ }
        }
        const meta: FadeMeta = {
          direction, gesture: 'volume', effect,
          sourceTrackDbId: selection.dbId, sourceSceneId,
          sourceName: selection.name, soundLabel: info.fileName ?? handle.name, sliderPos: 0.5,
        };
        await host.setSceneData(scene, `track:${handle.dbId}:fade`, meta);
        await loadTracks();
        host.showToast('success', `${effect} ${direction === 'out' ? 'out' : 'in'} created`, selection.name);
      } catch (err: unknown) {
        for (const h of [...created].reverse()) { try { await host.deleteSampleTrack(h.id); } catch { /* best effort */ } }
        throw err instanceof Error ? err : new Error(String(err));
      }
    },
    [host, activeSceneId, isConnected, tracks.length, sceneContext, applyFadeAutomation, loadTracks],
  );

  // Resolve committed pairs/fades against live tracks (only complete pairs group).
  const { resolvedCrossfadePairs, crossfadeMemberDbIds } = useMemo(() => {
    const byDbId = new Map(tracks.map((t) => [t.handle.dbId, t]));
    const pairs: ResolvedCrossfadePair[] = [];
    const members = new Set<string>();
    for (const p of crossfadePairsMeta) {
      const origin = byDbId.get(p.originDbId);
      const target = byDbId.get(p.targetDbId);
      if (origin && target) { pairs.push({ ...p, origin, target }); members.add(p.originDbId); members.add(p.targetDbId); }
    }
    return { resolvedCrossfadePairs: pairs, crossfadeMemberDbIds: members };
  }, [tracks, crossfadePairsMeta]);
  const { resolvedFades, fadeMemberDbIds } = useMemo(() => {
    const byDbId = new Map(tracks.map((t) => [t.handle.dbId, t]));
    const list: ResolvedFade[] = [];
    const members = new Set<string>();
    for (const f of fadesMeta) {
      const track = byDbId.get(f.dbId);
      if (track) { list.push({ ...f, track }); members.add(f.dbId); }
    }
    return { resolvedFades: list, fadeMemberDbIds: members };
  }, [tracks, fadesMeta]);

  // Re-apply each fade's volume curve on load (NOT engine-persisted).
  useEffect(() => {
    if (!host.setTrackVolumeAutomation || resolvedFades.length === 0) return;
    void (async () => {
      const mc = await host.getMusicalContext();
      for (const fade of resolvedFades) {
        const id = fade.track.handle.id;
        if (appliedFadeAutomationRef.current.has(id)) continue;
        appliedFadeAutomationRef.current.add(id);
        await applyFadeAutomation(id, fade.meta.direction, mc.bars, mc.bpm, fade.meta.sliderPos, fade.meta.gesture);
      }
    })();
  }, [host, resolvedFades, applyFadeAutomation]);

  const excludeSourceDbIds = useMemo(() => [
    ...crossfadePairsMeta.flatMap((p) => [p.originSourceDbId, p.targetSourceDbId]),
    ...fadesMeta.map((f) => f.meta.sourceTrackDbId),
  ], [crossfadePairsMeta, fadesMeta]);

  const handleCrossfadeDelete = useCallback(async (pair: ResolvedCrossfadePair): Promise<void> => {
    try {
      for (const member of [pair.origin, pair.target]) {
        await host.deleteSampleTrack(member.handle.id);
        if (activeSceneId) await host.deleteSceneData(activeSceneId, `track:${member.handle.dbId}:crossfade`);
      }
      setCrossfadePairsMeta((prev) => prev.filter((p) => p.groupId !== pair.groupId));
      setTracks((prev) => prev.filter((t) => t.handle.id !== pair.origin.handle.id && t.handle.id !== pair.target.handle.id));
      host.showToast('success', 'Crossfade removed');
    } catch (err: unknown) {
      host.showToast('error', 'Failed to delete crossfade', err instanceof Error ? err.message : String(err));
    }
  }, [host, activeSceneId]);
  const handleFadeDelete = useCallback(async (fade: ResolvedFade): Promise<void> => {
    try {
      await host.deleteSampleTrack(fade.track.handle.id);
      if (activeSceneId) await host.deleteSceneData(activeSceneId, `track:${fade.dbId}:fade`);
      setFadesMeta((prev) => prev.filter((f) => f.dbId !== fade.dbId));
      setTracks((prev) => prev.filter((t) => t.handle.id !== fade.track.handle.id));
      host.showToast('success', 'Fade removed');
    } catch (err: unknown) {
      host.showToast('error', 'Failed to delete fade', err instanceof Error ? err.message : String(err));
    }
  }, [host, activeSceneId]);

  // ─── Filtered samples for picker ─────────────────────────────────
  const BPM_TOLERANCE = 2;
  const projectBpm = sceneContext?.bpm ?? null;

  const searchFiltered: PluginSampleInfo[] = searchQuery.trim()
    ? samples.filter((s: PluginSampleInfo) =>
        s.filename.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : samples;

  const bpmDistance = (s: PluginSampleInfo): number =>
    s.bpm == null || projectBpm == null ? Number.POSITIVE_INFINITY : Math.abs(s.bpm - projectBpm);

  const matchedSamples: PluginSampleInfo[] = projectBpm != null
    ? searchFiltered
        .filter((s: PluginSampleInfo) =>
          s.bpm != null && Math.abs(s.bpm - projectBpm) <= BPM_TOLERANCE
        )
        .slice()
        .sort((a: PluginSampleInfo, b: PluginSampleInfo) => bpmDistance(a) - bpmDistance(b))
    : searchFiltered;

  const otherSamples: PluginSampleInfo[] = projectBpm != null
    ? searchFiltered
        .filter((s: PluginSampleInfo) =>
          s.bpm == null || Math.abs(s.bpm - projectBpm) > BPM_TOLERANCE
        )
        .slice()
        .sort((a: PluginSampleInfo, b: PluginSampleInfo) => bpmDistance(a) - bpmDistance(b))
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

  // ─── Factory library prompt (text button) ─────────────────────────
  // Only rendered when we KNOW the library is empty (hasAnySamples === false).
  // Hidden while the check is still in-flight (null) or the library has any
  // samples — so once the factory library or a user import is present, the
  // prompt disappears automatically.
  const showFactoryDownloadPrompt = hasAnySamples === false;
  const isFactoryDownloadBusy =
    factoryDownloadStatus === 'downloading' ||
    factoryDownloadStatus === 'extracting' ||
    factoryDownloadStatus === 'importing';
  const factoryButtonLabel: string = (() => {
    switch (factoryDownloadStatus) {
      case 'downloading':
        return `Downloading sample library… ${factoryDownloadProgress}%`;
      case 'extracting':
        return 'Extracting sample library…';
      case 'importing':
        return 'Importing samples…';
      case 'error':
        return 'Retry download';
      default:
        return 'Download sample library';
    }
  })();

  return (
    <div data-testid="sample-section" className="p-2 space-y-2">
      {host.listImportableTracks && (
        <ImportTrackModal
          host={host}
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onImported={() => { void loadTracks(); }}
          testIdPrefix="loops-import"
        />
      )}

      {/* Factory sample library download prompt — only when library is empty */}
      {showFactoryDownloadPrompt && (
        <div
          data-testid="factory-library-download-prompt"
          className="flex items-center justify-center py-2"
        >
          <button
            type="button"
            data-testid="download-factory-library-text-button"
            onClick={handleDownloadFactoryLibrary}
            disabled={isFactoryDownloadBusy}
            className={`text-xs transition-colors underline underline-offset-2 ${
              isFactoryDownloadBusy
                ? 'text-sas-accent cursor-wait'
                : factoryDownloadStatus === 'error'
                  ? 'text-red-400 hover:text-red-300'
                  : 'text-sas-muted hover:text-sas-accent'
            }`}
            title="Download the Signals & Sorcery factory sample library"
          >
            {factoryButtonLabel}
          </button>
        </div>
      )}

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
                    {matchedSamples.map((sample: PluginSampleInfo) => {
                      const isPreviewing = previewingSampleId === sample.id;
                      return (
                        <div
                          key={sample.id}
                          data-testid="sample-picker-item"
                          className="w-full px-2 py-1 rounded-sm text-xs hover:bg-sas-panel-alt transition-colors flex items-center gap-2"
                        >
                          <button
                            data-testid="sample-preview-button"
                            type="button"
                            aria-label={isPreviewing ? 'Stop preview' : 'Preview sample'}
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation();
                              handlePreviewClick(sample);
                            }}
                            className={`flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-sm border text-[10px] transition-colors ${
                              isPreviewing
                                ? 'bg-sas-accent border-sas-accent text-sas-bg'
                                : 'bg-sas-panel-alt border-sas-border text-sas-accent hover:border-sas-accent'
                            }`}
                          >
                            {isPreviewing ? '■' : '▶'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddSample(sample)}
                            className="flex-1 min-w-0 text-left flex items-center gap-2"
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
                        </div>
                      );
                    })}
                  </>
                )}

                {/* Other BPM section */}
                {otherSamples.length > 0 && (
                  <>
                    <div className="text-[10px] text-sas-muted/60 uppercase tracking-wide px-2 pt-2 pb-0.5 font-medium border-t border-sas-border mt-1">
                      Other BPM — will auto-stretch to {projectBpm}
                    </div>
                    {otherSamples.map((sample: PluginSampleInfo) => {
                      const isStretching = stretchingIds.has(sample.id);
                      const isPreviewing = previewingSampleId === sample.id;
                      return (
                        <div
                          key={sample.id}
                          data-testid="sample-picker-item-other"
                          className={`w-full px-2 py-1 rounded-sm text-xs flex items-center gap-2 transition-colors ${
                            isStretching ? 'cursor-wait opacity-60' : 'hover:bg-sas-panel-alt'
                          }`}
                        >
                          <button
                            data-testid="sample-preview-button"
                            type="button"
                            aria-label={isPreviewing ? 'Stop preview' : 'Preview sample'}
                            onClick={(e: React.MouseEvent) => {
                              e.stopPropagation();
                              handlePreviewClick(sample);
                            }}
                            className={`flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-sm border text-[10px] transition-colors ${
                              isPreviewing
                                ? 'bg-sas-accent border-sas-accent text-sas-bg'
                                : 'bg-sas-panel-alt border-sas-border text-sas-accent hover:border-sas-accent'
                            }`}
                          >
                            {isPreviewing ? '■' : '▶'}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleAddSample(sample)}
                            disabled={isStretching}
                            className="flex-1 min-w-0 text-left flex items-center gap-2"
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
                              {isStretching ? 'Stretching...' : `→ ${projectBpm}`}
                            </span>
                          </button>
                        </div>
                      );
                    })}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Transition Designer — stays mounted so in-flight creates survive a toggle */}
      {canCrossfade && xfFromId && xfToId && (
        <div className={designerView ? 'contents' : 'hidden'}>
          <TransitionDesigner
            host={host}
            fromSceneId={xfFromId}
            toSceneId={xfToId}
            transitionSceneId={activeSceneId ?? ''}
            excludeSourceDbIds={excludeSourceDbIds}
            onCreateCrossfade={handleCreateCrossfade}
            onCreateFade={handleCreateFade}
            onCreateAudioTransition={handleCreateAudioTransition}
            familyLabel="Loops"
            testIdPrefix="loops-transition-designer"
          />
        </div>
      )}

      {/* Track list (hidden while the designer is shown) */}
      {!(designerView && canCrossfade) && (isLoadingTracks ? (
        <div className="text-sas-muted text-xs text-center py-4">Loading tracks...</div>
      ) : (
        <>
          {resolvedCrossfadePairs.map((pair: ResolvedCrossfadePair) => (
            <CrossfadeTrackRow
              key={pair.groupId}
              accentColor="#9333EA"
              levels={supportsMeters ? trackLevels : undefined}
              sliderPos={pair.sliderPos}
              origin={{
                trackId: pair.origin.handle.id,
                name: pair.origin.handle.name,
                role: undefined,
                sourceName: pair.originSourceName,
                soundLabel: pair.originSoundLabel,
                runtimeState: pair.origin.runtimeState,
              }}
              target={{
                trackId: pair.target.handle.id,
                name: pair.target.handle.name,
                role: undefined,
                sourceName: pair.targetSourceName,
                soundLabel: pair.targetSoundLabel,
                runtimeState: pair.target.runtimeState,
              }}
              onMuteToggle={() => {
                const next = !pair.origin.runtimeState.muted;
                setTracks((prev) => prev.map((t) => (t.handle.id === pair.origin.handle.id || t.handle.id === pair.target.handle.id) ? { ...t, runtimeState: { ...t.runtimeState, muted: next } } : t));
                host.setTrackMute(pair.origin.handle.id, next).catch(() => {});
                host.setTrackMute(pair.target.handle.id, next).catch(() => {});
              }}
              onSoloToggle={() => {
                const next = !pair.origin.runtimeState.solo;
                setTracks((prev) => prev.map((t) => (t.handle.id === pair.origin.handle.id || t.handle.id === pair.target.handle.id) ? { ...t, runtimeState: { ...t.runtimeState, solo: next } } : t));
                host.setTrackSolo(pair.origin.handle.id, next).catch(() => {});
                host.setTrackSolo(pair.target.handle.id, next).catch(() => {});
              }}
              onVolumeChange={(slot: CrossfadeSlot, vol: number) =>
                handleVolumeChange(slot === 'origin' ? pair.origin.handle.id : pair.target.handle.id, vol)}
              onPanChange={(slot: CrossfadeSlot, pan: number) =>
                handlePanChange(slot === 'origin' ? pair.origin.handle.id : pair.target.handle.id, pan)}
              onDelete={() => handleCrossfadeDelete(pair)}
            />
          ))}
          {resolvedFades.map((fade: ResolvedFade) => (
            <FadeTrackRow
              key={fade.dbId}
              accentColor="#9333EA"
              levels={supportsMeters ? trackLevels : undefined}
              direction={fade.meta.direction}
              gesture={fade.meta.gesture}
              effect={fade.meta.effect}
              sliderPos={fade.meta.sliderPos}
              layer={{
                trackId: fade.track.handle.id,
                name: fade.track.handle.name,
                role: undefined,
                sourceName: fade.meta.sourceName,
                soundLabel: fade.meta.soundLabel,
                runtimeState: fade.track.runtimeState,
              }}
              onMuteToggle={() => handleMuteToggle(fade.track.handle.id)}
              onSoloToggle={() => handleSoloToggle(fade.track.handle.id)}
              onVolumeChange={(vol: number) => handleVolumeChange(fade.track.handle.id, vol)}
              onPanChange={(pan: number) => handlePanChange(fade.track.handle.id, pan)}
              onDelete={() => handleFadeDelete(fade)}
            />
          ))}
          {tracks.filter((t: SampleTrackState) => !crossfadeMemberDbIds.has(t.handle.dbId) && !fadeMemberDbIds.has(t.handle.dbId)).map((track: SampleTrackState) => (
          <TrackRow
            key={track.handle.id}
            track={{ id: track.handle.id, name: track.handle.name }}
            levels={supportsMeters ? trackLevels : undefined}
            runtimeState={{
              muted: track.runtimeState.muted,
              solo: track.runtimeState.solo,
              volume: track.runtimeState.volume,
              pan: track.runtimeState.pan,
            }}
            soloedOut={anySolo && !track.runtimeState.solo}
            fxDetailState={track.fxDetailState}
            drawerOpen={track.drawerOpen}
            drawerTab={track.drawerTab}
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
          ))}
        </>
      ))}
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
