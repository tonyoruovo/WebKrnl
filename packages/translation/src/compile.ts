/**
 * @fileoverview
 * @summary The processor `compile`: parses every message of a catalog, in a worker when one is available.
 * @description
 * A catalog can have thousands of messages, so Translation parses it in the
 * processor `compile` (docs/ARCHITECTURE.md §21.2), which runs on a dedicated
 * worker, then on the main thread. The result is plain data. A message that
 * does not parse becomes `null`, and its error is returned, so one bad message
 * does not stop the catalog.
 *
 * ```text
 *   { messages: { greeting: 'Hello, {name}!', bad: 'Hello, {name' } }
 *     --> { messages: { greeting: ['Hello, ', { type: 'argument', name: 'name' }, '!'], bad: null },
 *           errors: [{ key: 'bad', message: 'Missing "}" at 12.' }] }
 *   ```
 *
 * @example
 * On the main thread
 * ```ts
 * const result = createCompileProcessor().handle({ messages: { hi: 'Hi!' } }, scope);
 * ```
 *
 * @author MathAid
 */

import { defineProcessor, type ProcessorModule } from '@webkrnl/core';

import { parseMessage, type CompiledMessage } from './icu';

/**
 * @summary A request to the processor `compile`: the messages of one catalog.
 * @public
 */
export interface CompileRequest {
  /**
   * @summary The messages, by key, in ICU MessageFormat.
   */
  readonly messages: Readonly<Record<string, string>>;
}

/**
 * @summary The result of the processor `compile`.
 *
 * @example
 * Example 1: One bad message
 * ```ts
 * // { messages: { ok: ['Fine'], bad: null }, errors: [{ key: 'bad', message: 'Missing "}" at 4.' }] }
 * ```
 *
 * @example
 * Example 2: Reporting the errors
 * ```ts
 * for (const { key, message } of result.errors) console.warn(`${key}: ${message}`);
 * ```
 *
 * @public
 */
export interface CompileResult {
  /**
   * @summary The parsed messages, by key. A message that does not parse is `null`.
   */
  readonly messages: Readonly<Record<string, CompiledMessage | null>>;
  /**
   * @summary The errors, one for each message that does not parse.
   */
  readonly errors: ReadonlyArray<{ readonly key: string; readonly message: string }>;
}

/**
 * @summary Parses the messages of a catalog.
 *
 * @example
 * Example 1: A small catalog
 * ```ts
 * compileCatalog({ messages: { hi: 'Hi, {name}!' } }).messages.hi; // ['Hi, ', { type: 'argument', name: 'name' }, '!']
 * ```
 *
 * @example
 * Example 2: Values that are not strings
 * ```ts
 * compileCatalog({ messages: { n: 42 as never } }).errors; // [{ key: 'n', message: 'The message is not a string.' }]
 * ```
 *
 * @param {CompileRequest} request The messages.
 * @returns {CompileResult} The parsed messages and the errors.
 *
 * @public
 */
export function compileCatalog(request: CompileRequest): CompileResult {
  const messages: Record<string, CompiledMessage | null> = {};
  const errors: Array<{ key: string; message: string }> = [];
  for (const [key, source] of Object.entries(request.messages ?? {})) {
    if (typeof source !== 'string') {
      messages[key] = null;
      errors.push({ key, message: 'The message is not a string.' });
      continue;
    }
    try {
      messages[key] = parseMessage(source);
    } catch (error) {
      messages[key] = null;
      errors.push({ key, message: (error as Error).message });
    }
  }
  return { messages, errors };
}

/**
 * @summary Creates the module of the processor `compile`.
 *
 * @example
 * Example 1: In the worker entry
 * ```ts
 * serveProcessor(createCompileProcessor());
 * ```
 *
 * @example
 * Example 2: On the main thread (the `virtual` host)
 * ```ts
 * load: async () => createCompileProcessor(),
 * ```
 *
 * @returns {ProcessorModule<CompileRequest, CompileResult>} The module.
 *
 * @public
 */
export function createCompileProcessor(): ProcessorModule<CompileRequest, CompileResult> {
  return defineProcessor<CompileRequest, CompileResult>({ handle: compileCatalog });
}
