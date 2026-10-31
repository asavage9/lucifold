# lucifold v1.0.1

lucifold is a local-first Apple Silicon macOS image optimizer. v1.0.1 preserves the source format by default, performs image processing in Electron's main process, and never replaces source files during import, optimization, or export.

The v1.0.1 release adds per-image settings overrides, stale-result protection, safer batch/export lifecycle handling, packaged drag/drop plumbing, a Finder export affordance, and a source-based updater architecture. Live update discovery remains disabled until a future authorized build embeds an approved source.

## Supported inputs and output policy

- JPEG, PNG, WebP, and AVIF inputs.
- Preserve Original Format is the default.
- Convert to Selected Format and Smart Format Selection are explicit choices.
- PNG optimization is lossless in v1.0.1 and preserves decoded RGBA pixels and alpha.
- JPEG uses Sharp/libvips' MozJPEG path. WebP and AVIF use the codecs bundled with Sharp/libvips.
- Animated and multi-page images, SVG, GIF, HEIC/HEIF, TIFF, and other unsupported formats are rejected with an import issue.

## Local development

```sh
npm install
npm run typecheck
npm test
npm run dev
```

The development renderer is served only on `127.0.0.1`. Image processing remains local to the Electron main process.

## Packaging

```sh
npm run package:dir
```

The Apple Silicon bundle is written beneath the ignored `release/` directory. The local build uses Electron Builder's directory target. Signing, notarization, and archive-based distribution are separate release concerns.

## Documentation

- [`LICENSE_NOTICES.md`](./LICENSE_NOTICES.md) — current dependency-notice boundary.
- [`image-optimization-benchmark/fixtures/manifest.json`](./image-optimization-benchmark/fixtures/manifest.json) — reproducible image fixtures used by the automated tests.

## Safety boundary

Optimization writes temporary batch results under the macOS application temp directory. Export requires an explicit destination, uses collision-safe names, and writes through temporary files before rename. Original images are not modified by normal workflows.
