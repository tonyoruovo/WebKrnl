# Changelog

All `@webkrnl/*` packages share one version (fixed versioning). Each release has one section. The version stays `0.0.2` until every milestone is done and the alpha tests pass in real React, Vue, Svelte and Astro projects (docs/PLAN.md §4.1).

## Unreleased (0.0.2, pre-alpha)

Nothing is published yet. This section lists what the milestones built.

### M10: platform, adapter, scaffolder, release

- The project is **WebKrnl**, and every package is `@webkrnl/*` (the placeholder was `@platform`).
- `@webkrnl/platform`: `createPlatform` boots a chosen set of subsystems, wired together.
- `@webkrnl/vue`: `useView`, `createWebKrnl`, `usePlatform`, `useUnit`, `useT`, the vue-router route source.
- `@webkrnl/create`: `npm init @webkrnl` writes a Vue or plain TypeScript app with generated tests.
- Page scope ends on a route change: Page-scope subsystems restart as a new page, or handle `pageChange`.
- `pnpm build` (ES modules and declarations in `dist/`), `pnpm release:check`, `pnpm release:version`, `pnpm docs:site` (TypeDoc).
- The whole project is formatted with Prettier, Markdown included.
- Fixed: the kernel stops featurized subsystems before the centralized ones, so a broadcast in delivery does not meet a stopped Notification Center.

### M9: product subsystems

- `@webkrnl/settings`, `@webkrnl/translation` (an ICU MessageFormat subset, compiled in a worker), `@webkrnl/analytics`, `@webkrnl/design-system` (tokens and the theme).
- The tab count in Global State. `src/managers/` is deleted.
- Fixed: persisted state is saved after each change, not only at destroy.

### M8: Global scope

- The Global transport of Realtime, with an outbox, acknowledgements, an HTTP fallback and the Window relay for partitioned browsers.
- `docs/WIRE-PROTOCOL.md`, wire fixtures, and the conformance runner `@webkrnl/realtime/conformance`.
- Every subsystem wipes the data of the signed-in user at sign-out (ARCHITECTURE §5.1).

### M7: connectivity

- `@webkrnl/network`, `@webkrnl/auth`, `@webkrnl/sync` (an outbox with idempotency keys), `@webkrnl/realtime`.

### M6: data

- `@webkrnl/crypto` (non-extractable keys), `@webkrnl/storage` (a coordinator in a shared worker, IndexedDB, OPFS, Cache, Web Storage, memory).

### M5: Window scope

- `@webkrnl/hub`: the hub page on the apex domain, the client and the Window transport.

### M1 to M4: the kernel and the first subsystems

- `@webkrnl/core`: units, the lifecycle, dependencies, packets with fingerprints, scopes, processors on shared, dedicated and virtual hosts, the wire protocol.
- `@webkrnl/global-state`, `@webkrnl/queue`, `@webkrnl/notification`, `@webkrnl/logger`, `@webkrnl/consent`.
