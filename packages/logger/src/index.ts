/**
 * @fileoverview
 * @module @webkrnl/logger
 * @summary The public API of `@webkrnl/logger`.
 * @description
 * Re-exports the Logger subsystem ({@linkcode createLogger}), its entry
 * formatter, and the sanitizer it runs on every context.
 *
 * ```text
 *   @webkrnl/logger
 *   +-- createLogger      the subsystem: id 'logger', featurized, Tab scope
 *   +-- formatEntry       one entry as a line of text
 *   +-- LEVEL_RANK        DEBUG < INFO < WARN < ERROR < FATAL
 *   +-- sanitize          redacts secrets, describes values that cannot be cloned
 *   +-- types             LogEntry, LogOptions, LogQuery, TraceRecord, Trace, LoggerControl, ...
 *   ```
 *
 * @example
 * Registering the Logger
 * ```ts
 * import { createLogger } from '@webkrnl/logger';
 *
 * const kernel = new Kernel([...centralized, createLogger({ console: 'WARN' }), ...subsystems], {
 *   router: queue.router,
 * });
 * ```
 *
 * @example
 * Reading a trace
 * ```ts
 * import type { LoggerControl } from '@webkrnl/logger';
 *
 * const { commands } = kernel.unit<LoggerControl>('logger').control!;
 * commands.trace(traceId);
 * ```
 *
 * @author MathAid
 */

export * from './logger';
export * from './sanitize';
