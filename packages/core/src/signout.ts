/**
 * @fileoverview
 * @summary The sign-out signal: tells a unit when to wipe the data of the signed-in user.
 * @description
 * Every subsystem wipes the user data that it keeps when the user signs out,
 * or when another user signs in (docs/ARCHITECTURE.md §5.1). Auth only
 * announces. Its broadcast has Window scope, which a Tab-scoped unit cannot
 * subscribe to, so units watch the state of Auth instead. This helper does
 * that once for every unit.
 *
 * ```text
 *   Auth state   AUTHENTICATED (u1) --> UNAUTHENTICATED       --> listener('sign-out')
 *                AUTHENTICATED (u1) --> AUTHENTICATED (u2)    --> listener('user-changed')
 *                EXPIRED (u1)       --> AUTHENTICATED (u2)    --> listener('user-changed')
 *                a refresh of u1, a restore at start, Auth stopping --> nothing
 *   ```
 *
 * The unit must declare `{ target: 'auth', kind: 'optional' }` in `requires`.
 *
 * @example
 * Wiping a cache
 * ```ts
 * init(ctx) {
 *   return watchSignOut(ctx, () => cache.clear());
 * }
 * ```
 *
 * @author MathAid
 */

import type { ControlInterface, UnitContext } from './unit';
import type { View } from './view';

/**
 * @summary Why a unit must wipe the data of the user.
 * @public
 */
export type SignOutReason = 'sign-out' | 'user-changed';

/** The part of Auth that the signal reads. The core does not import `@platform/auth`. */
interface AuthStateSource extends ControlInterface {
  readonly views: {
    readonly state: View<{
      readonly status?: string;
      readonly user?: { readonly id: string } | null;
    }>;
  };
}

/**
 * @summary Calls a listener when the user signs out, or when another user signs in.
 * @description
 * It watches the unit `auth` (or another target) and its state view. A
 * refresh of the same user, a session restored at start, and Auth stopping
 * are not sign-outs. The listener must wipe the user data of the unit: its
 * state, its persisted state, its Storage collections, its memory and its
 * processors (docs/ARCHITECTURE.md §5.1).
 * @example
 * Example 1: In a subsystem
 * ```ts
 * requires: [{ target: 'auth', kind: 'optional' }],
 * init(ctx) {
 *   return watchSignOut(ctx, async () => {
 *     ctx.state.update((s) => void (s.items = []));
 *     await collection.clear();
 *   });
 * }
 * ```
 * @example
 * Example 2: Telling the reasons apart
 * ```ts
 * watchSignOut(ctx, (reason) => console.info(reason)); // 'sign-out' or 'user-changed'
 * ```
 * @param {UnitContext<any>} ctx The context of the unit. It must declare the target as a dependency.
 * @param {Function} listener Wipes the data. A rejected promise is reported.
 * @param {string} [target] The id of the Auth subsystem. The default is `auth`.
 * @returns {() => void} Stops watching.
 * @throws {Error} When the unit does not declare the target in `requires`.
 * @public
 */
export function watchSignOut(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: UnitContext<any>,
  listener: (reason: SignOutReason) => void | Promise<void>,
  target = 'auth',
): () => void {
  let stopView: (() => void) | undefined;
  // The id of the user whose data the unit may keep; null when nobody is signed in.
  let owner: string | null = null;
  const fire = (reason: SignOutReason) => {
    try {
      void Promise.resolve(listener(reason)).catch((error: unknown) => ctx.report(error));
    } catch (error) {
      ctx.report(error);
    }
  };
  const stopWatch = ctx.watch<AuthStateSource>(target, (auth) => {
    stopView?.();
    stopView = undefined;
    if (!auth) return; // Auth stopped: that is not a sign-out.
    const read = () => {
      const { status, user } = auth.views.state.getSnapshot();
      const id = user?.id ?? null;
      if (status === 'UNAUTHENTICATED') {
        if (owner !== null) fire('sign-out');
        owner = null;
      } else if (id !== null) {
        if (owner !== null && id !== owner) fire('user-changed');
        owner = id;
      }
    };
    stopView = auth.views.state.subscribe(read);
    read();
  });
  return () => {
    stopWatch();
    stopView?.();
  };
}
