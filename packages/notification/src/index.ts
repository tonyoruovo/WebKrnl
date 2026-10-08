/**
 * @fileoverview
 * @module @webkrnl/notification
 * @summary The public API of `@webkrnl/notification`.
 * @description
 * Re-exports the Notification Center ({@linkcode createNotificationCenter})
 * and its per-subscriber circuit breakers ({@linkcode CircuitBreakers}).
 *
 * ```text
 *   @webkrnl/notification
 *   +-- createNotificationCenter   { subsystem, fanOut }
 *   |   subsystem: id 'notification', centralized, Tab scope
 *   |   fanOut:    passed to the Queue, which hands it every broadcast
 *   +-- CircuitBreakers            stops calling a subscriber that keeps failing
 *   ```
 *
 * @example
 * Wiring the three centralized subsystems
 * ```ts
 * import { Kernel } from '@webkrnl/core';
 * import { createGlobalState } from '@webkrnl/global-state';
 * import { createNotificationCenter } from '@webkrnl/notification';
 * import { createQueue } from '@webkrnl/queue';
 *
 * const notification = createNotificationCenter();
 * const queue = createQueue({ fanOut: notification.fanOut });
 * const kernel = new Kernel(
 *   [createGlobalState(), queue.subsystem, notification.subsystem, ...subsystems],
 *   { router: queue.router },
 * );
 * ```
 *
 * @example
 * Listening to a broadcast from application code
 * ```ts
 * import type { NotificationControl } from '@webkrnl/notification';
 *
 * const { commands } = kernel.unit<NotificationControl>('notification').control!;
 * commands.subscribe('settings:changed', (payload) => applySettings(payload));
 * ```
 *
 * @see [Package README](../README.md)
 * @author MathAid
 */

export * from './circuit-breaker';
export * from './notification-center';
