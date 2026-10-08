/**
 * @fileoverview
 * @module @webkrnl/sync
 * @summary The public API of `@webkrnl/sync`.
 * @description
 * Re-exports the Sync subsystem ({@linkcode createSync}), its outbox and its
 * types (docs/ARCHITECTURE.md §19.3).
 *
 * ```text
 *   @webkrnl/sync
 *   +-- createSync     the subsystem: id 'sync', featurized, Tab scope, needs Network
 *   +-- Outbox         the changes that wait for the server (Storage: 'sync.outbox.<name>')
 *   +-- mergeOps       how two waiting changes of one entity merge
 *   +-- isPermanent    which push errors stop retries
 *   ```
 *
 * @example
 * Registering Sync
 * ```ts
 * import { createSync } from '@webkrnl/sync';
 *
 * const kernel = new Kernel([...centralized, createNetwork(), createStorage(), createSync()], { router: queue.router });
 * ```
 *
 * @example
 * Declaring an entity from another subsystem
 * ```ts
 * import type { SyncControl } from '@webkrnl/sync';
 *
 * const todos = ctx.dependency<SyncControl>('sync')?.commands.entity<Todo>({ name: 'todos', push });
 * ```
 *
 * @author MathAid
 */

export * from './outbox';
export * from './sync';
export * from './types';
