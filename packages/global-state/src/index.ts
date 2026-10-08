/**
 * @fileoverview
 * @module @webkrnl/global-state
 * @summary The public API of `@webkrnl/global-state`.
 * @description
 * Re-exports the Global State subsystem ({@linkcode createGlobalState}), its
 * status derivation and admission rules (`status.ts`), its environment
 * sources (`environment.ts`), tab identity (`tab-identity.ts`) and the tab
 * count (`tab-count.ts`).
 *
 * ```text
 *   @webkrnl/global-state
 *   +-- createGlobalState        the subsystem (id 'global-state', centralized, tab scope)
 *   +-- derivePlatformStatus     INITIALIZING | IDLE | BUSY | DEGRADED (| STOPPED)
 *   +-- canAccept                admission by importance
 *   +-- createBrowserEnvironment / createStaticEnvironment
 *   +-- resolveTabIdentity       unique per tab, stable across reloads
 *   +-- createTabCounter         the open tabs of this origin (Web Locks)
 *   ```
 *
 * @example
 * Booting the platform with Global State
 * ```ts
 * import { Kernel } from '@webkrnl/core';
 * import { createGlobalState, type GlobalStateControl } from '@webkrnl/global-state';
 *
 * const kernel = new Kernel([createGlobalState(), ...subsystems]);
 * await kernel.start();
 * kernel.unit<GlobalStateControl>('global-state').control?.views.state.getSnapshot().status; // 'IDLE'
 * ```
 *
 * @example
 * Testing a subsystem under a busy platform
 * ```ts
 * import { createStaticEnvironment, createGlobalState } from '@webkrnl/global-state';
 * import { createTestPlatform } from '@webkrnl/core/testing';
 *
 * const platform = createTestPlatform([
 *   createGlobalState({ busyThreshold: 0, environment: createStaticEnvironment(), tabIdentity: false }),
 *   mySubsystem,
 * ]);
 * ```
 *
 * @see [Package README](../README.md)
 * @author MathAid
 */

export * from './environment';
export * from './global-state';
export * from './status';
export * from './tab-count';
export * from './tab-identity';
