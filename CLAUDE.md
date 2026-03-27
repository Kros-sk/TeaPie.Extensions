# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TeaPie Extensions is a VS Code extension (TypeScript) that integrates with the TeaPie HTTP test automation CLI. It provides test discovery, execution, HTTP request running, result visualization, variable/environment management, and C# script compilation — all within VS Code.

Publisher: `kros` | VS Code Marketplace | Min VS Code: 1.85.0

## Build & Development Commands

```bash
npm run compile        # Compile TypeScript → ./out/
npm run watch          # Watch mode (auto-recompile on save)
npm run lint           # ESLint on src/**/*.ts
npm run pretest        # compile + lint
npm test               # Run tests (VS Code extension test runner)
```

Entry point: `./out/extension.js` (compiled from `src/extension.ts`).

To debug: open the repo in VS Code, press F5 to launch the Extension Development Host.

Publishing is automated via GitHub Actions on `v*` tags (`.github/workflows/publish.yml`), using `vsce` with the `VSCE_PAT` secret.

## Architecture

### Core Flow

1. **Activation**: Extension activates when workspace contains `*.http` files. `src/extension.ts` registers all commands, providers, and event listeners.
2. **Test Discovery**: `TeaPieTreeViewProvider` scans workspace for TeaPie files (`*-req.http`, `*-test.csx`, `*-init.csx`) and builds the explorer tree.
3. **Execution**: `TeaPieInitializer` ensures the TeaPie CLI is available, then `TeaPieExecutor` invokes it. Results are parsed from `.teapie/reports/` (XML via `XmlTestParser`, JSON via `StructuredJsonParser`).
4. **Visualization**: Results shown in tree views (`TestResultsProvider`) and webview panels (`TestResultsWebviewProvider`, `HttpRequestRunner`).

### Key Modules

| Module | Role |
|--------|------|
| `src/extension.ts` | Entry point, command registration, provider setup |
| `src/modules/TeaPieExecutor.ts` | Runs TeaPie CLI, processes output |
| `src/modules/XmlTestParser.ts` | Parses XML test reports |
| `src/modules/StructuredJsonParser.ts` | Parses JSON HTTP request results |
| `src/modules/HttpFileParser.ts` | Parses `.http` file content |
| `src/HttpRequestRunner.ts` | Executes individual HTTP requests, displays results in webview |
| `src/HttpPreviewProvider.ts` | HTML preview of `.http` files |
| `src/TeaPieTreeViewProvider.ts` | File explorer tree view |
| `src/TestResultsWebviewProvider.ts` | Test results HTML webview |
| `src/VariablesProvider.ts` / `VariablesEditorProvider.ts` | Variable management & visual editor |
| `src/EnvironmentEditorProvider.ts` | Environment config visual editor |
| `src/TeaPieLanguageServer.ts` | IntelliSense, completions, hover for `.http` files |
| `src/utils/TeaPieInitializer.ts` | TeaPie CLI installation & setup |

### TeaPie File Conventions

- `*-req.http` — HTTP request files
- `*-test.csx` — C# test scripts
- `*-init.csx` — C# initialization scripts
- `.teapie/env.json` — Environment configuration
- `.teapie/cache/variables/variables.json` — Cached variables
- `.teapie/reports/*.xml`, `.teapie/reports/*.json` — Test/request results

### Configuration Settings

- `teapie.executablePath` — Path to TeaPie CLI (default: `"teapie"`)
- `teapie.currentEnvironment` — Active environment
- `teapie.requestTimeout` — HTTP request timeout in ms

## Tech Stack

- **Language**: TypeScript 5.3 (strict mode, ES2020 target, CommonJS)
- **Runtime dependency**: `xml2js` (XML parsing)
- **Linting**: ESLint with `@typescript-eslint`
- **No bundler** — `tsc` compiles directly to `./out/`
