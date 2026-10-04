/**
 * @fileoverview
 * @summary The Sync subsystem: an outbox of changes that reaches the server exactly once, pulls, and conflicts.
 *
 * @description
 * `createSync` gives the subsystem `sync` (featurized, Tab scope). Network is
 * required. Storage is late-bound (docs/ARCHITECTURE.md §19.3).
 *
 * ```text
 *   todos.update(id, data) --> outbox (merge with a waiting change that was never sent)
 *                          --> pending work in Global State: one entry for each entity type, with the count
 *   run (online, inside the Web Lock 'platform-sync:<name>', one tab at a time)
 *     each waiting change, oldest first:  attempts + 1 (stored) --> push(change, { network })
 *       ok          --> delete from the outbox
 *       conflict    --> server-wins | client-wins | merge | manual
 *       transient   --> keep; later changes of the same entity wait; retry with backoff
 *       permanent   --> state 'failed', 'sync:failed'
 *     pull(cursor) --> apply each change --> keep the cursor
 *   triggers: a change while online, back online, syncNow(), the interval (while visible), start
 *   ```
 *
 * @example
 * Starting Sync
 * ```ts
 * const kernel = new Kernel([createNetwork(), createStorage(), createSync()]);
 * await kernel.start();
 * const todos = kernel.unit<SyncControl>(SYNC_ID).control!.commands.entity<Todo>({ name: 'todos', push });
 * ```
 *
 * @author MathAid
 */

import {
  computeBackoff,
  defineSubsystem,
  type ControlInterface,
  type Importance,
  type SubsystemDefinition,
  type UnitContext,
  type View,
} from '@platform/core';

import { Outbox, mergeOps, type OutboxStore } from './outbox';
import type {
  Change,
  ChangeOp,
  EntityDefinition,
  EntityHandle,
  SyncControl,
  SyncData,
  SyncFailed,
  SyncNetwork,
  SyncOptions,
  SyncReport,
} from './types';

/**
 * @summary The id of the Sync subsystem.
 * @public
 */
export const SYNC_ID = 'sync';

/**
 * @summary The Tab broadcast after each run that did something. The payload is a {@linkcode SyncReport}.
 * @public
 */
export const SYNC_COMPLETED = 'sync:completed';

/**
 * @summary The Tab broadcast when a change fails for good. The payload is a {@linkcode SyncFailed}.
 * @public
 */
export const SYNC_FAILED = 'sync:failed';

/**
 * @summary Tells if a push error is permanent: a `status` of 4xx, except 408, 425 and 429.
 * @example
 * Example 1: A validation error
 * ```ts
 * isPermanent({ status: 422 }); // true
 * ```
 * @example
 * Example 2: Offline
 * ```ts
 * isPermanent(new OfflineError('offline', 'r1')); // false
 * ```
 * @param {unknown} error The error.
 * @returns {boolean} `true` when sending the change again cannot work.
 * @public
 */
export function isPermanent(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return (
    typeof status === 'number' && status >= 400 && status < 500 && ![408, 425, 429].includes(status)
  );
}

/** The part of Global State that Sync uses. It does not import the package. */
interface GlobalStateLike extends ControlInterface {
  readonly commands: {
    beginWork(work: {
      id: string;
      subsystemId: string;
      importance: Importance;
      label?: string;
    }): boolean;
    endWork(id: string): void;
  };
  readonly views: {
    readonly state: View<{ readonly online?: boolean; readonly visible?: boolean }>;
  };
}

/** The part of a Storage collection that Sync uses. */
interface SyncStore extends OutboxStore {
  subscribe(listener: (change: { remote: boolean }) => void): () => void;
}

/** The part of a Storage collection that keeps the pull cursors. */
interface CursorStore {
  get(key: string): Promise<{ cursor: string | null } | undefined>;
  set(key: string, value: { cursor: string | null }): Promise<void>;
}

/** The part of Storage that Sync uses. */
interface StorageLike extends ControlInterface {
  readonly commands: {
    collection(definition: { name: string }): unknown;
  };
}

/**
 * @summary Makes the Sync subsystem.
 *
 * @example
 * Example 1: An app
 * ```ts
 * new Kernel([createGlobalState(), createNetwork(), createStorage(), createSync({ intervalMs: 60_000 })]);
 * ```
 *
 * @example
 * Example 2: A test
 * ```ts
 * createSync({ intervalMs: false, retryBaseMs: 1 });
 * ```
 *
 * @param {SyncOptions} [options] The interval, the backoff, the name of the outbox, the clock and the ids.
 * @returns {SubsystemDefinition<SyncData, SyncControl>} The definition, for the kernel.
 * @public
 */
export function createSync(options: SyncOptions = {}): SubsystemDefinition<SyncData, SyncControl> {
  const now = options.now ?? Date.now;
  const ids = options.ids ?? (() => crypto.randomUUID());
  const name = options.name ?? 'default';
  const entities = new Map<string, EntityDefinition<unknown>>();
  const cursors = new Map<string, string | null>();
  let cursorStore: CursorStore | null = null;
  let context: UnitContext<SyncData> | null = null;
  let online = true;
  let visible = true;
  let paused = false;
  let running: Promise<SyncReport> | null = null;
  let again: Promise<SyncReport> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryRound = 0;
  let seq = 0;
  const shown = new Map<string, number>();

  /** Shows the outbox as pending work: one entry for each entity type, with the count. */
  const showPending = () => {
    const ctx = context;
    if (!ctx) return;
    const waiting = outbox.list().filter((c) => c.state === 'waiting');
    const counts = new Map<string, number>();
    for (const change of waiting) counts.set(change.entity, (counts.get(change.entity) ?? 0) + 1);
    const globalState = ctx.dependency<GlobalStateLike>('global-state');
    for (const entity of new Set([...shown.keys(), ...counts.keys()])) {
      const count = counts.get(entity) ?? 0;
      if (shown.get(entity) === count) continue;
      const id = `sync:${entity}`;
      if (shown.has(entity)) globalState?.commands.endWork(id);
      shown.delete(entity);
      if (count > 0 && globalState) {
        globalState.commands.beginWork({
          id,
          subsystemId: SYNC_ID,
          importance: 'CRITICAL',
          label: `${count} change${count === 1 ? '' : 's'} to ${entity} waiting`,
        });
        shown.set(entity, count);
      }
    }
    const all = outbox.list();
    ctx.state.update((s) => {
      s.pending = waiting.length;
      s.failed = all.filter((c) => c.state === 'failed').length;
      s.conflicts = all.filter((c) => c.state === 'conflict').length;
      s.persistent = outbox.persistent;
      if (s.failed === 0) s.lastError = null;
      if (s.status !== 'SYNCING')
        s.status = paused ? 'PAUSED' : !online ? 'OFFLINE' : s.failed > 0 ? 'ERROR' : 'IDLE';
    });
  };
  const outbox = new Outbox(showPending);

  const network = () => {
    const control = context?.dependency<{
      commands: SyncNetwork['commands'];
      views: Record<string, View<unknown>>;
    }>('network');
    if (!control) throw new Error('[sync] The Network does not run.');
    return { commands: control.commands } as SyncNetwork;
  };

  async function record(
    entity: string,
    entityId: string,
    op: ChangeOp,
    data: unknown,
  ): Promise<Change | null> {
    const result = await outbox.exclusive(async (edit) => {
      const waiting = edit
        .list()
        .filter((c) => c.entity === entity && c.entityId === entityId && c.state === 'waiting');
      const last = waiting.at(-1);
      // Merge only into a change that was never sent: a sent change may be applied already.
      if (last && last.attempts === 0) {
        const merged = mergeOps(last.op, op);
        if (merged === null) {
          await edit.delete(last.id);
          return null;
        }
        const change: Change = { ...last, op: merged, data: merged === 'delete' ? null : data };
        await edit.put(change);
        return change;
      }
      const change: Change = {
        id: ids(),
        entity,
        entityId,
        op,
        data: op === 'delete' ? null : data,
        createdAt: now(),
        seq: seq++,
        attempts: 0,
        state: 'waiting',
        force: false,
        error: null,
      };
      await edit.put(change);
      return change;
    });
    kick();
    return result;
  }

  /** Starts a run soon, when that can do something. */
  function kick() {
    if (!online || paused || !context) return;
    queueMicrotask(
      () => void run({ pull: false }).catch((error: unknown) => context?.report(error)),
    );
  }

  function fail(change: Change, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const ctx = context;
    ctx?.report(error);
    ctx?.state.update(
      (s) => void (s.lastError = `[sync] ${change.entity}/${change.entityId}: ${message}`),
    );
    const payload: SyncFailed = {
      changeId: change.id,
      entity: change.entity,
      entityId: change.entityId,
      error: message,
    };
    ctx?.port
      .send({ eventId: SYNC_FAILED, payload, importance: 'HIGH' })
      .catch((e: unknown) => ctx.report(e));
    return outbox.put({ ...change, state: 'failed', error: message });
  }

  async function pushAll(): Promise<{ pushed: number; failed: number; transient: boolean }> {
    let pushed = 0;
    let failed = 0;
    let transient = false;
    const blocked = new Set<string>();
    for (const listed of outbox.list()) {
      if (!online || paused) {
        transient = true;
        break;
      }
      const current = outbox.get(listed.id);
      if (!current || current.state !== 'waiting') continue;
      const definition = entities.get(current.entity);
      const key = `${current.entity}/${current.entityId}`;
      if (!definition || blocked.has(key)) continue;
      // Store the attempt first: from now on, this change never merges with a new one.
      let change: Change = { ...current, attempts: current.attempts + 1 };
      await outbox.put(change);
      for (let round = 0; ; round++) {
        try {
          const result = await definition.push(change, { network: network() });
          if (!result || !('conflict' in result)) {
            await outbox.delete(change.id);
            pushed++;
            break;
          }
          const remote = result.conflict;
          const strategy = round > 0 ? 'manual' : (definition.conflict ?? 'server-wins');
          if (strategy === 'server-wins') {
            await definition.apply?.({ entityId: change.entityId, op: 'upsert', data: remote });
            await outbox.delete(change.id);
            break;
          }
          if (strategy === 'manual' || (strategy === 'merge' && !definition.merge)) {
            await outbox.put({ ...change, state: 'conflict', remote });
            break;
          }
          const data =
            strategy === 'merge' ? definition.merge!(change.data as never, remote) : change.data;
          change = { ...change, data, force: true, attempts: change.attempts + 1 };
          await outbox.put(change);
        } catch (error) {
          if (isPermanent(error)) {
            await fail(change, error);
            failed++;
          } else {
            transient = true;
            blocked.add(key);
            const message = error instanceof Error ? error.message : String(error);
            await outbox.put({ ...change, error: message });
          }
          break;
        }
      }
    }
    return { pushed, failed, transient };
  }

  async function pullAll(): Promise<number> {
    let pulled = 0;
    for (const definition of entities.values()) {
      if (!definition.pull || !online) continue;
      const key = `cursor:${definition.name}`;
      const stored = cursors.has(key)
        ? cursors.get(key)!
        : ((await cursorStore?.get(key).catch(() => undefined))?.cursor ?? null);
      const result = await definition.pull(stored, { network: network() });
      for (const change of result.changes) {
        // A local change that waits wins over the server's: the push sends it next.
        const local = outbox
          .list()
          .some(
            (c) =>
              c.entity === definition.name &&
              c.entityId === change.entityId &&
              c.state !== 'failed',
          );
        if (local) continue;
        await definition.apply?.(change);
        pulled++;
      }
      cursors.set(key, result.cursor);
      await cursorStore?.set(key, { cursor: result.cursor }).catch(() => undefined);
    }
    return pulled;
  }

  function run(runOptions: { pull?: boolean } = {}): Promise<SyncReport> {
    const report = (pushed = 0, pulled = 0, failed = 0): SyncReport => {
      const all = outbox.list();
      return {
        pushed,
        pulled,
        failed,
        conflicts: all.filter((c) => c.state === 'conflict').length,
        waiting: all.filter((c) => c.state === 'waiting').length,
      };
    };
    if (!online || paused || !context) return Promise.resolve(report());
    if (running) {
      // One run at a time in this tab; the calls during a run share one run after it.
      again ??= running.then(() => {
        again = null;
        return run(runOptions);
      });
      return again;
    }
    running = (async () => {
      const ctx = context!;
      ctx.state.update((s) => void (s.status = 'SYNCING'));
      const work = async () => {
        await outbox.reload();
        const result = await pushAll();
        const pulled =
          runOptions.pull === false
            ? 0
            : await pullAll().catch((error: unknown) => {
                ctx.report(error);
                return 0;
              });
        return { ...result, pulled };
      };
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
      try {
        const result = locks ? await locks.request(`platform-sync:${name}`, work) : await work();
        clearTimeout(retryTimer);
        if (result.transient && online && !paused) {
          // Retry with backoff; the round count grows until a run sends everything.
          retryTimer = setTimeout(
            () => void run({ pull: false }).catch((error: unknown) => ctx.report(error)),
            computeBackoff({
              base: options.retryBaseMs ?? 1_000,
              attempts: retryRound++,
              strategy: 'exponential-jitter',
            }),
          );
          (retryTimer as { unref?: () => void }).unref?.();
        } else if (!result.transient) {
          retryRound = 0;
        }
        const done = report(result.pushed, result.pulled, result.failed);
        ctx.state.update((s) => {
          s.lastSyncAt = now();
        });
        if (done.pushed + done.pulled + done.failed > 0) {
          ctx.port
            .send({ eventId: SYNC_COMPLETED, payload: done })
            .catch((error: unknown) => ctx.report(error));
        }
        return done;
      } finally {
        ctx.state.update((s) => void (s.status = 'IDLE'));
        showPending();
      }
    })().finally(() => {
      running = null;
    });
    return running;
  }

  const readable = { readable: true } as const;
  return defineSubsystem({
    id: SYNC_ID,
    scope: 'tab',
    kind: 'featurized',
    requires: [
      { target: 'network', kind: 'required' },
      { target: 'global-state', kind: 'optional' },
      { target: 'storage', kind: 'optional' },
    ],
    state: {
      initial: {
        status: 'IDLE',
        pending: 0,
        failed: 0,
        conflicts: 0,
        lastSyncAt: null,
        lastError: null,
        persistent: false,
      } as SyncData,
      policy: {
        status: readable,
        pending: readable,
        failed: readable,
        conflicts: readable,
        lastSyncAt: readable,
        lastError: readable,
        persistent: readable,
      },
    },

    init(ctx) {
      context = ctx;
      const setEnvironment = (next: { online: boolean; visible: boolean }) => {
        const cameOnline = next.online && !online;
        online = next.online;
        visible = next.visible;
        showPending();
        if (cameOnline) void run().catch((error: unknown) => ctx.report(error));
      };
      let fromGlobal = false;
      let stopView: (() => void) | undefined;
      const stopGlobal = ctx.watch<GlobalStateLike>('global-state', (globalState) => {
        stopView?.();
        stopView = undefined;
        shown.clear();
        fromGlobal = globalState !== undefined;
        const browser = () => ({
          online: typeof navigator === 'undefined' || navigator.onLine !== false,
          visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
        });
        if (!globalState) return setEnvironment(browser());
        const read = () => {
          const s = globalState.views.state.getSnapshot();
          setEnvironment({ online: s.online ?? true, visible: s.visible ?? true });
        };
        stopView = globalState.views.state.subscribe(read);
        read();
      });
      const onBrowser = () => {
        if (!fromGlobal) setEnvironment({ online: navigator.onLine !== false, visible });
      };
      const events = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
      if (events) {
        window.addEventListener('online', onBrowser);
        window.addEventListener('offline', onBrowser);
      }

      let stopRemote: (() => void) | undefined;
      const stopStorage = ctx.watch<StorageLike>('storage', (storage) => {
        stopRemote?.();
        stopRemote = undefined;
        if (!storage) {
          cursorStore = null;
          void outbox.bind(null).then(showPending);
          return;
        }
        const collection = storage.commands.collection({
          name: `sync.outbox.${name}`,
        }) as SyncStore;
        cursorStore = storage.commands.collection({ name: `sync.cursors.${name}` }) as CursorStore;
        // Another tab changed the outbox: read it again.
        stopRemote = collection.subscribe((change) => {
          if (change.remote) void outbox.reload().catch((error: unknown) => ctx.report(error));
        });
        void outbox
          .bind(collection)
          .then(() => kick())
          .catch((error: unknown) => ctx.report(error));
      });

      const interval = options.intervalMs ?? 300_000;
      const timer =
        interval === false
          ? undefined
          : setInterval(() => {
              if (visible) void run().catch((error: unknown) => ctx.report(error));
            }, interval);
      (timer as { unref?: () => void } | undefined)?.unref?.();
      kick();

      return async () => {
        // Stop new runs, then let the current run end before Storage and Network stop.
        paused = true;
        clearTimeout(retryTimer);
        await (again ?? running)?.catch(() => undefined);
        stopGlobal();
        stopView?.();
        stopStorage();
        stopRemote?.();
        clearInterval(timer);
        clearTimeout(retryTimer);
        if (events) {
          window.removeEventListener('online', onBrowser);
          window.removeEventListener('offline', onBrowser);
        }
        const globalState = ctx.dependency<GlobalStateLike>('global-state');
        for (const entity of shown.keys()) globalState?.commands.endWork(`sync:${entity}`);
        shown.clear();
        context = null;
        paused = false;
      };
    },

    control: (ctx) => ({
      commands: {
        entity<T>(definition: EntityDefinition<T>): EntityHandle<T> {
          entities.set(definition.name, definition as EntityDefinition<unknown>);
          kick();
          return {
            name: definition.name,
            create: (entityId, data) =>
              record(definition.name, entityId, 'create', data) as Promise<Change<T> | null>,
            update: (entityId, data) =>
              record(definition.name, entityId, 'update', data) as Promise<Change<T> | null>,
            remove: (entityId) =>
              record(definition.name, entityId, 'delete', null) as Promise<Change<T> | null>,
            pending: () => outbox.list().filter((c) => c.entity === definition.name) as Change<T>[],
          };
        },
        syncNow: (runOptions?: { readonly pull?: boolean }) => run(runOptions),
        pause() {
          paused = true;
          clearTimeout(retryTimer);
          showPending();
        },
        resume() {
          paused = false;
          showPending();
          void run().catch((error: unknown) => ctx.report(error));
        },
        async resolve(changeId, choice) {
          const change = outbox.get(changeId);
          if (!change || change.state !== 'conflict') return false;
          if (choice === 'remote') {
            await entities
              .get(change.entity)
              ?.apply?.({ entityId: change.entityId, op: 'upsert', data: change.remote });
            await outbox.delete(change.id);
            return true;
          }
          const data = choice === 'local' ? change.data : choice.data;
          await outbox.put({ ...change, data, state: 'waiting', force: true, error: null });
          kick();
          return true;
        },
        async retryFailed() {
          const failed = outbox.list().filter((c) => c.state === 'failed');
          for (const change of failed)
            await outbox.put({ ...change, state: 'waiting', error: null });
          ctx.state.update((s) => void (s.lastError = null));
          kick();
          return failed.length;
        },
        discard: (changeId: string) => outbox.delete(changeId),
        outbox: () => outbox.list(),
      },
      views: { state: ctx.state.readable },
    }),
  });
}
