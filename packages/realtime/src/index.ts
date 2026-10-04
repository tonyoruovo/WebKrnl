/**
 * @fileoverview
 * @module @platform/realtime
 * @summary The public API of `@platform/realtime`.
 * @description
 * Re-exports the Realtime subsystem ({@linkcode createRealtime}), its socket
 * processor, the default protocol and its types (docs/ARCHITECTURE.md §19.4).
 *
 * ```text
 *   @platform/realtime
 *   +-- createRealtime          the subsystem: id 'realtime', featurized, Tab scope
 *   +-- createSocketProcessor   the processor 'socket': dedicated worker, then the main thread
 *   +-- JSON_PROTOCOL           the default frames: one JSON object for each frame
 *   @platform/realtime/worker   the worker entry that serves the processor
 *   ```
 *
 * @example
 * Registering Realtime
 * ```ts
 * import { createRealtime } from '@platform/realtime';
 *
 * const kernel = new Kernel([...centralized, createAuth({ handlers }), createRealtime({ url: 'wss://rt.shop.example', auth: 'message' })], { router: queue.router });
 * ```
 *
 * @example
 * Using it from another subsystem
 * ```ts
 * import type { RealtimeControl } from '@platform/realtime';
 *
 * ctx.dependency<RealtimeControl>('realtime')?.commands.subscribe('orders', (data) => refresh(data));
 * ```
 *
 * @author MathAid
 */

export * from './processor';
export * from './realtime';
export * from './types';
