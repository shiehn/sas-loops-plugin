/**
 * @signalsandsorcery/loops — Built-in Loops Plugin
 *
 * Provides browsing, importing, and playing audio loops/samples with
 * time-stretching and scene-scoped track management.
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
