/**
 * @fileoverview
 * @summary The worker entry of Realtime. It serves the socket processor.
 * @description `createRealtime` starts this file as a dedicated worker. You do not import it yourself.
 * @example
 * How the subsystem starts it
 * ```ts
 * new Worker(new URL('./socket.worker.ts', import.meta.url), { type: 'module' });
 * ```
 * @author MathAid
 */

import { serveProcessor } from '@webkrnl/core/worker';

import { createSocketProcessor } from './processor';

serveProcessor(createSocketProcessor());
