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
 *
 * Three header buttons, three sources (S-015 / D-010):
 *   - "From scene"  (import-from-scene-loops-button): copy loops from another scene.
 *   - "From disk"   (import-sample-button): pick files → each is imported, fitted to
 *                   the scene and put on a new track (handleLoadFromDisk). When a loop
 *                   can't be placed it is still imported and the toast says why.
 *   - "+ Library"   (add-sample-button): browse/search/preview the library picker.
 * Both "From disk" and the picker place loops through ONE path (placeSample).
 *
 * "Recently imported" (S-015 / D-011) tops the picker when anything qualifies
 * (rules in recently-imported.ts). When "From disk" places nothing (no scene,
 * no contract, track limit, an old host, a scene-wide stop) the picker opens
 * on it with the just-imported rows highlighted, so the pick is one click away.
 *
 * Scene panel bus (S-027 / D-018, D-020): the SDK's PanelMasterStrip tops the
 * track list, like the drum panel and every GeneratorPanelShell panel. One
 * fader + FX chain for all of the scene's loops, plus the Duck / WOB clusters
 * (loops are duck and wobble TARGETS; both start at amount 0 = off, never a
 * duck source). The host routes the loops into the bus on each bus read, so
 * the panel re-reads whenever its loop set changes (notifyTracksChanged).
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { GiSoundWaves } from 'react-icons/gi';
import type {
  PluginUIProps,
  PluginSampleInfo,
  PluginSampleTrackInfo,
  PluginTrackHandle,
  PluginTrackRuntimeState,
} from '@signalsandsorcery/plugin-sdk';
import { TrackRow, type DrawerTab, useAnySolo, PanelMasterStrip, usePanelBus, ImportTrackModal, useTrackLevels, TransitionDesigner, CrossfadeTrackRow, FadeTrackRow, parseCrossfadePairs, parseFades, buildCrossfadeVolumeCurves, buildFadeVolumeCurve, type CrossfadeSlot, type CrossfadeSelection, type CrossfadeMeta, type CrossfadePairMeta, type FadeDirection, type FadeGesture, type FadeMeta, type FadeEntry, type FadeSelection } from '@signalsandsorcery/plugin-sdk';
import {
  LIBRARY_BUTTON_LABEL,
  describeSourceLoop,
  emptyOutcome,
  fileBaseName,
  importErrorFor,
  isSceneWideError,
  perLoopMessage,
  placementBlocker,
  summarizeLoad,
  type LeftReason,
  type LoadOutcome,
} from './load-from-disk';
import {
  RECENT_HIGHLIGHT_MS,
  importedTitle,
  selectRecentlyImported,
  type RecentImport,
} from './recently-imported';

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
  isExpanded,
}: PluginUIProps): React.ReactElement {
  // Cosmetic per-track peak meters. Poll ONLY while this panel is expanded
  // (`isExpanded`): collapsed panels stay mounted, so without this gate every
  // hidden panel keeps polling at ~30Hz — and the accordion only ever expands
  // one. NOT gated on transport state (this app plays via decks/clip-launcher,
  // so the linear "is playing" flag is unreliable). Stopped tracks just read the
  // floor. The host coalesces the read so playback always wins over the GUI.
  // Older hosts (no getTrackLevels) degrade to no meter via `supportsMeters`.
  const supportsMeters = typeof host.getTrackLevels === 'function';
  const trackLevels = useTrackLevels(host, isExpanded);

  const [tracks, setTracks] = useState<SampleTrackState[]>([]);
  // Cross-panel: dim non-soloed rows when ANY track (any panel) is soloed.
  const anySolo = useAnySolo(host);

  // ─── Scene panel bus (S-027 / D-018, D-020) ──────────────────────
  // Same hook as the drum panel / GeneratorPanelShell. Feature-gated: on a
  // host without the bus surface `supported` is false and no strip renders.
  // A bus read is where the host routes this panel's loops into the bus and,
  // in the active scene, auto-engages it once a loop exists.
  const panelBus = usePanelBus(host, activeSceneId);
  // "The loop set changed": re-read the bus so a new loop joins it at once
  // (S-027 gap G1). Coalesced, never overlapping, stable identity (safe in
  // deps). Not `panelBus.reload()`: that reads immediately and can overlap.
  // It is SDK 3.19.0 and the host supplies the SDK at runtime, so an older
  // one has none: loops then join the bus on the next scene change or reopen,
  // as before. That is why minHostVersion does not move.
  const notifyBusTracksChanged: (() => void) | undefined =
    typeof panelBus.notifyTracksChanged === 'function' ? panelBus.notifyTracksChanged : undefined;

  const [isLoadingTracks, setIsLoadingTracks] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [samples, setSamples] = useState<PluginSampleInfo[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingSamples, setIsLoadingSamples] = useState(false);
  const [stretchingIds, setStretchingIds] = useState<Set<string>>(new Set());
  const [previewingSampleId, setPreviewingSampleId] = useState<string | null>(null);

  // ─── "From disk" batch progress (busy state on the button) ────────
  // null = idle. `done` counts files handled so far (placed, left or failed).
  const [diskLoad, setDiskLoad] = useState<{ done: number; total: number } | null>(null);
  // Synchronous guard: a second click while the dialog is open or a batch runs is ignored.
  const diskLoadBusyRef = useRef(false);

  // ─── "Recently imported" (S-015 / D-011) ──────────────────────────
  // Library ids this panel session imported via "From disk" → when (ms). They
  // always count as recent (the "new" badge), which also keeps the section
  // working on hosts that report no `origin` / `importedAt`.
  const [sessionImports, setSessionImports] = useState<ReadonlyMap<string, number>>(() => new Map());
  // Rows flashed after "From disk" opened the picker because nothing was placed.
  const [highlightIds, setHighlightIds] = useState<ReadonlySet<string>>(() => new Set());
  const rememberImports = useCallback((ids: readonly string[]): void => {
    if (ids.length === 0) return;
    const at = Date.now();
    setSessionImports((prev: ReadonlyMap<string, number>) => {
      const next = new Map(prev);
      for (const id of ids) next.set(id, at);
      return next;
    });
  }, []);
  useEffect(() => {
    if (highlightIds.size === 0) return;
    const timer = setTimeout(() => setHighlightIds(new Set()), RECENT_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightIds]);

  // Latest props for long async flows (a file dialog can stay open while the
  // user switches scenes; a batch of fits takes seconds per loop). Read at
  // decision time, never from a stale closure.
  const liveRef = useRef({ activeSceneId, sceneContext, isConnected, trackCount: tracks.length });
  liveRef.current = { activeSceneId, sceneContext, isConnected, trackCount: tracks.length };
  const pickerOpenRef = useRef(pickerOpen);
  pickerOpenRef.current = pickerOpen;

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
  // async fetch (DB query + per-track getTrackInfo — several hundred ms in
  // practice). During that window
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

        trackStates.push({
          handle: st.track,
          sample: st.sample,
          runtimeState,
          drawerOpen: false,
          drawerTab: 'fx',
        });
      }
      if (isStale()) return;
      setTracks(trackStates);
      // The loop set is settled for this scene: let the bus route it (and
      // auto-engage on the scene's first loop). This covers every reload:
      // scene change, engine ready, agent mutations, "From scene" imports,
      // crossfade / fade / audio-transition creates. A stale load never gets
      // here, so it never reads the bus for a scene that is gone.
      notifyBusTracksChanged?.();
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
  }, [host, activeSceneId, notifyBusTracksChanged]);

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
  // `query` pre-fills the search box; `highlight` flashes those rows (the
  // "From disk" nothing-placed hand-off). A plain open starts unfiltered.
  const openPicker = useCallback(async (
    options?: { query?: string; highlight?: readonly string[] },
  ): Promise<void> => {
    setPickerOpen(true);
    setSearchQuery(options?.query ?? '');
    setHighlightIds(new Set(options?.highlight ?? []));
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

  // ─── Place one library sample on a new track (THE add path) ─────
  // Fit to the active scene, create the sample track, append the row. Shared
  // by the library picker (handleAddSample) and "From disk"
  // (handleLoadFromDisk) so both place loops the same way. Throws on failure;
  // callers own the gating and the messages.
  const placeSample = useCallback(async (
    sample: PluginSampleInfo,
  ): Promise<{ handle: PluginTrackHandle; placed: PluginSampleInfo; fitted: boolean }> => {
    // Fit the sample to the active scene's (bpm, length_bars). This
    // composes time-stretch + chop/loop-stitch in a single host call
    // (see `fitSampleToScene` in the SDK). Was a plain time-stretch
    // before per-scene bar lengths shipped, which left 4-bar samples
    // overflowing 2-bar scenes / under-filling 8-bar scenes.
    const liveContext = liveRef.current.sceneContext;
    const targetBpm = liveContext?.bpm ?? null;
    const targetBars = liveContext?.bars ?? null;
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
      drawerOpen: false,
      drawerTab: 'fx',
    };
    setTracks((prev: SampleTrackState[]) => [...prev, newTrack]);
    // A placed loop joins the scene bus now, not on the next reload (the
    // library picker and every "From disk" loop both land here).
    notifyBusTracksChanged?.();
    return { handle, placed: sampleToLoad, fitted: needsFit };
  }, [host, notifyBusTracksChanged]);

  // ─── Add sample track from the library picker ───────────────────
  const handleAddSample = useCallback(async (sample: PluginSampleInfo): Promise<void> => {
    // The picker can be open with no scene / no contract (after "From disk"
    // left loops in the library), so say what's missing and open it.
    if (!activeSceneId) {
      host.showToast('warning', 'Select a scene', 'Loops are added to the selected scene.');
      onSelectScene?.();
      return;
    }
    if (!sceneContext?.hasContract) {
      host.showToast('info', 'Generate a contract first', 'This scene needs a contract before loops can be added.');
      onOpenContract?.();
      return;
    }
    if (tracks.length >= MAX_TRACKS) {
      host.showToast('warning', 'Track limit reached', `This scene is at the ${MAX_TRACKS}-track loop limit: delete a track to add another.`);
      return;
    }
    if (diskLoadBusyRef.current) {
      host.showToast('info', 'Still adding loops from disk', 'Try again when they are done.');
      return;
    }

    try {
      const { fitted } = await placeSample(sample);
      closePicker();
      onExpandSelf?.();
      host.showToast('success', fitted ? 'Sample fitted & added' : 'Sample added');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      host.showToast('error', 'Failed to add sample', msg);
    }
  }, [host, activeSceneId, sceneContext?.hasContract, tracks.length, closePicker, placeSample, onExpandSelf, onSelectScene, onOpenContract]);

  // ─── "From disk": import files, then place each on a new track ───
  // D-010. Placement is attempted per file, in pick order: import → fit →
  // track. The pick is never wasted: when loops can't be placed (no scene,
  // no contract, not connected, track limit, a scene-wide host error, or a
  // host older than SDK 3.18.0 that returns no sample ids) the files still go
  // into the library and the closing toast says why and what to do next.
  const handleLoadFromDisk = useCallback(async (): Promise<void> => {
    if (diskLoadBusyRef.current) return;
    diskLoadBusyRef.current = true;
    const outcome: LoadOutcome = emptyOutcome(0);
    // Library ids this batch resolved to (SDK 3.18.0 `samples`), in pick order.
    const batchIds: string[] = [];
    const noteImported = (ids: readonly string[]): void => {
      for (const id of ids) if (!batchIds.includes(id)) batchIds.push(id);
      rememberImports(ids);
    };
    try {
      const filePaths: string[] | null = await host.showOpenDialog({
        title: 'Add loops from disk',
        filters: [{ name: 'Audio', extensions: AUDIO_EXTENSIONS }],
        multiSelections: true,
      });
      if (!filePaths || filePaths.length === 0) return; // cancelled

      outcome.picked = filePaths.length;
      setDiskLoad({ done: 0, total: filePaths.length });

      // Import the given files WITHOUT placing them; record what landed.
      const importOnly = async (paths: string[], reason: LeftReason, detail?: string | null): Promise<void> => {
        if (paths.length === 0) return;
        outcome.leftReason = reason;
        if (detail !== undefined) outcome.leftDetail = detail;
        try {
          const result = await host.importSamples(paths);
          if (result.samples !== undefined) {
            noteImported(result.samples.map((s) => s.id));
            const resolved = new Set(result.samples.map((s) => s.sourcePath));
            for (const s of result.samples) {
              outcome.left.push({ name: fileBaseName(s.sourcePath), duplicate: s.duplicate });
            }
            const unresolved = paths.filter((p: string) => !resolved.has(p));
            for (const p of unresolved) {
              outcome.failedImports.push({
                name: fileBaseName(p),
                error: importErrorFor(p, result.errors, unresolved.length === 1),
              });
            }
          } else {
            // Pre-3.18.0 host: counts only, no per-file ids or names.
            const single = paths.length === 1 ? fileBaseName(paths[0]) : null;
            for (let i = 0; i < result.imported; i++) outcome.left.push({ name: single, duplicate: false });
            const nFailed = Math.max(0, paths.length - result.imported);
            for (let i = 0; i < nFailed; i++) {
              outcome.failedImports.push({
                name: single,
                error: single ? importErrorFor(paths[0], result.errors, true) : null,
              });
            }
          }
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : 'Import failed';
          for (const p of paths) outcome.failedImports.push({ name: fileBaseName(p), error: msg });
        }
      };

      // Blocked before anything is placed → import only (D-010: no scene =
      // import + "Select a scene"; the other blockers follow the same rule).
      const live = liveRef.current;
      const blocker = placementBlocker({
        activeSceneId: live.activeSceneId,
        hasContract: !!live.sceneContext?.hasContract,
        isConnected: live.isConnected,
        trackCount: live.trackCount,
      }, MAX_TRACKS);
      if (blocker) {
        await importOnly(filePaths, blocker);
        setDiskLoad({ done: filePaths.length, total: filePaths.length });
        if (blocker === 'no-scene') onSelectScene?.();
        if (blocker === 'no-contract') onOpenContract?.();
        return;
      }

      const sceneAtStart = live.activeSceneId;
      const startCount = live.trackCount;
      if (filePaths.length > 1) {
        host.showToast(
          'info',
          `Adding ${filePaths.length} loops from disk…`,
          'Each is fitted to the scene tempo and length: this can take a few seconds per loop.',
        );
      }
      onExpandSelf?.();

      for (let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];
        const name = fileBaseName(filePath);
        setDiskLoad({ done: i, total: filePaths.length });

        if (startCount + outcome.added.length >= MAX_TRACKS) {
          await importOnly(filePaths.slice(i), 'track-limit');
          break;
        }
        if (liveRef.current.activeSceneId !== sceneAtStart) {
          await importOnly(filePaths.slice(i), 'scene-changed');
          break;
        }

        // 1. Import this file.
        let imported: { id: string; duplicate: boolean } | null = null;
        try {
          const result = await host.importSamples([filePath]);
          if (result.samples === undefined) {
            // Pre-3.18.0 host: the file is in (or failed) but there is no id
            // to place. Account for it, import the rest, stop placing.
            if (result.imported > 0) outcome.left.push({ name, duplicate: false });
            else outcome.failedImports.push({ name, error: importErrorFor(filePath, result.errors, true) });
            await importOnly(filePaths.slice(i + 1), 'old-host');
            outcome.leftReason = 'old-host';
            break;
          }
          const first = result.samples[0];
          if (!first) {
            outcome.failedImports.push({ name, error: importErrorFor(filePath, result.errors, true) });
            continue;
          }
          imported = { id: first.id, duplicate: first.duplicate };
          noteImported([first.id]);
          setHasAnySamples(true);
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : 'Import failed';
          outcome.failedImports.push({ name, error: msg });
          continue;
        }
        if (!imported) continue;

        // 2. Fit + place it (the same path as the library picker).
        try {
          const source = await host.getSampleById(imported.id);
          if (!source) throw new Error('It was imported but is missing from the library.');
          await placeSample(source);
          const loop = { name, duplicate: imported.duplicate, detail: describeSourceLoop(source) };
          outcome.added.push(loop);
          if (filePaths.length > 1) host.showToast('success', `Added ${name}`, perLoopMessage(loop));
        } catch (error: unknown) {
          const msg = error instanceof Error ? error.message : 'Unknown error';
          if (isSceneWideError(error)) {
            // Every later loop would fail the same way: keep this one in the
            // library and import the rest, then say why.
            outcome.left.push({ name, duplicate: imported.duplicate });
            await importOnly(filePaths.slice(i + 1), 'host-error', msg);
            outcome.leftReason = 'host-error';
            outcome.leftDetail = msg;
            break;
          }
          outcome.failedPlacements.push({ name, error: msg });
        }
      }
      setDiskLoad({ done: filePaths.length, total: filePaths.length });
    } catch (error: unknown) {
      // The dialog itself failed (or an unexpected throw): say so.
      const msg = error instanceof Error ? error.message : 'Unknown error';
      if (outcome.picked === 0) {
        host.showToast('error', 'Could not open the file picker', msg);
      } else {
        outcome.failedPlacements.push({ name: null, error: msg });
      }
    } finally {
      diskLoadBusyRef.current = false;
      setDiskLoad(null);
      if (outcome.picked > 0) {
        const toast = summarizeLoad(outcome, MAX_TRACKS);
        host.showToast(toast.type, toast.title, toast.message);
        if (outcome.added.length > 0 || outcome.left.length > 0) {
          setHasAnySamples(true);
          if (outcome.added.length === 0) {
            // Nothing placed (no scene, no contract, track limit, an old host,
            // a scene-wide stop…): open + Library on "Recently imported" with
            // the just-imported rows lit, so placing them is one click. The
            // toast above still says why. A host with no ids (pre-3.18.0)
            // can't say which rows: a single file is found by name instead.
            const byName = batchIds.length === 0 && outcome.picked === 1 ? outcome.left[0]?.name ?? null : null;
            void openPicker({ highlight: batchIds, ...(byName ? { query: byName } : {}) });
            onExpandSelf?.();
          } else if (pickerOpenRef.current) {
            // Keep an open library picker in step with the new rows.
            host.getSamples().then(setSamples).catch(() => { /* best effort */ });
          }
        }
      }
    }
  }, [host, placeSample, onExpandSelf, onSelectScene, onOpenContract, openPicker, rememberImports]);

  // ─── Push header content (the three add flows) to accordion header ─
  // "From scene" · "From disk" · "+ Library": each names its SOURCE so the
  // three read as distinct flows (S-015). Test ids are unchanged.
  const needsContract = !sceneContext?.hasContract;
  useEffect(() => {
    if (!onHeaderContent) return;
    const disabled = needsContract || !isConnected || !activeSceneId || tracks.length >= MAX_TRACKS;
    // Why loops can't be placed right now (tooltips say it before the click).
    const blockedReason: string | null = !activeSceneId
      ? 'no scene is selected'
      : needsContract
        ? 'this scene has no contract yet'
        : !isConnected
          ? 'systems are not connected'
          : tracks.length >= MAX_TRACKS
            ? `this scene is at the ${MAX_TRACKS}-track loop limit`
            : null;
    const diskBusy = diskLoad !== null;
    const diskLabel = !diskBusy
      ? 'From disk'
      : diskLoad.total > 1
        ? `Adding ${Math.min(diskLoad.done + 1, diskLoad.total)}/${diskLoad.total}…`
        : 'Adding…';
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
            title={!activeSceneId
              ? 'Copy loops from another scene: select a scene first'
              : needsContract
                ? 'Copy loops from another scene: generate a contract for this scene first'
                : 'Copy loops from another scene into this scene'}
            className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
              !activeSceneId || needsContract
                ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
                : 'bg-sas-panel-alt border-sas-border text-sas-muted hover:border-sas-accent hover:text-sas-accent'
            }`}
          >
            From scene
          </button>
        )}
        {(!canCrossfade || !designerView) && (
          <button
            data-testid="import-sample-button"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              void handleLoadFromDisk();
            }}
            disabled={diskBusy}
            aria-busy={diskBusy}
            title={diskBusy
              ? 'Adding loops from disk…'
              : blockedReason
                ? `Add loop files from disk to this scene (${blockedReason}: they will go to your library only)`
                : 'Add loop files from disk to this scene'}
            className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
              diskBusy
                ? 'bg-sas-accent/10 border-sas-accent/40 text-sas-accent cursor-wait'
                : blockedReason
                  ? 'bg-sas-panel border-sas-border text-sas-muted/50 hover:text-sas-muted'
                  : 'bg-sas-panel-alt border-sas-border text-sas-muted hover:border-sas-accent hover:text-sas-accent'
            }`}
          >
            {diskLabel}
          </button>
        )}
        {(!canCrossfade || !designerView) && (
          <button
            data-testid="add-sample-button"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              // An open picker always closes (it can be open with no scene
              // after "From disk" left loops in the library).
              if (pickerOpen) {
                closePicker();
                return;
              }
              if (!activeSceneId) {
                host.showToast('warning', 'Select a scene', 'Loops are added to the selected scene.');
                onSelectScene?.();
                return;
              }
              if (needsContract) {
                host.showToast('info', 'Generate a contract first', 'This scene needs a contract before loops can be added.');
                onOpenContract?.();
                return;
              }
              void openPicker();
              onExpandSelf?.();
            }}
            title={pickerOpen
              ? 'Close the loop library'
              : `Browse your loop library and add a loop to this scene${blockedReason ? ` (${blockedReason})` : ''}`}
            className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
              disabled
                ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
                : pickerOpen
                  ? 'bg-sas-accent border-sas-accent text-sas-bg'
                  : 'bg-sas-accent/10 border-sas-accent/30 text-sas-accent hover:bg-sas-accent/20'
            }`}
          >
            {pickerOpen ? 'Close' : LIBRARY_BUTTON_LABEL}
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
  }, [onHeaderContent, isConnected, activeSceneId, tracks.length, pickerOpen, openPicker, closePicker, handleLoadFromDisk, diskLoad, needsContract, onOpenContract, onSelectScene, host, designerView, canCrossfade, transitionDone, transitionSourceTotal, onExpandSelf]);

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

  const toggleFxDrawer = useCallback((trackId: string): void => {
    setTracks((prev: SampleTrackState[]) => prev.map((t: SampleTrackState) => {
      if (t.handle.id !== trackId) return t;
      const onFx = t.drawerOpen && t.drawerTab === 'fx';
      return { ...t, drawerOpen: !onFx, drawerTab: 'fx' };
    }));
  }, []);

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

  // Audio-only one-sided transition (stutter / chopped / delay / filter /
  // tape-stop). Every effect RENDERS a new WAV offline (renderSampleEffect —
  // filter is a direction-tied highpass sweep: out climbs 20→2400 Hz, in
  // descends; delay is an offline feedback-echo throw). All ramp the loop
  // in/out across the transition.
  const handleCreateAudioTransition = useCallback(
    async (selection: FadeSelection, direction: FadeDirection, effect: 'stutter' | 'chopped' | 'delay' | 'filter' | 'tape-stop'): Promise<void> => {
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
        // Every effect re-renders the loop's audio offline into a new sample
        // (filter sweeps the cutoff with the fade direction; delay renders a
        // feedback-echo throw with the SDK's default delay params).
        if (!host.renderSampleEffect) throw new Error(`${effect} requires a newer host build.`);
        const rendered = await host.renderSampleEffect(sampleId, {
          effect, bars: mc.bars, bpm: mc.bpm,
          ...(effect === 'filter'
            ? {
                filterType: 'highpass' as const,
                startHz: direction === 'out' ? 20 : 2400,
                endHz: direction === 'out' ? 2400 : 20,
              }
            : {}),
          ...(effect === 'tape-stop'
            ? {
                tapeDirection: (direction === 'out' ? 'stop' : 'start') as 'stop' | 'start',
                tapeSpanSeconds: (60 / mc.bpm) * 4,
              }
            : {}),
        });
        sampleId = rendered.id;
        try { sampleId = (await host.fitSampleToScene(sampleId)).id; } catch { /* fit best-effort */ }
        const handle = await host.createSampleTrack(sampleId);
        created.push(handle);
        await applyFadeAutomation(handle.id, direction, mc.bars, mc.bpm, 0.5, 'volume');
        appliedFadeAutomationRef.current.add(handle.id);
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

  // "Recently imported" tops the list while the search box is empty. Typing
  // folds those rows back into the normal results (the section hides; nothing
  // is listed twice), and session imports keep their "new" badge there.
  const recentImports: RecentImport[] = useMemo(
    () => selectRecentlyImported(samples, sessionImports, Date.now()),
    [samples, sessionImports],
  );
  const isSearching = searchQuery.trim().length > 0;
  const showRecent = !isSearching && recentImports.length > 0;
  const recentIds: ReadonlySet<string> = showRecent
    ? new Set(recentImports.map((r: RecentImport) => r.sample.id))
    : new Set();

  const searchFiltered: PluginSampleInfo[] = isSearching
    ? samples.filter((s: PluginSampleInfo) =>
        s.filename.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : samples.filter((s: PluginSampleInfo) => !recentIds.has(s.id));

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

  // ─── Library picker (JSX) ───────────────────────────────────────
  const renderPreviewButton = (sample: PluginSampleInfo): React.ReactElement => {
    const isPreviewing = previewingSampleId === sample.id;
    return (
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
    );
  };

  // "new" = imported by "From disk" in this panel session.
  const renderNewBadge = (sampleId: string): React.ReactNode => (sessionImports.has(sampleId) ? (
    <span
      data-testid="sample-new-badge"
      title="Imported in this session"
      className="text-[9px] leading-none px-1 py-0.5 rounded-sm bg-sas-accent text-sas-bg uppercase font-semibold flex-shrink-0"
    >
      new
    </span>
  ) : null);

  // Brief ring on the rows "From disk" just imported but could not place.
  const highlightClass = (sampleId: string): string =>
    (highlightIds.has(sampleId) ? ' ring-1 ring-sas-accent bg-sas-accent/15' : '');

  const renderRecentRow = (item: RecentImport): React.ReactElement => {
    const { sample } = item;
    const isStretching = stretchingIds.has(sample.id);
    const highlighted = highlightIds.has(sample.id);
    const offTempo = projectBpm != null && sample.bpm != null && Math.abs(sample.bpm - projectBpm) > BPM_TOLERANCE;
    return (
      <div
        key={sample.id}
        data-testid="recent-import-item"
        data-sample-id={sample.id}
        data-highlighted={highlighted ? 'true' : undefined}
        title={importedTitle(item.at)}
        className={`w-full px-2 py-1 rounded-sm text-xs flex items-center gap-2 transition-colors ${
          isStretching ? 'cursor-wait opacity-60' : 'hover:bg-sas-panel-alt'
        }${highlightClass(sample.id)}`}
      >
        {renderPreviewButton(sample)}
        <button
          type="button"
          data-testid="recent-import-add"
          onClick={() => handleAddSample(sample)}
          disabled={isStretching}
          className="flex-1 min-w-0 text-left flex items-center gap-2"
        >
          <GiSoundWaves size={14} className="text-sas-accent flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1 min-w-0">
              <span className="truncate text-sas-text">{sample.filename}</span>
              {item.isNew && renderNewBadge(sample.id)}
            </div>
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
          {(isStretching || offTempo) && (
            <span className="text-[10px] text-sas-accent flex-shrink-0">
              {isStretching ? 'Stretching...' : `→ ${projectBpm}`}
            </span>
          )}
        </button>
      </div>
    );
  };

  const pickerEl: React.ReactElement = (
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
        ) : matchedSamples.length === 0 && otherSamples.length === 0 && !showRecent ? (
          <div className="text-sas-muted text-xs text-center py-4">
            {searchQuery.trim()
              ? 'No matching samples'
              : 'Your library is empty: download the sample library, or add loop files with From disk.'}
          </div>
        ) : (
          <>
            {/* Recently imported (S-015 / D-011): only when something qualifies */}
            {showRecent && (
              <div data-testid="recently-imported-section">
                <div className="text-[10px] text-sas-accent uppercase tracking-wide px-2 pt-1 pb-0.5 font-medium">
                  Recently imported
                </div>
                {recentImports.map(renderRecentRow)}
              </div>
            )}

            {/* BPM-matched section */}
            {matchedSamples.length > 0 && (
              <>
                {(projectBpm != null || showRecent) && (
                  <div className={`text-[10px] text-sas-accent uppercase tracking-wide px-2 pb-0.5 font-medium ${
                    showRecent ? 'pt-2 border-t border-sas-border mt-1' : 'pt-1'
                  }`}>
                    {projectBpm != null ? `Matching ${projectBpm} BPM` : 'Library'}
                  </div>
                )}
                {matchedSamples.map((sample: PluginSampleInfo) => {
                  return (
                    <div
                      key={sample.id}
                      data-testid="sample-picker-item"
                      className={`w-full px-2 py-1 rounded-sm text-xs hover:bg-sas-panel-alt transition-colors flex items-center gap-2${highlightClass(sample.id)}`}
                    >
                      {renderPreviewButton(sample)}
                      <button
                        type="button"
                        onClick={() => handleAddSample(sample)}
                        className="flex-1 min-w-0 text-left flex items-center gap-2"
                      >
                        <GiSoundWaves size={14} className="text-sas-accent flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1 min-w-0">
                            <span className="truncate text-sas-text">{sample.filename}</span>
                            {renderNewBadge(sample.id)}
                          </div>
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
                  return (
                    <div
                      key={sample.id}
                      data-testid="sample-picker-item-other"
                      className={`w-full px-2 py-1 rounded-sm text-xs flex items-center gap-2 transition-colors ${
                        isStretching ? 'cursor-wait opacity-60' : 'hover:bg-sas-panel-alt'
                      }${highlightClass(sample.id)}`}
                    >
                      {renderPreviewButton(sample)}
                      <button
                        type="button"
                        onClick={() => handleAddSample(sample)}
                        disabled={isStretching}
                        className="flex-1 min-w-0 text-left flex items-center gap-2"
                      >
                        <GiSoundWaves size={14} className="text-sas-muted/40 flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1 min-w-0">
                            <span className="truncate text-sas-muted">{sample.filename}</span>
                            {renderNewBadge(sample.id)}
                          </div>
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
  );

  // ─── Render ──────────────────────────────────────────────────────

  // No scene / no contract: the placeholder, plus the library picker when it
  // is open ("From disk" opens it on the loops it could not place, so they
  // wait at the top of Recently imported until the scene is ready).
  const withPicker = (placeholder: React.ReactElement): React.ReactElement => (pickerOpen ? (
    <div className="p-2 space-y-2">
      {placeholder}
      {pickerEl}
    </div>
  ) : placeholder);

  // No scene selected
  if (!activeSceneId) {
    return withPicker(
      <div data-testid="no-scene-placeholder-sample" className={`flex items-center justify-center ${pickerOpen ? 'py-2' : 'py-8'}`}>
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
    return withPicker(
      <div data-testid="no-contract-placeholder-sample" className={`flex items-center justify-center ${pickerOpen ? 'py-2' : 'py-8'}`}>
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

      {/* Inline sample picker (built above: also shown by the no-scene / no-contract placeholders) */}
      {pickerOpen && pickerEl}

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
          {/* Scene panel bus strip (S-027): the drum panel / shell placement.
              Hidden while loading, in the designer view and under the
              placeholders; absent on hosts without the bus surface. */}
          {panelBus.supported && panelBus.bus && (
            // The ref gates the bus meter stream to on-screen strips (a
            // collapsed or scrolled-away panel holds no engine refcount).
            <div ref={panelBus.meterVisibilityRef}>
              <PanelMasterStrip
                bus={panelBus.bus}
                levels={panelBus.levels}
                availableFx={panelBus.availableFx}
                fxLoading={panelBus.fxLoading}
                soloedOut={anySolo && !panelBus.bus.soloed}
                fxPickerOpen={panelBus.fxPickerOpen}
                onToggleFxPicker={panelBus.setFxPickerOpen}
                onRefreshFx={panelBus.refreshFx}
                onVolumeChange={panelBus.onVolumeChange}
                onMuteToggle={panelBus.onMuteToggle}
                onSoloToggle={panelBus.onSoloToggle}
                onAddFx={panelBus.onAddFx}
                onRemoveFx={panelBus.onRemoveFx}
                onToggleFxEnabled={panelBus.onToggleFxEnabled}
                onShowFxEditor={panelBus.onShowFxEditor}
                onMoveFx={panelBus.fxReorderSupported ? panelBus.onMoveFx : undefined}
                // Duck + WOB (D-020): loops are targets. The host's default
                // is amount 0 (off) until the user touches it; the panel
                // never writes either on its own.
                sidechain={panelBus.sidechainSupported ? panelBus.sidechain : null}
                onSidechainAmountChange={panelBus.sidechainSupported ? panelBus.onSidechainAmountChange : undefined}
                onSidechainPresetChange={panelBus.sidechainSupported ? panelBus.onSidechainPresetChange : undefined}
                onSidechainSourceChange={panelBus.sidechainSupported ? panelBus.onSidechainSourceChange : undefined}
                onSidechainLengthChange={panelBus.sidechainSupported ? panelBus.onSidechainLengthChange : undefined}
                motion={panelBus.motionSupported ? panelBus.motion : null}
                onMotionAmountChange={panelBus.motionSupported ? panelBus.onMotionAmountChange : undefined}
                onMotionRateChange={panelBus.motionSupported ? panelBus.onMotionRateChange : undefined}
                onMotionShapeChange={panelBus.motionSupported ? panelBus.onMotionShapeChange : undefined}
                onMotionTargetChange={panelBus.motionSupported ? panelBus.onMotionTargetChange : undefined}
              />
            </div>
          )}
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
            drawerOpen={track.drawerOpen}
            drawerTab={track.drawerTab}
            onDelete={() => handleDeleteTrack(track.handle.id)}
            onMuteToggle={() => handleMuteToggle(track.handle.id)}
            onSoloToggle={() => handleSoloToggle(track.handle.id)}
            onVolumeChange={(vol: number) => handleVolumeChange(track.handle.id, vol)}
            onPanChange={(pan: number) => handlePanChange(track.handle.id, pan)}
            externalFxHost={host}
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

export default LoopsPanel;
