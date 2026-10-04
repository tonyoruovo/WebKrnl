# Week 40 report: 2026-09-28 to 2026-10-04

**Branch:** `staging` on [tonyoruovo/web-subsystem](https://github.com/tonyoruovo/web-subsystem). **Version:** `0.0.2` (pre-alpha, not published).

This report brings you up to date on the work of this week. The work started on 2026-10-01 and has more than 80 commits. This version of the report includes milestones M6, M7 and M8 and the runnable examples (updated 2026-10-04). Read the summary first, then the sections that apply to your work.

## Summary

- We agreed an architecture and a plan before we wrote code. The documents are `docs/ARCHITECTURE.md` and `docs/PLAN.md`.
- We completed milestones M0 to M8 of eleven (M0 to M10). Each milestone has a gate test, and every gate passes.
- The kernel (`@platform/core`) and twelve subsystem packages are built: Global State, Queue, Notification Center, Logger, Consent, the Window-scope hub, Crypto, Storage, Network, Auth, Sync and Realtime.
- M6 added the data foundation. Crypto keeps non-extractable keys in IndexedDB. Storage keeps data in collections, through one coordinator in a shared worker. The details are in [Crypto and Storage (M6)](#crypto-and-storage-m6).
- M7 added connectivity. Network sends requests with retries, a cache and a circuit breaker. Auth keeps the session and its tokens secret. Sync gets offline changes to the server exactly once. Realtime keeps one socket in a worker. The details are in [Connectivity (M7)](#connectivity-m7).
- M8 added Global scope. A Global broadcast reaches the other devices and sessions of the user through your server, also after an offline period, and each receiver gets it once. The same transport relays Window scope on Safari and iOS. `docs/WIRE-PROTOCOL.md` is the contract for backend teams, with fixtures and a conformance runner. The details are in [Global scope (M8)](#global-scope-m8).
- Each subsystem wipes the data of the signed-in user at sign-out or when another user signs in (ARCHITECTURE §5.1).
- Functions can now cross worker boundaries as portable functions, so a migration or a filter can run in the worker.
- Every source folder has an `EXAMPLES.md` with runnable examples (83 examples). A doc compiler can turn them into code sandboxes. A script runs each one and compares its output.
- A spike found that Safari and all iOS browsers partition the cross-subdomain hub. We changed the design (amendment A11). The details are in [Window scope across subdomains](#window-scope-across-subdomains).
- Every public member of every interface and class now has its own TSDoc block. A script enforces this rule.
- All prose now uses ASD-STE100 Simplified Technical English (STE). This report also uses it.

## Where to start reading

| Read this | To learn |
|---|---|
| [`README.md`](../../../README.md) | The purpose of the project, the packages and the status |
| [`proposals/README.md`](../../../proposals/README.md) | The original definitions. This document has precedence over all others. |
| [`docs/ARCHITECTURE.md`](../../ARCHITECTURE.md) | The design. §15 lists amendments A1 to A11. §17 is the M4 retrospective. §8.7, §8.8 and §18 are the M6 design. §19 is the M7 design. §20 is the M8 design. §5.1 is the sign-out rule. |
| [`docs/WIRE-PROTOCOL.md`](../../WIRE-PROTOCOL.md) | The Global wire protocol, for backend teams |
| [`docs/PLAN.md`](../../PLAN.md) | The milestones, their gates, and the working principles |
| `packages/<name>/README.md` | How to use each package |
| `packages/<name>/src/**/EXAMPLES.md` | Runnable examples for each source folder |
| [`docs/EXAMPLES-FORMAT.md`](../../EXAMPLES-FORMAT.md) | The format of the examples, for authors and for the doc compiler |
| [`spikes/m5-hub/FINDINGS.md`](../../../spikes/m5-hub/FINDINGS.md) | The browser test that changed Window scope |

## Decisions made this week

| Topic | Decision |
|---|---|
| Send rule | Scope limits apply to broadcasts only. A 1-to-1 request can go to any scope, and its reply always returns. (A1) |
| Window scope | It spans the subdomains of one site, through a hub page on the apex domain. Where a browser partitions the hub, the Global transport relays. (A2, A11) |
| Global scope | It is server-backed. The project ships only the wire protocol, not a server. (A3) |
| Tracing | Tabs and devices join trails by `traceId`. Receivers do not send fingerprints back. (A4) |
| Unit model and lifecycle | Subsystems and features share one `Unit` model and one lifecycle. The lifecycle includes `DEGRADED` and `SUSPENDED`. (A5 to A9) |
| Queue | All packets enter through the Queue. The Notification Center routes broadcasts and holds no queue. (A10) |
| Platforms | Desktop browsers, and Android and iOS browsers. In-app WebViews are out of scope. Minimum versions are in ARCHITECTURE §1.1. |
| Frameworks | The core is framework-agnostic. A Vue adapter comes first (M10). A React adapter comes later. |
| Package scope | `@platform` is a placeholder until M9. |
| Version | The version stays `0.0.2`. Milestone gates do not change it. A release comes only after M10 and an alpha test in real React, Vue, Svelte and Astro projects. |
| CI | GitHub Actions is deferred. Run `pnpm check` on your machine before you push. |
| Documentation | Every package has a README. Every source folder has an `EXAMPLES.md`. Every public member has its own TSDoc block. All prose uses STE. |
| Functions across workers | A processor can get functions from its caller as portable functions (source text, rebuilt in the worker). They must be self-contained. Under a strict CSP, the worker refuses and the work runs on the main thread. |
| Storage pipeline | The Storage coordinator runs the full pipeline (serialize, compress, encrypt, migrate). The caller validates with the full schema in its own realm. |
| Storage hosts | Shared worker, then main thread. No dedicated worker, because it would add a writer for no gain. |
| Crypto and Storage keys | Storage opens the key store of Crypto itself. Both use the same keys and the same token format, with no message between them. A key check finds a mismatch. |
| Network host | The main thread only. A response body is a stream that callers need in their own realm. |
| Network and Auth | Auth adds its interceptor to Network, so Network does not depend on Auth. The token goes only to protected origins. |
| Auth handlers | The app gives `login`, `refresh`, `logout` and `elevate`. Auth does not know the credentials, so MFA, OAuth and passkeys stay in the app. Tokens are never in unit state. |
| Exactly once | Sync gives each change a stable id, sent as `Idempotency-Key`. A change leaves the outbox only after the server confirms it. One tab replays a shared outbox (Web Lock). |
| Pending work of Sync | One Global State entry for each entity type, with the count, so a long offline outbox does not make the platform `BUSY`. |
| Realtime | The socket runs in a dedicated worker. The protocol is pluggable. The Global transport is a feature of it (M8). |
| Data of the signed-in user | Each subsystem wipes its own user data (state, persisted state, Storage, memory, processors) at sign-out or when another user signs in. `watchSignOut` of `@platform/core` gives the signal. (ARCHITECTURE §5.1) |
| Global delivery | At least once from the server: an outbox that keeps each envelope until the server acknowledges it. Exactly once for each receiver: the Queue drops repeats by `messageId`. The server does not keep messages for offline receivers. |

## Milestones

| Milestone | Content | Gate |
|---|---|---|
| M0 | Tooling: pnpm workspace, TypeScript 7 with TypeScript 6 for lint, ESLint 10, Vitest 4, Playwright browser matrix | Type-check, lint and tests pass |
| M1 | The kernel: units, lifecycle, state, views, dependencies, packets, scopes, wire protocol, test platform | 100% coverage of the lifecycle and the dependency graph |
| M2 | Processors and hosts: shared worker, dedicated worker and main thread, with failover | One processor runs on all three hosts in real browsers. Each failover trigger is tested. |
| M3 | Global State, Queue and Notification Center | The 1-to-1 and 1-to-many flows run end to end with complete fingerprint trails |
| M4 | Pilot subsystems: Logger and Consent, and a retrospective | Both are ported, the old classes are deleted, and the kernel changes are merged |
| M5 | Window scope: the hub, the client and the transport. Consent moves to Window scope. | A broadcast from `a.<site>` reaches `b.<site>` in real browsers, and a foreign origin is refused |
| M6 | Crypto and Storage. Processor configuration and portable functions in the kernel. Dead letters and log entries persist. | The shared worker dies during a write, and no data is lost |
| M7 | Network, Auth, Sync and Realtime | Offline work goes online with failures; every change is applied once, and the pending work matches the outbox at every step |
| M8 | Global scope: the Global transport, the Window relay, the wire protocol document, fixtures and conformance runner, and the sign-out wipe | A Global broadcast survives an offline period and a reload, and each receiver gets it once while the server drops an ack and delivers twice |

The next milestones are M9 (Translation, Settings, Analytics, Design System) and M10 (orchestrator, Vue adapter, scaffolder).

## The packages

All packages are in `packages/`. Each one has a README and tests.

| Package | What it does |
|---|---|
| `@platform/core` | The kernel. It runs the lifecycle of each unit, checks dependencies, moves packets, and runs processors in workers or on the main thread. It also has `@platform/core/testing` and `@platform/core/worker`. |
| `@platform/global-state` | Finds the platform status (`INITIALIZING`, `IDLE`, `BUSY`, `DEGRADED`) from the lifecycles of all units. It tracks pending work, admission, the online and visible states, and the tab identity. |
| `@platform/queue` | The packet router of the kernel. It does admission, priorities, ordering keys, retries with backoff, dead letters, and the intake of broadcasts from other tabs. |
| `@platform/notification` | Routes broadcasts. It has an event registry with access control, subscriptions, a circuit breaker for each subscriber, a history, and scope relays. |
| `@platform/logger` | Keeps log entries with sanitized context and level filters. It records every packet trail, and joins trails and entries by `traceId`. |
| `@platform/consent` | Records consent decisions for each category under a policy version, and gates telemetry. It fails closed. All tabs of a site share the decisions. |
| `@platform/hub` | Window scope: the hub page for the apex, the client in each tab, partition detection, and the `window` transport subsystem. |
| `@platform/crypto` | Keys and the operations that use them: AES-GCM encryption, HMAC tags, ECDSA signatures, digests, rotation and crypto-shredding. Keys persist in IndexedDB and cannot be read. |
| `@platform/storage` | Collections over IndexedDB, OPFS, Cache, Web Storage and memory. Validation, encryption, compression, migrations, batches, query indexes, change events in every tab, a quota monitor, and the kernel persistence adapter. |
| `@platform/network` | Requests with timeouts, retries, one fetch for identical requests, priorities, a cache with ETags, a circuit breaker for each origin, interceptors, and offline failures. |
| `@platform/auth` | The session from app handlers, token refresh (also on a 401), permissions, roles, elevations, a login lockout, and the status in every tab of the site. |
| `@platform/sync` | Entities, a persisted outbox with idempotency keys, conflicts, pulls with cursors, permanent and transient failures, and offline replay. |
| `@platform/realtime` | One WebSocket in a dedicated worker for many topics: reconnects, heartbeats, a publish buffer, presence, and the Auth token. |

The old code in `src/managers` stays until each subsystem is ported. The old Logger, Consent, Crypto, Storage, Network, Auth, Sync and Realtime code is deleted. The old Global State, Queue and Notification managers are still in `src/managers`.

## How a packet moves

```text
  subsystem: ctx.port.send(...) or ctx.port.request(...)
     |
     v
  Queue (router)        send rule, admission (Global State), depth limit,
     |                  priority tiers, ordering keys, retries, dead letters
     |
     +-- request -----> kernel.deliver --> target receive() --> reply
     |
     +-- broadcast ---> Notification Center fan-out --> each subscriber
                             |
                             +-- Window scope --> scope relay --> hub (and the Global relay where needed)
                                                                    |
  other tab: hub --> Window transport --> Queue.ingest --> fan-out in that tab
```

Every step adds a fingerprint to the trail of the packet. The Queue and the Notification Center push each record to observers, and the Logger keeps them.

## Window scope across subdomains

Window scope must reach all tabs of one site, for example `a.example.com` and `b.example.com`. These are different origins, so the design puts a hub page on the apex (`example.com`) and frames it from each subdomain.

The plan required a spike before we built the hub. The spike tested real browsers with Playwright:

- Chrome, Edge and Chromium give all framed copies of the hub one partition. The design works.
- WebKit partitions the `BroadcastChannel`, IndexedDB and `SharedWorker` of the hub by the top-level origin. Safari and every iOS browser use WebKit. On these browsers, the hub cannot join `a.` and `b.`.
- Firefox did not run on the development machine. Firefox keys partitions by site, so we expect it to behave like Chrome. This is not verified.

The product owner chose the "hub plus server fallback" design (amendment A11):

1. The client finds out if the hub is shared. It compares a random partition id through a session cookie on the apex domain.
2. While the hub is not known to be shared, the client also sends Window broadcasts through a relay. The relay is the Global transport, which comes in M8.
3. Receivers drop repeats by `messageId`.
4. The client reports its reach: `site`, `origin` or `unknown`.

Until M8 delivers the relay, Window scope on Safari and iOS reaches only the tabs of one origin. The apex must serve the hub page with the CSP header that `renderHubPage` gives, and without `X-Frame-Options`. The `@platform/hub` README has the deployment steps.

## Crypto and Storage (M6)

```text
  tab (main thread)                     Storage coordinator (shared worker, else the main thread)
  collection.set(key, value)            one writer for the origin, one request at a time
    validate (full schema)              backends: indexeddb --> opfs --> cache (--> localstorage --> sessionstorage --> memory)
    --> value + portable functions -->  serialize --> gzip? --> AES-GCM + HMAC? --> backend
  collection.get(key) <-- value ------  backend --> verify --> decrypt --> gunzip --> parse --> migrate (and write back)
  change --> BroadcastChannel --> every tab --> 'storage:changed'
```

- **Crypto** runs in a shared worker, then a dedicated worker, then the main thread. Keys are non-extractable `CryptoKey` objects in IndexedDB, so every tab, worker and session uses the same keys. `rotate` keeps old keys. `forget` deletes them, so old data can never be read again.
- **Storage** chooses its backend in `setup`. A worker without a persistent backend, or a worker that cannot run portable functions or open the keys, refuses. The runner then moves the coordinator to the main thread.
- **Portable functions** (core): `toPortable` turns functions into source text, and `fromPortable` rebuilds them in the worker. In the same realm, the original function comes back. Migrations, serializers, `where` filters and eviction comparators use this.
- **Processor configuration** (core): a processor definition can carry a `config`. Each host gives it to `setup`. Crypto and Storage get their key source and database this way.
- **Late binding.** The Queue keeps its dead letters, and the Logger its entries, in Storage collections when Storage runs. Both survive a reload. Neither package imports `@platform/storage`: they use small structural interfaces and `ctx.watch`.
- **Kernel persistence.** `createStatePersistence()` is the kernel's `persistence` option. It uses IndexedDB directly, because the kernel loads state before Storage runs.

What the tests found:

| Finding | Result |
|---|---|
| WebKit cannot store a `CryptoKey` in IndexedDB from a shared worker ("The object can not be cloned") | Crypto runs in a dedicated worker there. Storage runs its coordinator on the main thread there. |
| The IndexedDB and OPFS backends dropped `envelope.integrity` | Every encrypted entry read as corrupt. Both backends keep it now (see their `FIXES.md`). |
| The scheduler's `MessageChannel` port did not keep Node alive while tasks waited | Found by the examples checker. The port now holds a reference while tasks wait. |
| A Consent example waited 50 ms for another tab | Too short on a slow machine. It waits 500 ms now. |

## Connectivity (M7)

```text
  app --> network.request() --> retries, cache, breaker, interceptors --> fetch
            ^ Auth interceptor: token for protected origins, refresh once on 401
  app --> todos.update() --> Sync outbox (Storage) --> online? push through Network (Idempotency-Key)
                                 |                       server confirms --> leaves the outbox
                                 +--> Global State pending work: "3 changes to todos waiting"
  app --> realtime.subscribe() --> socket processor (dedicated worker) --> server; reconnect, heartbeat
```

- **Network** runs on the main thread. A request fails at once when offline (unless the cache answers), so Sync, not Network, keeps work for later.
- **Auth** keeps the session in an encrypted Storage collection. Two tabs never refresh at the same time: a Web Lock, and a check of the stored session first. Rotating refresh tokens need this.
- **Sync** merges two waiting changes of one entity only when the first was never sent. A sent change may be applied already, and its idempotency key must keep its data.
- **Realtime** subscribes every topic again after a reconnect, so listeners do nothing.

What the tests found:

| Finding | Result |
|---|---|
| The outbox reloaded from Storage while a new change was written, and dropped the change | Found by the gate test. Every outbox operation now runs in one queue, and `record` reads, merges and writes in one exclusive step. |
| Sync teardown left a run in flight, which then used a stopped Storage | The disposer waits for the run. |
| A later empty run cleared the error while a failed change was still in the outbox | The status comes from the outbox: `ERROR` while failed changes exist. |
| An outbox change for each pending-work entry would make a long offline outbox look like a busy platform | One entry for each entity type, with the count. |

## Global scope (M8)

```text
  this tab:   port.send (Global) --> Notification Center --> realtime/global outbox (memory + Storage)
                --> socket: publish on platform:global --> server --> ack --> leaves the outbox
                --> no socket: POST <http>/publish through Network
  other device: server --> message on platform:global --> decodeWire --> Queue.ingest (drops repeats) --> subscribers
```

- **The Global transport** is the feature `realtime/global` of Realtime (option `global`). It uses the socket of Realtime and two reserved topics, `platform:global` and `platform:window:<windowId>`.
- **The outbox** keeps each envelope until the server acknowledges it. It sends again after `ackTimeoutMs` or a reconnect, and drops expired envelopes. It is in Storage, so it survives a reload.
- **The HTTP fallback** publishes and long-polls through Network while the socket cannot open.
- **The Window relay**: the window transport of `@platform/hub` takes it from Realtime by itself. On Safari and iOS, Window scope now reaches every subdomain of the site.
- **For backend teams**: `docs/WIRE-PROTOCOL.md` (envelope, frames, ack, HTTP endpoints, audience rules), the fixtures in `@platform/core/fixtures/wire`, and `runConformance` in `@platform/realtime/conformance`. The conformance runner passes against the in-memory test server in Node and against the WebSocket test server in Chrome and WebKit.
- **Sign-out**: Network, Sync, Realtime, Queue and Logger now wipe the data of the user, as Auth, Storage and Consent did. `createTestAuth` of `@platform/core/testing` tests it.

What the tests found:

| Finding | Result |
|---|---|
| Writes in flight on the main-thread host were lost when the kernel stopped | The virtual host waits for its calls before it stops. The Storage coordinator waits for its queue before it closes the database. |
| A poll gave a tab its own Global broadcast back | Each tab drops the envelopes that it sent. |
| Auth restored a session after a sign-out that came first | Auth counts sign-outs and drops a restore that one overtook. |
| A Network cache read during the wipe filled the memory cache again | Cache reads and writes wait for the wipe. |

## Runnable examples

Every source folder of a package has an `EXAMPLES.md`. Each example is a small real-world case with its expected output. `docs/EXAMPLES-FORMAT.md` is the contract for the doc compiler.

- `runtime="any"` examples run in Node and in Chrome. `runtime="browser"` examples run in Chrome. `runtime="none"` examples are shown but not run.
- `pnpm check:examples` type-checks every example, runs it, and compares the output. It is part of `pnpm check`.
- Examples import only `@platform/*` packages, so a sandbox needs nothing else.

## Kernel changes from the M4 retrospective

The pilot subsystems showed some problems in the unit contract. We changed the kernel:

| Problem | Change |
|---|---|
| A unit could not see when a dependency started later | `ctx.watch(target, listener)` |
| Recovered errors had nowhere to go but the console | `ctx.report(error)` sends them to the `onError` option of the kernel |
| Views are snapshots, so a log built on them lost records | `observe` commands on the Queue and the Notification Center push each record |
| Bounded lists copied the full array on each change | `createRingBuffer` makes the snapshot only when it is read |

## Tools and commands

Run these from the root of the repository:

| Command | What it does |
|---|---|
| `pnpm install` | Installs the workspace |
| `pnpm check` | Type-check, lint, format check, `check:docs`, `check:examples`, and all tests. Run it before you push. |
| `pnpm verify` | Type-check, lint, format check and `check:docs`. Run it before each commit. |
| `pnpm test:node` | Node tests (1128 tests) |
| `pnpm test:browser` | Browser tests, one project for each installed browser |
| `pnpm test:e2e` | Multi-origin tests with Playwright, for example the Window-scope gate |
| `pnpm check:docs` | Lists public members whose TSDoc block is missing or incomplete |
| `pnpm check:examples` | Runs every example and compares its output. `--only=<id prefix>` runs some of them. |
| `pnpm check:browsers` | Starts each browser installation and reports which ones work |
| `node spikes/m5-hub/spike.ts` | Runs the partition spike again |

`playwright.config.ts` lists each browser installation with its path. Use `BROWSERS=chrome,webkit` to run a subset. On the development machine, use `BROWSERS=chrome,system-chromium,edge,webkit,mobile-webkit`.

## Conventions

- **Documentation before code.** We agree the architecture and the plan before we build a milestone.
- **Commit as you go.** Work happens on `staging`. Commits are small and have a clear message.
- **`FIXES.md`.** When you fix a bug in old code, add a `FIXES.md` to the folder of the fixed files. We delete these files when the pull request merges.
- **TSDoc.** Every file starts with a `@fileoverview`. Every declaration and every public member has its own block with a `@summary`. Methods also have `@param`, `@returns`, `@throws` and an `@example`.
- **Prose.** Use STE: active voice, short sentences, no semicolons, no contractions, and plain words.
- **Markdown in `docs/` and `proposals/`.** These files are formatted by hand. Do not run Prettier on them.
- **Examples.** Every source folder has an `EXAMPLES.md`. Print only strings, numbers and booleans, and use `JSON.stringify` for objects.
- **Checks before a commit.** Read the exit code of each check. A pipe such as `| tail` hides a failure.

## Known problems and open items

The decisions of 2026-10-04 are in **bold**.

1. Playwright's own Chromium and Firefox builds do not start on the development machine (`spawn UNKNOWN`). The installed Chrome, Edge, Chromium and WebKit work. Firefox is not tested yet. **Deferred.**
2. Real Safari is not tested. Playwright's WebKit is the closest available proxy on Windows. **Deferred.**
3. CI is deferred. A GitHub Actions workflow exists but is not on. **Deferred.**
4. Closed in M8: on Safari and iOS, Window scope reaches every subdomain through the Window relay of the Global transport, when Realtime runs with the option `global`. Without it, Window scope reaches one origin.
5. The iframe link and the hub page run only in real browsers, so the Node coverage of `@platform/hub` is about 70%. The e2e gate tests them. **Deferred: a manual browser test at the end of the milestones covers them.**
6. Some older methods, mainly on `Kernel`, have no `@example` yet. Older prose is not yet in STE. **Deferred.**
7. The old managers in `src/managers` stay until their milestones port them. **Confirmed.**
8. Closed after M6 (ARCHITECTURE §18.3): on WebKit, every tab runs its own Storage coordinator. Each request now runs in a Web Lock of the database, so the writes of all tabs keep one order. **Accepted.**
9. Closed after M6: Storage compares its key ids with the state of Crypto (`keyCheck`). On a mismatch it reports a `KeyMismatchError` and refuses encrypted writes. **Accepted.**
10. Closed after M6: collections can declare query indexes, and `lookup(index, value)` reads only the matching entries. Encrypted collections index an HMAC of each value. Range queries are not supported yet. **Accepted.**
11. Closed: cached responses that the Network keeps in Storage are **encrypted by default**, and compression is an option (`persistCache: { encrypt, compress }`, and `cachePersist` for one request). A call site can turn off either step to save its time, or keep a response in memory only. A response is never stored in plain text when encryption is not possible (ARCHITECTURE §19.1).
12. Closed before M8: a tab on another subdomain signs in with the optional `restore` handler. The server keeps an `HttpOnly; Secure; SameSite=Lax` session cookie on the apex domain, and `restore` gets a session for this origin with it. Tokens never travel between tabs. A restore that a sign-out overtakes is dropped (ARCHITECTURE §19.2). The READMEs of Auth, Network, Sync, Realtime, Storage, Crypto and the hub have a **Recommended flow** section for tokens, cookies, caching and transport.
13. Closed: Web Locks exist in every supported browser (Safari 15.4 and later; ARCHITECTURE §1.1 asks for iOS 16.4). Without them, the fallback stays as it is: two tabs can push the same change, and the idempotency key keeps the server from applying it twice. The Sync, Auth and Storage READMEs describe the fallback.

## Next steps

M9 adds the product subsystems: Translation, Settings, Analytics and the Design System. A manual browser test of the Window relay on real Safari and iOS stays open (items 2 and 5).
