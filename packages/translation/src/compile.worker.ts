/**
 * @fileoverview
 * @summary The worker entry of the processor `compile` (`@webkrnl/translation/worker`).
 * @description
 * Translation starts this file as a dedicated worker. It serves the processor
 * that parses catalogs (docs/ARCHITECTURE.md §21.2). An app does not import it.
 *
 * @example
 * How Translation starts it
 * ```ts
 * new Worker(new URL('./compile.worker.ts', import.meta.url), { type: 'module' });
 * ```
 *
 * @author MathAid
 */

import { serveProcessor } from '@webkrnl/core/worker';

import { createCompileProcessor } from './compile';

serveProcessor(createCompileProcessor());
