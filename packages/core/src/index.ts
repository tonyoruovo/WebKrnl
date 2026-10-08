/**
 * @fileoverview
 * @module @webkrnl/core
 * @summary The public API of `@webkrnl/core`: the kernel every `@webkrnl/*` package builds on.
 * @description
 * This barrel re-exports every public module of the package. `@webkrnl/core`
 * defines what a subsystem is, runs each subsystem's lifecycle, enforces the
 * dependencies between subsystems, moves packets between them, and runs their
 * processors on the main thread or in workers. It ships no subsystem itself.
 *
 * `src/` is organized into one folder per ARCHITECTURE section that needs
 * more than one file, plus the files with no section of their own at root
 * (ARCHITECTURE §22.1 of docs/PLAN.md, M11):
 *
 * ```text
 *   unit/        §3   Kernel, UnitRuntime, Unit, Lifecycle              (lifecycle.ts stays at root, §4)
 *   state/       §5   StateCell, the sign-out wipe (§5.1)               view.ts stays at root, §6.1 (the most-imported file)
 *   processor/   §8   ProcessorRunner, hosts, failover, scheduler,      dependency.ts stays at root, §7
 *                      the worker budget, portable functions
 *   packet/      §9   The envelope, fingerprints, traces, correlation
 *   transport/   §10  In-realm/MessageChannel transports, RPC, relays
 *   scope/       §11  Scope boundaries, the route source (§11.2.1),     backoff.ts and ring.ts stay at root (shared
 *                      the Global wire protocol (§11.4)                  utilities, no section of their own)
 *   ```
 *
 * Two more entry points exist: `@webkrnl/core/testing` (an in-memory test
 * platform) and `@webkrnl/core/worker` (`serveProcessor` for worker entry
 * files).
 *
 * @example
 * Booting two subsystems, one depending on the other
 * ```ts
 * import { Kernel, defineSubsystem } from '@webkrnl/core';
 *
 * const storage = defineSubsystem({
 *   id: 'storage',
 *   scope: 'tab',
 *   kind: 'featurized',
 *   state: { initial: { keys: 0 }, policy: { keys: { readable: true } } },
 *   control: (ctx) => ({ commands: {}, views: { state: ctx.state.readable } }),
 * });
 * const auth = defineSubsystem({
 *   id: 'auth',
 *   scope: 'window',
 *   kind: 'featurized',
 *   requires: [{ target: 'storage' }],
 *   state: { initial: {} },
 *   control: () => ({ commands: {}, views: {} }),
 * });
 *
 * const kernel = new Kernel([auth, storage]);
 * await kernel.start(); // storage first, then auth
 * ```
 *
 * @example
 * Sending a request from one subsystem to another
 * ```ts
 * import { defineSubsystem } from '@webkrnl/core';
 *
 * export const client = defineSubsystem({
 *   id: 'client',
 *   scope: 'page',
 *   kind: 'featurized',
 *   requires: [{ target: 'auth' }],
 *   state: { initial: {} },
 *   init: async (ctx) => {
 *     const user = await ctx.port.request({ eventId: 'auth:whoami', payload: null, target: 'auth' });
 *     console.log(user);
 *   },
 *   control: () => ({ commands: {}, views: {} }),
 * });
 * ```
 *
 * @example
 * Binding a unit's view to React without an adapter
 * ```tsx
 * import { useSyncExternalStore } from 'react';
 * import type { Kernel } from '@webkrnl/core';
 *
 * function KeyCount({ kernel }: { kernel: Kernel }) {
 *   const view = kernel.unit('storage').control!.views.state;
 *   const state = useSyncExternalStore(view.subscribe, view.getSnapshot) as { keys: number };
 *   return <span>{state.keys}</span>;
 * }
 * ```
 *
 * @see [Package README](../README.md)
 * @see [Architecture](../../../docs/ARCHITECTURE.md)
 * @author MathAid
 */

export * from './backoff';
export * from './dependency';
export * from './lifecycle';
export * from './packet';
export * from './processor';
export * from './ring';
export * from './scope';
export * from './state';
export * from './transport';
export * from './unit';
export * from './view';
