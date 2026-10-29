# Development

MarkEdit for Windows uses Rust and Tauri 2 for the desktop shell and a JavaScript/TypeScript editor in Microsoft WebView2. The shared editor is adapted from the MIT-licensed MarkEdit project.

## Requirements

- Windows x64 and WebView2.
- Node.js 22.12 or newer.
- Stable Rust with the MSVC target.
- Visual Studio C++ Build Tools and a working Windows SDK.

## Build

```powershell
git clone https://github.com/gregomuraca/markedit-windows.git
cd markedit-windows
npm ci
npm run package
```

The executable is `src-tauri/target/release/markedit-rust.exe`. Run `npm run dev` during development.

## Test

```powershell
npm test
npm run typecheck
npm run test:rust
npm run test:ui
npm run test:ui-export
npm run test:ui-images
npm run test:ui-accessibility
```

Desktop tests require a built executable. They launch a separate app instance with an isolated WebView2 profile and temporary files. Set `MARKEDIT_EXE`, `MARKEDIT_WORK_DIR`, or `MARKEDIT_DEBUG_PORT` to override defaults. Accessibility-check screenshots and measurements go to `MARKEDIT_REVIEW_DIR` when provided.

`npm test` includes focused GFM regression checks for table alignment and parsing, task lists, strikethrough, URL/email autolinks, fenced code, line breaks, tag filtering and sanitization. These are feature compatibility tests, not a claim of full GFM specification conformance. Export tests cover offline HTML serialization, anchors, checkbox state and incomplete resources. The native export test exercises file dialogs, draft preservation, cancellation, PDF creation, offline HTML, empty documents and missing images.

## Package a release

```powershell
powershell -File scripts/release.ps1 -OutputDirectory ..\downloads
```

Keep the MIT license and third-party notices with redistributed copies. Regenerate dependency notices with `node scripts/notices.mjs` after dependency changes.

The optional installer launcher lives in `launcher/`. Run `npm test` and `npm pack` inside that folder. It has no runtime dependencies and installs the versioned Windows app from GitHub Releases.
