/**
 * @fileoverview
 * @module @webkrnl/network
 * @summary The public API of `@webkrnl/network`.
 * @description
 * Re-exports the Network subsystem ({@linkcode createNetwork}), its errors,
 * its cache and circuit breakers, and its types (docs/ARCHITECTURE.md §19.1).
 *
 * ```text
 *   @webkrnl/network
 *   +-- createNetwork      the subsystem: id 'network', featurized, Tab scope, main thread
 *   +-- errors             NetworkError, HttpError, OfflineError, NetworkTimeoutError, RequestAbortedError, CircuitOpenError
 *   +-- ResponseCache      memory LRU, kept in Storage when Storage runs
 *   +-- Breakers           one circuit breaker for each origin
 *   ```
 *
 * @example
 * Registering the Network
 * ```ts
 * import { createNetwork } from '@webkrnl/network';
 *
 * const kernel = new Kernel([...centralized, createNetwork({ baseUrl: 'https://api.shop.example' })], { router: queue.router });
 * ```
 *
 * @example
 * Using it from another subsystem
 * ```ts
 * import type { NetworkControl } from '@webkrnl/network';
 *
 * const orders = await ctx.dependency<NetworkControl>('network')?.commands.get('/orders');
 * ```
 *
 * @author MathAid
 */

export * from './breaker';
export * from './cache';
export * from './errors';
export * from './network';
export * from './types';
