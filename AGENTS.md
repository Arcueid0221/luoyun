# Repository Guidelines

## Project Scope and Architecture

Luoyun is a local-only React/Vite application for backing up NetEase Cloud Music playlists. It is not a hosted service or a redistribution tool. Vite serves both the UI and `/api/*` Node middleware; the web application itself has no separate backend process.

Provider mode is the one exception. `server/provider/` is a standalone `node:http` service (`npm run service`) that exposes `/v1/*` to the Aurora blog's admin backend behind a Bearer token. It reuses `server/http.ts` and `server/core/`, and must not depend on `server/routes/`, `server/download/`, or `src/`. See section 12 of `DESIGN.md` for the contract and `docs/阶段1部署替换打包备份验证手册.md` for deployment.

`src/` owns the React UI and client state. `server/` owns NetEase integration, authentication, filesystem access, downloads, and SQLite history. Keep shared contracts in dependency-free `server/core/types.ts`; frontend code may import it, but server code must not depend on `src/`. `scripts/` contains read-only checks. See `DESIGN.md` for architectural rationale.

## Build, Test, and Development Commands

- `npm install` — install dependencies; requires Node.js 24+.
- `npm run dev` — start UI and API at `http://127.0.0.1:5678`.
- `npm run service` — start the Provider on `127.0.0.1:5680`; requires `LUOYUN_SERVICE_TOKEN` (32+ chars) and refuses to start without it.
- `npm run build` — build frontend assets; the API is development-only.
- `npm run typecheck` — check frontend and server TypeScript.
- `npm test` — run colocated `node:test` unit tests.
- `npm run smoke` — check `/api/*` and request protections without login.
- `npm run verify` — inspect live NetEase responses; requires local authentication.

## Coding Style and Naming

Use strict TypeScript, two-space indentation, single quotes, semicolons, and explicit `.ts` extensions on relative imports. Use PascalCase for components (`TrackTable.tsx`), `useX` for hooks, and camelCase for functions. Remain compatible with `erasableSyntaxOnly`; avoid enums, namespaces, and constructor parameter properties. No formatter or linter is configured, so run `npm run typecheck`.

## Testing Guidelines

Place tests beside subjects as `*.test.ts`. Add regression tests for search, selection, filename sanitization, path boundaries, API guards, and download state. No coverage threshold is configured. Before a pull request, run tests, typechecking, and the relevant smoke or live check.

## Security and Stable Contracts

Never log, commit, or expose `MUSIC_U`. Preserve localhost-only binding, cross-site guards, home-directory path enforcement, and credential permissions. Treat `/api/*` shapes, SSE events, shared types, and the download layout as stable contracts. Cryptography, authentication, persistence, or integration changes require an approved plan.

Provider mode adds two rules. `LUOYUN_SERVICE_TOKEN` is as powerful as the account, so it stays in a `600` `.env` on the server and never enters Compose files, Git, or logs; it must never be the `MUSIC_U` value. `/v1/*` status codes are a contract: `401` means a human must supply a new `MUSIC_U`, `400` means the caller sent bad input, `413`/`422` mean the track cannot be transferred, and `500` means Luoyun itself failed. Keep `/v1/health` the only unauthenticated route, and keep audio streaming out of the heap — the `--max-old-space-size=96` flag and the container's 160 MiB limit assume it.

## Commits and Pull Requests

Use short, imperative subjects, optionally scoped: `fix(download): preserve playlist order`. Pull requests should explain behavior, list verification, link issues, and include UI screenshots. Explicitly call out API, filesystem, credential, or download-format risks.
