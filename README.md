# Loops Plugin

A [Signals & Sorcery](https://signalsandsorcery.com) plugin for browsing, importing, and playing audio loops and samples with time-stretching.

<p align="center">
  <img src="assets/signals-and-sorcery.png" alt="Signals & Sorcery" width="420" />
</p>

> Part of the **[Signals & Sorcery](https://signalsandsorcery.com)** ecosystem.

## What it does

- Browse and search the loop / sample library by category, BPM, key, and tags
- Import audio files (WAV, MP3, FLAC, OGG, AIFF) into the library
- Create scene-scoped loop tracks
- Time-stretch samples to match project BPM
- Per-track volume, pan, mute, and solo controls

## Install

From within Signals & Sorcery: **Settings > Manage Plugins > Add Plugin** and enter:

```
https://github.com/shiehn/sas-loops-plugin
```

Or clone manually into `~/.signals-and-sorcery/plugins/@signalsandsorcery/loops/`.

## Capabilities

| Capability | Required |
|------------|----------|
| `fileDialog` | Yes — file import dialog |

## Development

Built with the [@signalsandsorcery/plugin-sdk](https://github.com/shiehn/sas-plugin-sdk). See the [Plugin SDK docs](https://signalsandsorcery.com/plugin-sdk/) for the full API reference.

## The Signals & Sorcery Ecosystem

- **[Signals & Sorcery](https://signalsandsorcery.com)** — the flagship AI music production workstation
- **[sas-plugin-sdk](https://github.com/shiehn/sas-plugin-sdk)** — TypeScript SDK for building generator plugins
- **[sas-synth-plugin](https://github.com/shiehn/sas-synth-plugin)** — AI MIDI generation with Surge XT
- **[sas-stems-plugin](https://github.com/shiehn/sas-stems-plugin)** — AI audio stems from text prompts
- **[DeclarAgent](https://github.com/shiehn/DeclarAgent)** — Declarative agent + MCP transport for S&S

<p align="center">
  <a href="https://signalsandsorcery.com">signalsandsorcery.com</a>
</p>

## License

MIT
