# Change Log

All notable changes to the "handlebars-preview-plus" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.0.3] - 2025-11-12

### Added

- Companion module now optional; templates render even when no companion file exists.
- TypeScript companion modules compiled with the workspace tsconfig (supports `.hbs.ts` files).
- Optional `handlebars-preview-plus.enableDebugLogging` setting and output channel logging.
- Sample projects in `examples/` covering markdown helpers, invoice previews, and a TypeScript companion module.
- Extension-host tests that assert dirty module and partial overrides are respected, plus coverage for TypeScript companions.
- GitHub Actions CI workflow running lint, compile, and test on every push and pull request.

### Changed

- Renamed the project to Handlebars Preview Plus and updated command identifiers and messaging accordingly.

### Documentation

- Clarified that the extension was generated entirely with GitHub Copilot Chat (GPT-5 Codex) across README and LICENSE.

## [0.0.2] - 2025-11-04

### Documentation

- Updated README imagery and copy to better showcase the preview experience.

## [0.0.1] - 2025-11-04

- Initial release with Handlebars webview preview, companion data modules, helpers/partials support (including file-backed partials), live partial file watching, and manual refresh command.
