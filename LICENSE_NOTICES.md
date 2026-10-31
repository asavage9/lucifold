# Local dependency notices

lucifold is a local prototype and packages the following open-source components. The exact dependency graph is recorded in `package-lock.json`; this file is the human-readable notice location included in the packaged application.

## Direct dependencies

- `sharp` — Apache-2.0. Sharp distributes a libvips bundle and its third-party notices; the installed package and `sharp-libvips` notices must be retained for a distributable build.
- `react` and `react-dom` — MIT.
- `electron` — MIT.

The feasibility benchmark includes a direct OxiPNG comparison. v1 uses Sharp/libvips for the packaged lossless PNG path because the available OxiPNG WASM wrapper did not provide reliable bounded Node/Electron lifecycle behavior. The application must be re-audited from the generated production dependency tree before public distribution. This local build does not make a legal determination about trademark, App Store, signing, notarization, or distribution eligibility.
