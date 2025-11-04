# Change Log

All notable changes to the "handlebars-preview-plus" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

### Added

- GitHub Actions CI workflow running lint, compile, and test on every push and pull request.
- Optional `handlebars-preview-plus.enableDebugLogging` setting and output channel logging.
- Sample projects in `examples/` covering markdown helpers and invoice previews.
- Extension-host tests that assert dirty module and partial overrides are respected.

### Changed

- Renamed the project to Handlebars Preview Plus and updated command identifiers and messaging accordingly.

### Documentation

- Clarified that the extension was generated entirely with GitHub Copilot Chat (GPT-5 Codex) across README and LICENSE.

## [0.0.1] - 2025-11-04

- Initial release with Handlebars webview preview, companion data modules, helpers/partials support (including file-backed partials), live partial file watching, and manual refresh command.
