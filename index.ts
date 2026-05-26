/**
 * @signalsandsorcery/loops — Loops Plugin
 *
 * Provides loop / sample library browsing, import, time-stretching, and
 * scene-scoped sample track management.
 *
 * Extracted from the in-tree built-in (W9). The host consumes this package via
 * `file:../sas-loops-plugin` and imports the class + manifest from the root.
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
  MusicalContext,
} from '@signalsandsorcery/plugin-sdk';
import { LoopsPanel } from './LoopsPanel';
import loopsManifest from './plugin.json';

/** Plugin manifest (re-exported so the host registers it from the package root). */
export { loopsManifest };

export class LoopsPlugin implements GeneratorPlugin {
  readonly id = '@signalsandsorcery/loops';
  readonly displayName = 'Loops';
  readonly version = '1.0.0';
  readonly description = 'Audio loop / sample library browser with time-stretching and scene-scoped playback';
  readonly generatorType = 'sample' as const;
  readonly minHostVersion = '1.0.0';

  private host: PluginHost | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    console.log('[LoopsPlugin] Activated');
  }

  async deactivate(): Promise<void> {
    this.host = null;
    console.log('[LoopsPlugin] Deactivated');
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return LoopsPanel;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return null;
  }

  async onSceneChanged(_sceneId: string | null): Promise<void> {
    // Sample tracks are loaded by the host on scene change
  }

  onContextChanged(_context: MusicalContext): void {
    // Could update time-stretch parameters when BPM changes
  }
}

export default LoopsPlugin;
