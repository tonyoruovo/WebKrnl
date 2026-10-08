/**
 * @fileoverview
 * @module @webkrnl/create
 * @summary The public API of `@webkrnl/create`: the scaffolder, for scripts and tests.
 * @description
 * `npm init @webkrnl` runs the command (`cli.ts`). Scripts and tests call
 * {@linkcode scaffold} directly.
 *
 * ```text
 *   @webkrnl/create
 *   +-- scaffold          writes an app from a template
 *   +-- parseArguments    reads the arguments of the command
 *   +-- nextSteps, HELP, TEMPLATES
 *   ```
 *
 * @example
 * From a script
 * ```ts
 * import { scaffold } from '@webkrnl/create';
 *
 * await scaffold({ directory: 'shop', template: 'vanilla' });
 * ```
 *
 * @example
 * The templates
 * ```ts
 * import { TEMPLATES } from '@webkrnl/create';
 *
 * console.log(TEMPLATES); // ['vue', 'vanilla']
 * ```
 *
 * @author MathAid
 */

export * from './scaffold.ts';
