# WebKrnl

> **Status: pre-alpha (`0.0.2`).** The architecture is agreed. The kernel and its worker runtime (`@webkrnl/core`, M1 and M2), the three centralized subsystems (`@webkrnl/global-state`, `@webkrnl/queue`, `@webkrnl/notification`, M3), the pilot subsystems (`@webkrnl/logger`, `@webkrnl/consent`, M4), Window scope across subdomains (`@webkrnl/hub`, M5), the data foundation (`@webkrnl/crypto`, `@webkrnl/storage`, M6), and connectivity (`@webkrnl/network`, `@webkrnl/auth`, `@webkrnl/sync`, `@webkrnl/realtime`, M7), Global scope (the Global transport of `@webkrnl/realtime` and the [wire protocol](docs/WIRE-PROTOCOL.md), M8), and the product subsystems (`@webkrnl/settings`, `@webkrnl/translation`, `@webkrnl/analytics`, `@webkrnl/design-system`, M9) are built. M10 added the orchestrator (`@webkrnl/platform`), the Vue adapter (`@webkrnl/vue`) and the scaffolder (`npm init @webkrnl`, `@webkrnl/create`). Every milestone is built; the alpha tests in real React, Vue, Svelte and Astro projects come next. Nothing here is ready for production use, and every API shown below may change.
>
> **WebKrnl** is the name of the monorepo. Every package is in the npm scope `@webkrnl` (chosen on 2026-10-06; until then the placeholder was `@platform`).

A framework-agnostic **platform runtime** for browser applications. Your app boots it once and hands it the work that must not fail: storage, network calls, authentication, sync, real-time messaging, and the messages between them.

## Why

Web apps lose their connection, run out of storage, and hit unexpected errors. The platform is designed so that none of these stops critical work:

- **Resilience:** work is queued, persisted, retried, and replayed. A failing part turns itself off without bringing down the rest.
- **Efficiency:** data is deduplicated, cached, compressed, and synced as deltas.
- **Visible, non-blocking remote work:** HTTP, WebSocket, webhook, and RPC operations run off the main thread when possible, and the user can always see what is still pending.

## Core ideas

| Concept                               | In one sentence                                                                                                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Subsystem** (also _manager_)        | An independent part of the platform, such as Storage or Auth, with its own state, lifecycle, and public interface.                                                |
| **Feature**                           | A part of a subsystem that can fail on its own without failing its parent.                                                                                        |
| **Packet**                            | A message between subsystems. It is traced with fingerprints, and its payload is read once per delivery.                                                          |
| **Queue** and **Notification Center** | Every packet enters through the Queue (priority, retry, dead letters). The Notification Center fans broadcasts out to subscribers.                                |
| **Scope**                             | How far a subsystem's broadcasts reach: **Page**, **Tab**, **Window** (all tabs across your site's subdomains), or **Global** (all devices, through your server). |
| **Workers**                           | Each processor runs on a shared worker, a dedicated worker, or the main thread, and falls back automatically when one is not available.                           |

The full design is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Packages (planned)

Each subsystem is its own package. Packages depend on each other through peer dependencies, and optional dependencies turn individual features on or off.

| Package                  | Purpose                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `@webkrnl/core`          | Units, lifecycle, dependency resolution, packets, scopes, worker hosts, the Global wire protocol |
| `@webkrnl/global-state`  | Environment detection, platform status, tab identity, pending work                               |
| `@webkrnl/queue`         | Single entry point for packets: admission, priority, retry, dead letters                         |
| `@webkrnl/notification`  | Broadcast routing, subscriptions, access control                                                 |
| `@webkrnl/logger`        | Logs and traces, buffered from the first moment of boot                                          |
| `@webkrnl/crypto`        | Keys, encryption, signing                                                                        |
| `@webkrnl/storage`       | One schema-validated interface over IndexedDB, OPFS, Cache, Web Storage, and memory              |
| `@webkrnl/consent`       | Consent grants                                                                                   |
| `@webkrnl/settings`      | User settings, with optimistic updates                                                           |
| `@webkrnl/network`       | Requests with retry, deduplication, caching, and interceptors                                    |
| `@webkrnl/auth`          | Tokens, refresh, permissions, elevation                                                          |
| `@webkrnl/sync`          | Server sync with intervals, offline replay, and conflict resolution                              |
| `@webkrnl/realtime`      | WebSocket and SSE connections, and the Global scope transport                                    |
| `@webkrnl/translation`   | Translation catalogs                                                                             |
| `@webkrnl/analytics`     | Consent-gated, sampled analytics                                                                 |
| `@webkrnl/design-system` | Design tokens and the theme: color scheme, contrast, density, motion                             |
| `@webkrnl/hub`           | The page that connects tabs across subdomains (Window scope)                                     |
| `@webkrnl/platform`      | Boots a chosen set of subsystems                                                                 |
| `@webkrnl/vue`           | Vue adapter                                                                                      |
| `@webkrnl/create`        | Project scaffolder: `npm init @webkrnl`                                                          |

## Intended usage

> Illustrative only. These APIs are designed in milestones M1–M10 and may change.

```ts
import { createPlatform } from '@webkrnl/platform';
import { storage } from '@webkrnl/storage';
import { network } from '@webkrnl/network';
import { auth } from '@webkrnl/auth';

const platform = await createPlatform({
  subsystems: [storage(), network(), auth({ refreshFn })],
});

// Every view is a store: read a snapshot, subscribe to changes.
const status = platform.globalState.views.status;
status.subscribe(() => console.log(status.getSnapshot()));
```

With Vue:

```ts
import { createApp } from 'vue';
import { platformPlugin, usePlatform, useView } from '@webkrnl/vue';

createApp(App)
  .use(platformPlugin, { subsystems: [storage(), network()] })
  .mount('#app');

// In a component's setup:
const platform = usePlatform();
const status = useView(platform.globalState.views.status); // Readonly<ShallowRef<...>>
```

The core works without any framework. Views follow the `getSnapshot` and `subscribe` contract, so they also work with React's `useSyncExternalStore` without an adapter.

## Supported platforms

| Platform                              | Minimum version         |
| ------------------------------------- | ----------------------- |
| Desktop Chrome, Edge, Firefox, Safari | Last two major versions |
| Chrome for Android                    | Last two major versions |
| iOS and iPadOS (every browser)        | 16.4                    |

In-app WebViews are not supported. Packages can be imported in server-side rendering but do not run there.

## Deployment notes

- **Window scope** (across subdomains) needs the hub page from `@webkrnl/hub`, served from your **apex** domain. That path must allow your subdomains to frame it: send `Content-Security-Policy: frame-ancestors https://example.com https://*.example.com`, and don't send `X-Frame-Options`.
- **Global scope** needs a server that implements the platform's wire protocol. This project ships the protocol schema and conformance fixtures, not a server.

## Repository layout

```text
docs/            architecture, plan and reports (start here)
docs/proposals/  the original design proposals; docs/proposals/README.md is the authoritative model
tests/           tests that span more than one package (the M9/M10 gates)
packages/        one folder per package
```

Precedence when documents disagree: [`docs/proposals/README.md`](docs/proposals/README.md) > [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) > the per-subsystem proposals.

## Development

Requires [pnpm](https://pnpm.io) 11.

```bash
pnpm install
```

Run every check (type-check, lint, formatting, Node and browser tests):

```bash
pnpm check
```

Browser tests run on every installation listed in [`playwright.config.ts`](playwright.config.ts) that exists on your machine. To see which ones launch, and their executable paths:

```bash
pnpm check:browsers
```

Run a subset with `BROWSERS=chrome,edge pnpm test:browser`, and the multi-origin tests and the scaffolder gate with `BROWSERS=chrome,edge pnpm test:e2e`. If Windows reserved the port of the browser test server (`listen EACCES ... 63315`), move it with `BROWSER_PORT` (for example `BROWSER_PORT=55315`).

Build, release checks and the documentation site:

```bash
pnpm build           # dist/ in every package: ES modules and declarations
pnpm release:check   # one version, publishConfig in sync, npm pack has dist/ and no tests
pnpm docs:site       # TypeDoc into docs-site/
```

Try an app against this checkout:

```bash
node packages/create/src/cli.ts ../try-webkrnl --template vue --local .
```

Changes are in [`CHANGELOG.md`](CHANGELOG.md).

> **CI is deferred.** A GitHub Actions workflow exists in `.github/workflows/ci.yml` but is not enabled yet. Until then, run `pnpm check` locally.

## Roadmap

| Milestone | Delivers                                                 |
| --------- | -------------------------------------------------------- |
| M0        | Tooling, monorepo, browser test matrix (CI deferred)     |
| M1        | Kernel (`core`)                                          |
| M2        | Worker hosts and transports                              |
| M3        | Global State, Queue, Notification Center                 |
| M4        | Pilot: Logger and Consent                                |
| M5        | Window scope hub                                         |
| M6        | Crypto and Storage                                       |
| M7        | Network, Auth, Sync, Realtime                            |
| M8        | Global scope                                             |
| M9        | Translation, Settings, Analytics, Design System          |
| M10       | Orchestrator, Vue adapter, scaffolder; final name chosen |
| Alpha     | Validation in real React, Vue, Svelte and Astro apps     |

Milestones do not change the version: it stays `0.0.2` until every milestone is complete and alpha tests pass in real React, Vue, Svelte and Astro projects. Details and exit criteria are in [`docs/PLAN.md`](docs/PLAN.md).

## License

ISC
