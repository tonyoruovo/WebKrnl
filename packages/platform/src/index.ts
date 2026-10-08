/**
 * @fileoverview
 * @module @webkrnl/platform
 * @summary The public API of `@webkrnl/platform`.
 * @description
 * Re-exports the orchestrator ({@linkcode createPlatform}) and its types.
 *
 * ```text
 *   @webkrnl/platform
 *   +-- createPlatform     a kernel with the chosen subsystems, wired together
 *   +-- types              Platform, PlatformOptions, PlatformControls
 *   ```
 *
 * @example
 * Booting WebKrnl
 * ```ts
 * import { createPlatform } from '@webkrnl/platform';
 *
 * const platform = createPlatform({ appName: 'notes' });
 * await platform.start();
 * ```
 *
 * @example
 * A typed control
 * ```ts
 * platform.unit('translation')?.commands.t('hello');
 * ```
 *
 * @author MathAid
 */

export * from './platform';
