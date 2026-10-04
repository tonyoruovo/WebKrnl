/**
 * @fileoverview
 * @module @platform/auth
 * @summary The public API of `@platform/auth`.
 * @description
 * Re-exports the Auth subsystem ({@linkcode createAuth}), its error and its
 * types (docs/ARCHITECTURE.md §19.2).
 *
 * ```text
 *   @platform/auth
 *   +-- createAuth          the subsystem: id 'auth', featurized, Window scope
 *   +-- AuthHandlers        the functions that talk to the server of the app
 *   +-- meetsRequirement    the permission check, without the subsystem
 *   +-- AuthLockedError     too many failed logins
 *   ```
 *
 * @example
 * Registering Auth
 * ```ts
 * import { createAuth } from '@platform/auth';
 *
 * const kernel = new Kernel([...centralized, createNetwork(), createStorage(), createAuth({ handlers })], { router: queue.router });
 * ```
 *
 * @example
 * Using it from another subsystem
 * ```ts
 * import type { AuthControl } from '@platform/auth';
 *
 * const canRefund = ctx.dependency<AuthControl>('auth')?.commands.hasPermission('orders:refund') ?? false;
 * ```
 *
 * @author MathAid
 */

export * from './auth';
export * from './types';
