/**
 * @fileoverview
 * @summary The types of the Sync subsystem: changes, entities, state, options and the control interface.
 * @description
 * An app declares each entity type with {@linkcode EntityDefinition}. Its
 * changes go to the outbox as {@linkcode Change} records until the server
 * confirms them (docs/ARCHITECTURE.md §19.3).
 *
 * @example
 * A todo entity
 * ```ts
 * const todos = sync.commands.entity<Todo>({
 *   name: 'todos',
 *   push: async (change, { network }) => {
 *     await network.commands.request({ url: `/todos/${change.entityId}`, method: change.op === 'delete' ? 'DELETE' : 'PUT', body: change.data, idempotencyKey: change.id });
 *   },
 * });
 * await todos.update('t1', { title: 'Buy tea', done: false });
 * ```
 *
 * @author MathAid
 */

import type { View } from '@platform/core';

/**
 * @summary The kinds of change.
 * @public
 */
export type ChangeOp = 'create' | 'update' | 'delete';

/**
 * @summary Where a change is: waiting to be sent, failed for good, or in a conflict that waits for a choice.
 * @public
 */
export type ChangeState = 'waiting' | 'failed' | 'conflict';

/**
 * @summary One change in the outbox.
 *
 * @example
 * Example 1: A waiting update
 * ```ts
 * // { id: '6f1…', entity: 'todos', entityId: 't1', op: 'update', data: { title: 'Tea' }, state: 'waiting', attempts: 0, ... }
 * ```
 *
 * @example
 * Example 2: A conflict
 * ```ts
 * // { state: 'conflict', remote: { title: 'Coffee' }, ... }
 * ```
 *
 * @template T The type of the entity data.
 * @public
 */
export interface Change<T = unknown> {
  /**
   * @summary The id of the change. Send it as the `Idempotency-Key`, so the server applies it once.
   */
  readonly id: string;
  /**
   * @summary The entity type, for example `todos`.
   */
  readonly entity: string;
  /**
   * @summary The id of the entity.
   */
  readonly entityId: string;
  /**
   * @summary The kind of change.
   */
  readonly op: ChangeOp;
  /**
   * @summary The data, or `null` for a delete.
   */
  readonly data: T | null;
  /**
   * @summary When the change was made, in Unix milliseconds.
   */
  readonly createdAt: number;
  /**
   * @summary The order of changes made in the same millisecond.
   */
  readonly seq: number;
  /**
   * @summary The number of times the change was sent.
   */
  readonly attempts: number;
  /**
   * @summary Where the change is.
   */
  readonly state: ChangeState;
  /**
   * @summary Asks the server to overwrite its version (after a conflict).
   */
  readonly force: boolean;
  /**
   * @summary The message of the last error, or `null`.
   */
  readonly error: string | null;
  /**
   * @summary The version of the server, for a conflict.
   */
  readonly remote?: T;
}

/**
 * @summary A change from the server, from a pull.
 * @example
 * Example 1: An upsert
 * ```ts
 * // { entityId: 't2', op: 'upsert', data: { title: 'From the phone' } }
 * ```
 * @example
 * Example 2: A delete
 * ```ts
 * // { entityId: 't3', op: 'delete' }
 * ```
 * @template T The type of the entity data.
 * @public
 */
export interface RemoteChange<T = unknown> {
  /**
   * @summary The id of the entity.
   */
  readonly entityId: string;
  /**
   * @summary `upsert` or `delete`.
   */
  readonly op: 'upsert' | 'delete';
  /**
   * @summary The data, for an upsert.
   */
  readonly data?: T;
}

/**
 * @summary What a push handler returns: nothing for a success, or the server's version for a conflict.
 * @public
 */
export type PushResult<T> = void | {
  /**
   * @summary The version of the server.
   */
  readonly conflict: T;
};

/**
 * @summary How Sync solves a conflict.
 * @description
 * - `server-wins`: drop the change and apply the server's version. The default.
 * - `client-wins`: send the change again with `force`.
 * - `merge`: send `merge(local, remote)` with `force`.
 * - `manual`: keep the change in `conflicts` until `resolve`.
 * @public
 */
export type ConflictStrategy = 'server-wins' | 'client-wins' | 'merge' | 'manual';

/**
 * @summary The part of the Network control that Sync gives to handlers.
 * @description Sync does not import `@platform/network`. Errors with a
 * `status` of 4xx (except 408, 425 and 429) are permanent; other errors are transient.
 * @public
 */
export interface SyncNetwork {
  /**
   * @summary The commands of the Network.
   */
  readonly commands: {
    /**
     * @summary Sends a request through the Network.
     * @example
     * Pushing a change
     * ```ts
     * await network.commands.request({ url: '/todos/t1', method: 'PUT', body: change.data, idempotencyKey: change.id });
     * ```
     * @param config The request.
     * @returns The response of the Network.
     */
    request<R = unknown>(config: {
      url: string;
      method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
      body?: unknown;
      query?: Record<string, string | number | boolean | undefined>;
      headers?: Record<string, string>;
      idempotencyKey?: string;
      allowErrorStatus?: boolean;
      background?: boolean;
    }): Promise<{ readonly status: number; readonly data: R }>;
  };
}

/**
 * @summary What a handler gets.
 * @public
 */
export interface SyncTools {
  /**
   * @summary The Network.
   */
  readonly network: SyncNetwork;
}

/**
 * @summary The definition of an entity type.
 *
 * @example
 * Example 1: Push only
 * ```ts
 * sync.commands.entity<Note>({ name: 'notes', push: pushNote });
 * ```
 *
 * @example
 * Example 2: Push, pull and a merge
 * ```ts
 * sync.commands.entity<Todo>({ name: 'todos', push, pull, apply: writeLocal, merge: (l, r) => ({ ...r, ...l }), conflict: 'merge' });
 * ```
 *
 * @template T The type of the entity data.
 * @public
 */
export interface EntityDefinition<T> {
  /**
   * @summary The name of the entity type.
   */
  readonly name: string;
  /**
   * @summary Sends one change to the server.
   * @example
   * A REST push
   * ```ts
   * push: async (change, { network }) => {
   *   const response = await network.commands.request({ url: `/todos/${change.entityId}`, method: 'PUT', body: change.data, idempotencyKey: change.id, allowErrorStatus: true });
   *   if (response.status === 409) return { conflict: response.data as Todo };
   * }
   * ```
   * @param {Change<T>} change The change.
   * @param {SyncTools} tools The Network.
   * @returns {Promise<PushResult<T>>} Nothing, or the server's version for a conflict.
   * @throws {Error} When the push fails. A `status` of 4xx (not 408, 425, 429) makes the failure permanent.
   */
  push(change: Change<T>, tools: SyncTools): Promise<PushResult<T>>;
  /**
   * @summary Gets the changes from the server since a cursor.
   * @example
   * A pull
   * ```ts
   * pull: async (cursor, { network }) => (await network.commands.request({ url: '/todos/changes', query: { since: cursor ?? '' } })).data
   * ```
   * @param {string | null} cursor The cursor of the last pull, or `null`.
   * @param {SyncTools} tools The Network.
   * @returns The changes and the new cursor.
   */
  pull?(
    cursor: string | null,
    tools: SyncTools,
  ): Promise<{ readonly changes: readonly RemoteChange<T>[]; readonly cursor: string | null }>;
  /**
   * @summary Writes a change from the server into the local data of the app.
   * @example
   * Writing to a Storage collection
   * ```ts
   * apply: (change) => (change.op === 'delete' ? todos.delete(change.entityId) : todos.set(change.entityId, change.data!))
   * ```
   * @param {RemoteChange<T>} change The change from the server.
   * @returns {void | Promise<void>} Resolves when the change is written.
   */
  apply?(change: RemoteChange<T>): void | Promise<void>;
  /**
   * @summary Merges the local and the server's version, for the `merge` strategy.
   * @example
   * The local fields win
   * ```ts
   * merge: (local, remote) => ({ ...remote, ...local })
   * ```
   * @param {T} local The local version.
   * @param {T} remote The server's version.
   * @returns {T} The merged version.
   */
  merge?(local: T, remote: T): T;
  /**
   * @summary The conflict strategy. The default is `server-wins`.
   */
  readonly conflict?: ConflictStrategy;
}

/**
 * @summary The handle of an entity type, from `commands.entity`.
 * @example
 * Example 1: Making changes
 * ```ts
 * await todos.create('t1', { title: 'Tea' });
 * await todos.update('t1', { title: 'Green tea' });
 * await todos.remove('t1');
 * ```
 * @example
 * Example 2: Showing what waits
 * ```ts
 * badge.textContent = String(todos.pending().length);
 * ```
 * @template T The type of the entity data.
 * @public
 */
export interface EntityHandle<T> {
  /**
   * @summary The name of the entity type.
   */
  readonly name: string;
  /**
   * @summary Records a new entity.
   * @example
   * Creating
   * ```ts
   * await todos.create('t1', { title: 'Tea' });
   * ```
   * @param {string} entityId The id of the entity.
   * @param {T} data The data.
   * @returns {Promise<Change<T> | null>} The change in the outbox, or `null` when it cancelled a waiting change.
   */
  create(entityId: string, data: T): Promise<Change<T> | null>;
  /**
   * @summary Records new data for an entity.
   * @example
   * Updating
   * ```ts
   * await todos.update('t1', { title: 'Green tea' });
   * ```
   * @param {string} entityId The id of the entity.
   * @param {T} data The data.
   * @returns {Promise<Change<T> | null>} The change in the outbox.
   */
  update(entityId: string, data: T): Promise<Change<T> | null>;
  /**
   * @summary Records that an entity is deleted.
   * @example
   * Deleting
   * ```ts
   * await todos.remove('t1');
   * ```
   * @param {string} entityId The id of the entity.
   * @returns {Promise<Change<T> | null>} The change in the outbox, or `null` when it cancelled a waiting create.
   */
  remove(entityId: string): Promise<Change<T> | null>;
  /**
   * @summary Returns the changes of this entity type in the outbox, oldest first.
   * @example
   * Listing
   * ```ts
   * todos.pending().length;
   * ```
   * @returns {Change<T>[]} The changes.
   */
  pending(): Change<T>[];
}

/**
 * @summary The status of Sync.
 * @public
 */
export type SyncStatus = 'IDLE' | 'SYNCING' | 'OFFLINE' | 'PAUSED' | 'ERROR';

/**
 * @summary The result of one sync run.
 * @example
 * Example 1: Everything sent
 * ```ts
 * // { pushed: 3, pulled: 2, failed: 0, conflicts: 0, waiting: 0 }
 * ```
 * @example
 * Example 2: Offline
 * ```ts
 * // { pushed: 0, pulled: 0, failed: 0, conflicts: 0, waiting: 3 }
 * ```
 * @public
 */
export interface SyncReport {
  /**
   * @summary The changes that the server confirmed.
   */
  readonly pushed: number;
  /**
   * @summary The changes from the server that were applied.
   */
  readonly pulled: number;
  /**
   * @summary The changes that failed for good in this run.
   */
  readonly failed: number;
  /**
   * @summary The conflicts that wait for a choice.
   */
  readonly conflicts: number;
  /**
   * @summary The changes that still wait.
   */
  readonly waiting: number;
}

/**
 * @summary The state of Sync.
 * @example
 * Example 1: Offline with work
 * ```ts
 * // { status: 'OFFLINE', pending: 4, failed: 0, conflicts: 0, lastSyncAt: 1700000000000, lastError: null, persistent: true }
 * ```
 * @example
 * Example 2: A failure
 * ```ts
 * // { status: 'ERROR', failed: 1, lastError: '[sync] todos/t9: 422 Unprocessable', ... }
 * ```
 * @public
 */
export interface SyncData {
  /**
   * @summary The status.
   */
  status: SyncStatus;
  /**
   * @summary The changes that wait to be sent.
   */
  pending: number;
  /**
   * @summary The changes that failed for good.
   */
  failed: number;
  /**
   * @summary The conflicts that wait for a choice.
   */
  conflicts: number;
  /**
   * @summary When the last run ended, in Unix milliseconds, or `null`.
   */
  lastSyncAt: number | null;
  /**
   * @summary The message of the last error, or `null`.
   */
  lastError: string | null;
  /**
   * @summary Tells if the outbox is kept in Storage, so it survives a reload.
   */
  persistent: boolean;
}

/**
 * @summary The payload of the broadcast `sync:failed`.
 * @public
 */
export interface SyncFailed {
  /**
   * @summary The id of the change.
   */
  readonly changeId: string;
  /**
   * @summary The entity type.
   */
  readonly entity: string;
  /**
   * @summary The id of the entity.
   */
  readonly entityId: string;
  /**
   * @summary The message of the error.
   */
  readonly error: string;
}

/**
 * @summary Options of {@linkcode createSync}.
 * @example
 * Example 1: An app
 * ```ts
 * createSync({ intervalMs: 60_000 });
 * ```
 * @example
 * Example 2: Tests: no timer, fast retries
 * ```ts
 * createSync({ intervalMs: false, retryBaseMs: 1 });
 * ```
 * @public
 */
export interface SyncOptions {
  /**
   * @summary The time between automatic runs, in milliseconds, or `false`. The default is 300 000.
   */
  readonly intervalMs?: number | false;
  /**
   * @summary The base wait of the backoff after a transient failure, in milliseconds. The default is 1 000.
   */
  readonly retryBaseMs?: number;
  /**
   * @summary The name of the outbox in Storage and of the Web Lock. The default is `default`.
   */
  readonly name?: string;
  /**
   * @summary The clock, in Unix milliseconds. The default is `Date.now`.
   */
  readonly now?: () => number;
  /**
   * @summary Makes change ids. The default is `crypto.randomUUID`.
   */
  readonly ids?: () => string;
}

/**
 * @summary The control interface of Sync.
 * @public
 */
export interface SyncControl {
  /**
   * @summary The commands.
   */
  readonly commands: {
    /**
     * @summary Declares an entity type and returns its handle.
     * @example
     * Todos
     * ```ts
     * const todos = commands.entity<Todo>({ name: 'todos', push });
     * ```
     * @param {EntityDefinition<T>} definition The definition.
     * @returns {EntityHandle<T>} The handle.
     */
    entity<T>(definition: EntityDefinition<T>): EntityHandle<T>;
    /**
     * @summary Sends the outbox and pulls now.
     * @example
     * A pull-to-refresh
     * ```ts
     * const report = await commands.syncNow();
     * ```
     * @param {object} [options] `pull: false` only sends.
     * @returns {Promise<SyncReport>} What the run did.
     */
    syncNow(options?: { readonly pull?: boolean }): Promise<SyncReport>;
    /**
     * @summary Stops automatic runs until `resume`.
     * @example
     * During a large import
     * ```ts
     * commands.pause();
     * ```
     * @returns {void}
     */
    pause(): void;
    /**
     * @summary Starts automatic runs again, and runs now.
     * @example
     * After the import
     * ```ts
     * commands.resume();
     * ```
     * @returns {void}
     */
    resume(): void;
    /**
     * @summary Solves a conflict: keep the local version, take the server's, or send other data.
     * @example
     * Keeping the local version
     * ```ts
     * await commands.resolve(change.id, 'local');
     * ```
     * @param {string} changeId The id of the change.
     * @param choice `local`, `remote`, or `{ data }` to send other data.
     * @returns {Promise<boolean>} `true` when the change was a conflict.
     */
    resolve(
      changeId: string,
      choice: 'local' | 'remote' | { readonly data: unknown },
    ): Promise<boolean>;
    /**
     * @summary Puts the failed changes back in the outbox.
     * @example
     * After a fix on the server
     * ```ts
     * await commands.retryFailed();
     * ```
     * @returns {Promise<number>} The number of changes put back.
     */
    retryFailed(): Promise<number>;
    /**
     * @summary Deletes a change from the outbox, without sending it.
     * @example
     * Giving up a failed change
     * ```ts
     * await commands.discard(change.id);
     * ```
     * @param {string} changeId The id of the change.
     * @returns {Promise<boolean>} `true` when the change existed.
     */
    discard(changeId: string): Promise<boolean>;
    /**
     * @summary Returns every change in the outbox, oldest first.
     * @example
     * A debug panel
     * ```ts
     * commands.outbox().filter((c) => c.state === 'failed');
     * ```
     * @returns {Change[]} The changes.
     */
    outbox(): Change[];
  };
  /**
   * @summary The views.
   */
  readonly views: {
    /**
     * @summary The state of Sync.
     */
    readonly state: View<Partial<SyncData>>;
  };
}
