# Plan and Milestones

> **Status:** Agreed — 2026-10-01
> **Depends on:** [`ARCHITECTURE.md`](ARCHITECTURE.md). The section numbers below (§) refer to it.

---

## 1. Principles

1. **Intent before code.** Each milestone starts by updating the documents it touches: `proposals/README.md` amendments, the subsystem's proposal, and `ARCHITECTURE.md`. Code follows the documents. A difference between code and documents is a bug in one of them.
2. **Kernel first.** No subsystem is built or ported until the `Unit` contract exists and one pilot subsystem has proved it.
3. **Port, don't rewrite.** The existing classes in `src/managers/` are tested domain logic. They become the processors and features of the new subsystems. The kernel adds identity, lifecycle, packets, and scopes around them.
4. **Every milestone ends green:** type-check, lint, unit tests, and (from M2 on) browser tests all pass, and the documents match the code.
5. **Every package is documented when it is created.**
   - The package has a `README.md` covering its purpose, installation and peer dependencies, entry points, and usage with examples.
   - The code follows the JSDoc conventions: every file, including barrel (`index.ts`) files, opens with a `@fileoverview`. Every declaration (functions, classes, interfaces, type aliases and constants) has a `@summary`, a `@description`, examples where non-trivial, and the relevant `@template`, `@param`, `@returns`, `@throws` and access tags.
   - Every public member has its own TSDoc block. This applies to the properties, methods, accessors and constructors of classes, to constructor parameter properties, and to the members of interfaces and nested object types. A description on the parent does not count. Each block has a `@summary`. A method block also has its `@param`, `@returns` and `@throws` tags, and an `@example` when the use is not obvious. `pnpm check:docs` finds the members that do not follow this rule (decided 2026-10-02).
   - Each source directory has an `EXAMPLES.md` with runnable, real-world examples for the doc pages, in the format of `docs/EXAMPLES-FORMAT.md`. `pnpm check:examples` runs them (decided 2026-10-03).
   - All prose follows ASD-STE100 Simplified Technical English: documentation, READMEs, TSDoc, commit messages and error messages (decided 2026-10-02).
6. **Each subsystem wipes the data of the signed-in user** that it keeps, in state, persisted state, Storage, memory and processors, when the user signs out or another user signs in (ARCHITECTURE §5.1). Auth only announces. Each README has a **Sign-out** row. (decided 2026-10-04)

---

## 2. Starting point (2026-10-01)

| Area       | State                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repository | A single package, not under git. `src/managers/package.json` declares `@webkrnl/managers`. Both `package.json` files are at version `0.0.1`.                         |
| Code       | 13 managers as standalone classes. None of them exchanges packets: they are joined by constructor closures in `platform.ts`. `IPlatformWorker` is not used anywhere. |
| Bus        | `MessageQueue`, `NotificationCenter`, `NotificationBridge`, `ChannelTransport`, `CorrelationRegistry`, and the envelope/callback packet split exist and are usable.  |
| Tests      | 38 of 49 suites fail to load. There is no vitest config, so the `@/` path alias does not resolve, and `dist/` is collected as tests too.                             |
| Types      | 21 `tsc` errors, mostly unused locals or parameters.                                                                                                                 |
| Proposals  | 22 files. `design-system` is empty.                                                                                                                                  |

### 2.1 Mapping existing code to the new structure

| Existing code                                    | Becomes                                         |
| ------------------------------------------------ | ----------------------------------------------- |
| `packet.dto.ts`, `packet.registry.ts`            | `core`: packets, correlation                    |
| `queue/*`, `bus.ts` (parts)                      | `queue`, `core` (MessageChannel transport)      |
| `notification/*`                                 | `notification`, `hub` (cross-tab bridge)        |
| `global/global-state.manager.ts`, `global/tab/*` | `global-state`                                  |
| `manager.dto.ts`                                 | Replaced by `core` lifecycle (§4)               |
| `libs/*`, `enums/*`, `constants/*`, `types/*`    | `core` (shared), or the package that uses them  |
| each `<name>/<name>.manager.ts`                  | The processors and features of package `<name>` |
| `storage/backends/*`                             | `storage` features (one feature per backend)    |
| `platform.ts`                                    | `platform`                                      |

---

## 3. Milestones

Every milestone has a **gate**: the conditions that must hold before the next one starts.

### Before M0 — Intent

1. Agree on `ARCHITECTURE.md` and this plan.
2. Write the project `README.md` from them, and agree on it.

No code is written until both steps are done.

### M0 — Foundation

_Goal: a trustworthy baseline to build on._

- Initialize git. Add a CI workflow (type-check, lint, test). **Deferred:** the workflow exists, but CI is not run until the repository has a GitHub remote (decided 2026-10-01).
- Add `vitest.config.ts` with the `@/` alias, and exclude `dist/`.
- Fix the 21 `tsc` errors.
- Convert the repo to a pnpm workspace with an empty `packages/` tree. Existing code stays in `src/` until it is ported.
- Add browser tests (Vitest browser mode with Playwright) next to Node tests. Workers, `BroadcastChannel`, and iframes need a real browser. The matrix covers Chromium, Firefox, and WebKit on desktop, and mobile WebKit and Chromium-on-Android profiles (§1.1). Emulated mobile profiles are a first step. Real-device runs are added before 1.0.
- Encode the minimum browser versions (Q6) in a browserslist config and the test matrix.
- Merge amendments A1–A10 (§15) into `proposals/README.md`, after review.

**Gate:** all existing tests pass, `tsc` is clean, `pnpm check` passes locally (CI deferred), and amendments A1–A10 are merged into the README.

### M1 — Kernel (`core`)

_Goal: the contract every subsystem is built on._

- `Unit`, `Subsystem`, `UnitContext`, `Disposer` (§3)
- The lifecycle state machine, with transition guards and events (§4)
- `StateCell` with exposure policy and versioned persistence hooks (§5)
- The control interface: commands and observable views, with stable snapshots and per-task batching (§6, §6.1)
- The `RouteSource` contract, and its default built on the Navigation API and the History API (§11.2.1)
- The dependency resolver: feature-level graph, cycle detection, required/optional, late binding with bounded buffers (§7)
- Packets: envelope, `take()`, bounded fingerprints, `traceId`/`spanId`, the correlation registry (§9)
- `Scope` types and the send-rule checker (§11.2)
- The Global wire-protocol schema (zod), versioned (§11.4)
- A test harness: an in-memory platform that boots units with fake transports

**Gate:** the kernel runs in Node tests with no browser APIs. 100 % of the lifecycle transitions and resolver cases are covered.

### M2 — Runtime: hosts and transports

_Goal: processors run anywhere and packets move between realms._

- The processor module contract (§8.1)
- The virtual host, with its scheduler fallback chain and slice budget (§8.2, §8.6)
- Dedicated and shared hosts, with the worker-entry pattern that bundlers can detect (§14)
- Hybrid failover on all four triggers (§8.3)
- The worker budget (§8.5)
- In-realm and `MessageChannel` transports

**Gate:** in browser tests, one processor runs on all three hosts with identical results. Each failover trigger is tested.

### M3 — Centralized subsystems

_Goal: the bus, rebuilt on the kernel._

- `global-state`: environment detection, derived platform status, tab identity (duplicated-tab safe), pending-work tracking
- `queue`: single entry point, admission, priority scheduling, ordering keys, retry with the existing backoff library, an in-memory dead-letter queue late-bound to Storage, send-rule enforcement
- `notification`: routing, subscriptions, ACL, history. No queue (§10).
- Page and Tab scope broadcast
- Amend the `global`, `queue`, and `notification` proposals (§16)

**Gate:** both flows from the README diagram (1-to-1 and 1-to-many) run end to end in a browser test, with complete fingerprint trails.

### M4 — Pilot: Logger and Consent

_Goal: prove the contract on real subsystems before scaling it._

- `logger`: no required dependencies, a ring buffer late-bound to NotificationCenter and Storage, trace joining by `traceId`
- `consent`: a small featurized subsystem with persisted state and a control interface
- A retrospective. Change the kernel where the pilot found friction, and update `ARCHITECTURE.md`.

**Gate:** both subsystems are ported, their old classes are deleted, and the kernel changes from the retrospective are merged.

### M5 — Window scope: the hub

_Goal: broadcasts across tabs and subdomains._

- **Spike first:** confirm that the hub iframe shares one storage and `BroadcastChannel` partition across subdomains in every supported browser. If it doesn't, stop and revise §11.3. _Done 2026-10-02: WebKit partitions the hub by top-level origin (`spikes/m5-hub/FINDINGS.md`); §11.3 revised by amendment A11._
- `hub`: the static hub page served from the apex, the client, origin allowlists, reconnect handling, and the direct mode for tabs on the apex
- Partition detection (partition id and the apex-domain window cookie), the relay interface with deduplication by `messageId`, and the reported reach (§11.3). The relay is tested against an in-memory double; the real one is the Global transport (M8).
- Scope relays in the kernel: the NotificationCenter hands Window broadcasts to the attached relay, and the Queue ingests envelopes from other tabs
- Deployment notes for the apex: the hub path, `frame-ancestors`, and no `X-Frame-Options` on that path
- The single-origin mode without an iframe
- Move consent to Window scope

**Gate:** a broadcast from `a.<site>` reaches subscribers on `b.<site>` in a multi-origin browser test (through the hub where it is shared, through the relay double where it is partitioned), and the origin checks reject a foreign origin.

### M6 — Data foundation: Crypto and Storage

- `crypto`: shared → dedicated → virtual hosts, key delivery without Network, keys persisted as non-extractable `CryptoKey` objects (ARCHITECTURE §18.1)
- `storage`: the coordinator on a shared worker with the backends inside it (IDB, OPFS, Cache, WebStorage, memory), collections, migrations, quota events, optional Crypto (ARCHITECTURE §18.2)
- Processor configuration and portable functions in the kernel (ARCHITECTURE §8.7, §8.8), and a state persistence adapter for the kernel
- Dead letters and Logger buffers now persist through Storage
- The old Crypto and Storage code in `src/managers` is ported and deleted

**Gate:** with the shared worker killed during a write, storage fails over without data loss (browser test). _Done 2026-10-03: `packages/storage/test/storage.browser.spec.ts` closes the shared worker when it receives a write; the runner runs the write again on the main thread, and every entry is there, in Chrome, Chromium and Edge. WebKit runs the coordinator on the main thread from the start (§18.2)._

**After the gate:** close the three open items of M6 before M7 (ARCHITECTURE §18.3): a key check between Storage and Crypto, query indexes on collections, and a Web Lock that orders the writes of more than one coordinator.

### M7 — Connectivity: Network, Auth, Sync, Realtime

- `network`: retries, deduplication, cache, a circuit breaker, and interceptors that other subsystems add (ARCHITECTURE §19.1)
- `auth`: handlers, tokens, refresh, elevation, permissions, and status in every tab of the site. `hashedPassword` is removed. (§19.2)
- `sync`: entities, a persisted outbox with idempotency keys, intervals, conflict resolution, offline replay by one tab (§19.3)
- `realtime`: a socket in a dedicated worker, reconnect with backoff, heartbeats, topics and presence (§19.4)
- The old Network, Auth, Sync and Realtime code in `src/managers` is ported and deleted

**Gate:** an offline → online scenario completes all queued work with no duplicates, and the user-visible pending work matches the real state throughout. _Done 2026-10-04: `packages/sync/test/gate.spec.ts` (ARCHITECTURE §19.5). Offline work, then online with a `503` and dropped responses: the server applies each change once, and the pending work matches the outbox at every sample._

### M8 — Global scope

- The Global transport as a Realtime feature, with Network fallback (§11.4, §20.1)
- Persistence and replay of outgoing Global packets while offline
- The Window relay (§11.3): the Global transport forwards Window-scope envelopes between connections with the same window id
- Wire-protocol documentation and conformance fixtures that backend teams can run against their own servers (§20.3)
- An in-memory server test double, used only in this repo's tests and never published
- The sign-out wipe (ARCHITECTURE §5.1) in the subsystems that do not follow it yet: Network, Sync, Realtime, Queue and Logger

**Gate:** a Global broadcast survives an offline period and is delivered exactly once per receiver (at least once, plus deduplication). _Done 2026-10-04: `packages/realtime/test/gate.spec.ts` (ARCHITECTURE §20.5). The sender is offline, then reloads, then goes online while the server drops an ack and delivers each envelope twice: each receiver gets the broadcast once. The wire protocol is in `docs/WIRE-PROTOCOL.md`._

### M9 — Product subsystems

- `settings` (§21.1): definitions, persistence, Window sync, optional server handlers, `optimisticUpdate`, the analytics opt-out through Consent
- `translation` (§21.2): an ICU subset parser, compile in a worker, the locale chain, catalogs from options, a loader or a URL, kept in Storage, `Intl` formatting
- `analytics` (§21.3): consent first, session sampling, batches with idempotency keys, an offline outbox, the `pagehide` beacon
- The tab count in Global State (§21.5); the old portal is dropped
- `design-system` (§21.4): write its proposal first, agree it, then build it
- Delete `src/managers/`

**Gate:** all subsystems in the catalogue (§13) are ported, and `src/managers/` is empty. _Done 2026-10-06: every subsystem of the catalogue is a package, and `src/managers/` is deleted. `tests/m9-gate.spec.ts` boots the whole catalogue in one kernel in Node; `tests/m9-gate.browser.spec.ts` runs two tabs in real browsers: a setting in one changes the locale of Translation and the theme of the Design System in the other, and Analytics sends nothing until the analytics grant (ARCHITECTURE §21.6)._

### M10 — Platform, template, release

- The project name **WebKrnl** and the scope `@webkrnl/*` in every package and doc; project-wide Prettier formatting (§22)
- Page scope ends on a route change: the kernel takes a route source (§22.1)
- `@webkrnl/platform`: an orchestrator that boots a chosen set of subsystems (§22.2)
- `@webkrnl/vue`: `useView`, the Vue plugin, `useT`, the `vue-router` route source (§14.1, §22.3)
- `@webkrnl/create`: the scaffolder, with a Vue template and a plain TypeScript template, and generated tests (§22.4)
- Build to `dist/`, fixed-version checks, changelog, documentation site (TypeDoc) (§22.5)

**Gate:** a freshly scaffolded Vue app boots, goes offline, recovers, and passes its generated tests. A plain-TypeScript app does the same without the adapter, which proves the core is framework-agnostic. _Done 2026-10-06: `packages/create/test/gate.e2e.spec.ts` scaffolds both templates against this checkout, installs them, runs their generated tests, builds them with Vite, and in real browsers (Chrome and WebKit) the page reaches `IDLE`, keeps a note in the Sync outbox while offline, and sends it once when online (ARCHITECTURE §22.6)._

### M11 — Core reorganization and cleanup

- Delete `src/` (the root `libs`, `constants`, `enums`, `types`, `modules`, and the root `index.ts`) and its tests (`tests/duration.spec.ts`, `tests/utils-lib.spec.ts`, `tests/utils.test.ts`, `tests/FIXES.md`). Nothing under `packages/*` imports from it.
- Remove `@js-temporal/polyfill`, `lodash` (and `@types/lodash`) and `uuid` from the root `package.json`. None has a reader outside the deleted `src/`.
- Rewrite `packages/core/src/wire.ts`'s validation without `zod` (hand-written checks, the style `settings.ts` and `consent.ts` already use). Add a note to `docs/WIRE-PROTOCOL.md` showing the same schema in Zod, Yup, `@arrirpc/schema` and Joi, for a server team that wants a validation library of its own. `zod` then leaves `packages/core`'s dependencies; it stays only where a package still chooses it for its own tests.
- Reorganize `@webkrnl/core`'s flat `src/*.ts` into logical submodules by ARCHITECTURE section and import coupling (not one folder per file), each with its own `index.ts` and `EXAMPLES.md`, the same pattern `@webkrnl/storage/src/backends/*` already uses.
- Close the standing `FIXES.md` files once their fixes ship with this milestone.

**Gate:** `pnpm check` passes with the reorganized `core`; every other package's `from '@webkrnl/core'` imports are unchanged (the public barrel keeps the same exported names); `check:docs` and `check:examples` pass with one `EXAMPLES.md` per new submodule folder.

### M12 — Browser-API coverage

Candidates for wrapping more non-UI browser APIs behind a subsystem's control interface, as the project already does for `fetch`, `SubtleCrypto`, `BroadcastChannel`, IndexedDB, and `MessageChannel`. Each item needs its own ARCHITECTURE amendment, agreed before code, same as every milestone.

- **Critical** (closes a real gap in an already-shipped subsystem):
  - Permission API → Consent. Real browser permission state (camera, geolocation, notifications) is invisible to the one subsystem whose job is tracking what the user has permitted; an app can show "granted" while the browser has silently blocked the feature.
  - Reporting API → Logger. CSP violations, deprecation warnings and intervention reports are invisible to the one subsystem whose job is catching exactly this class of signal.
- **Upcoming** (a natural widening of a subsystem's documented shape, not a new one):
  - JS Self-Profiling API → Analytics. Matches Analytics' existing shape: sampled, consent-gated, batched.
  - WebTransport → Realtime, as a second pluggable protocol alongside the socket (§19.4 already calls the protocol pluggable).
  - Battery Status and Device Memory → Global State, as two more environment signals of the same shape as `online` and `visible`.
- **Nice-to-have** (small, optional, no subsystem is waiting on it):
  - Cookie Store API → the hub's window/partition cookie (`cookie.ts`), replacing the plain `document.cookie` read; a marginal gain, since nothing currently polls it.
  - Prioritized Task Scheduling API → `core`'s internal `scheduler.ts`, as a possible standards-based replacement; an internal swap, not a new capability for any consumer.
  - A `files` feature wrapping the File System Access API. Speculative; no existing subsystem calls for it, and it is distinct from OPFS (user-gesture-gated, real filesystem paths).
- **Held back** (bigger than a slot in this list; needs its own decision or proposal before it is scheduled anywhere):
  - Background Synchronization API for Sync. The real browser primitive for "retry my outbox when back online even if the tab is closed," but it needs a Service Worker, which nothing in the project has introduced. Adopting it is a bigger decision than the one API suggests.
  - WebAuthn, Credential Management and FedCM for Auth. Each is proposal-sized on its own.

**Gate:** each Critical and Upcoming item has an agreed ARCHITECTURE amendment before any code. Nice-to-have items may be picked up opportunistically without blocking the milestone. Held-back items stay open questions (§6) until decided.

---

## 4. Order of work

```text
Intent ─► M0 ─► M1 ─► M2 ─► M3 ─► M4 ─┬─► M5 ───────────────┐
                                      └─► M6 ─► M7 ─► M8 ─┐   │
                                                          ├───┴─► M9 ─► M10 ─► M11 ─► M12
```

M5 (hub) and M6/M7 can run in parallel after the pilot. M8 needs Realtime (M7) and Storage (M6).

### 4.1 Versioning

All packages share one version. **Milestone gates do not change the version** (decided 2026-10-01): it stays `0.0.2` until every milestone is complete **and** the alpha validation (§4.2) has passed. The next version is decided then.

The monorepo is named **WebKrnl**, and every package is in the npm scope `@webkrnl` (decided 2026-10-06; the placeholder until then was `@platform`).

### 4.2 Alpha validation

After M12, the packages are installed into real applications built with **React, Vue, Svelte and Astro**. Each app exercises boot, offline and recovery, cross-tab and cross-subdomain broadcasts, and the framework bindings (the Vue adapter, and the plain `View` contract elsewhere). Findings are fixed before the first release.

---

## 5. Risks

| Risk                                           | Impact                               | Mitigation                                                  |
| ---------------------------------------------- | ------------------------------------ | ----------------------------------------------------------- |
| Storage partitioning breaks the same-site hub  | Window scope cannot work as designed | Spike at the start of M5, before any hub code               |
| `SharedWorker` is missing in some environments | Origin-wide coordination is lost     | Hybrid failover (§8.3). Every processor has a virtual host. |
| Too many workers on low-end devices            | Memory pressure, slow start          | Worker budget (§8.5)                                        |
| Kernel contract is wrong                       | Every port inherits the defect       | The pilot (M4) is gated, and a retrospective follows it     |
| Wire protocol churn                            | Server and client fall out of step   | The schema is versioned in `core` from M1                   |
| Porting changes behavior                       | Regressions                          | Existing tests are kept and moved with the code             |

---

## 6. Open questions

| #   | Question                                    | Needed by | Answer                                                                                                              |
| --- | ------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------- |
| Q1  | Platforms in scope                          | M0        | Desktop and mobile (Android, iOS) browsers. In-app WebViews are out.                                                |
| Q2  | The npm scope name                          | M0        | Decided 2026-10-06: **WebKrnl**, scope `@webkrnl`.                                                                  |
| Q3  | Reference server, or wire protocol only?    | M1        | Wire protocol only.                                                                                                 |
| Q4  | The hub origin                              | M5        | The apex domain.                                                                                                    |
| Q5  | Framework support                           | M10       | Framework-agnostic core. A Vue adapter first; React to be considered later.                                         |
| Q6  | Minimum browser versions                    | M0        | Desktop browsers and Chrome for Android: the last two major versions. iOS and iPadOS (all browsers): 16.4 or later. |
| Q7  | Is the versioning scheme (§4.1) acceptable? | M0        | Revised: no bumps at milestone gates; release after all milestones and alpha validation (§4.2).                     |
