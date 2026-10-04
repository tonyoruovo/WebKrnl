/**
 * @fileoverview
 * @summary The Auth subsystem: sessions, token refresh, permissions, elevations and status in every tab of the site.
 *
 * @description
 * `createAuth` gives the subsystem `auth` (featurized, Window scope). The app
 * gives handlers that talk to its server. Network is optional, and Storage
 * is late-bound (docs/ARCHITECTURE.md §19.2).
 *
 * ```text
 *   login(credentials) --> handlers.login --> session (memory; encrypted Storage collection 'auth.session')
 *                                         --> refresh timer (refreshBeforeMs before expiry)
 *                                         --> 'auth:changed' to every tab (status, user id; never a token)
 *   Network interceptor  token --> requests to protectedOrigins only
 *                        401   --> refresh (one at a time, Web Lock across tabs) --> send again
 *   another tab: 'auth:changed' --> load the session from Storage, or sign out
 *   ```
 *
 * @example
 * Signing in
 * ```ts
 * const kernel = new Kernel([createNetwork(), createAuth({ handlers })]);
 * await kernel.start();
 * await kernel.unit<AuthControl<Credentials>>(AUTH_ID).control!.commands.login({ email, password });
 * ```
 *
 * @author MathAid
 */

import {
  computeBackoff,
  defineSubsystem,
  type ControlInterface,
  type SubsystemDefinition,
  type UnitContext,
} from '@platform/core';

import type {
  AccessRequirement,
  AuthChanged,
  AuthControl,
  AuthData,
  AuthNetwork,
  AuthOptions,
  AuthSession,
  AuthTools,
  AuthUser,
  Elevation,
} from './types';

/**
 * @summary The id of the Auth subsystem.
 * @public
 */
export const AUTH_ID = 'auth';

/**
 * @summary The Window broadcast after each change of the session. The payload is an {@linkcode AuthChanged}.
 * @public
 */
export const AUTH_CHANGED = 'auth:changed';

/**
 * @summary The Storage collection that keeps the session.
 * @public
 */
export const SESSION_COLLECTION = 'auth.session';

/**
 * @summary Too many logins failed, so login is locked for a while.
 * @example
 * Showing the wait
 * ```ts
 * catch (error) { if (error instanceof AuthLockedError) showWait(error.until); }
 * ```
 * @public
 */
export class AuthLockedError extends Error {
  /**
   * @summary The name of the error: `AuthLockedError`.
   */
  override readonly name = 'AuthLockedError';

  /**
   * @summary Makes the error.
   * @param {number} until When login is allowed again, in Unix milliseconds.
   */
  constructor(
    /**
     * @summary When login is allowed again, in Unix milliseconds.
     */
    readonly until: number,
  ) {
    super('[auth] Too many failed logins. Try again later.');
  }
}

/** The header that marks the requests of handlers, so they skip the refresh logic. */
const SKIP = 'x-platform-auth-skip';

/** The parts of the Network that Auth uses. It does not import the package. */
interface NetworkLike extends ControlInterface {
  readonly commands: AuthNetwork['commands'] & {
    intercept(interceptor: {
      request?(r: { id: string; url: string; headers: Readonly<Record<string, string>> }): {
        id: string;
        url: string;
        headers: Readonly<Record<string, string>>;
      };
      response?(
        response: { status: number },
        request: { id: string; headers: Readonly<Record<string, string>> },
      ): 'retry' | void | Promise<'retry' | void>;
    }): () => void;
  };
}

/** The part of a Storage collection that Auth uses. */
interface SessionStore {
  get(key: string): Promise<AuthSession | undefined>;
  set(key: string, value: AuthSession): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The part of Storage that Auth uses. */
interface StorageLike extends ControlInterface {
  readonly commands: {
    collection(definition: { name: string; encrypt?: boolean }): SessionStore;
  };
}

function statusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
}

/**
 * @summary Makes the Auth subsystem.
 *
 * @example
 * Example 1: An app
 * ```ts
 * createAuth({ handlers: { login, refresh, logout }, protectedOrigins: ['https://api.shop.example'] });
 * ```
 *
 * @example
 * Example 2: Memory only, for tests
 * ```ts
 * createAuth({ handlers, persist: false, lockout: false });
 * ```
 *
 * @param {AuthOptions<C>} options The handlers, origins, refresh timing, lockout and persistence.
 * @returns {SubsystemDefinition<AuthData, AuthControl<C>>} The definition, for the kernel.
 * @template C The type of the credentials.
 * @public
 */
export function createAuth<C = unknown>(
  options: AuthOptions<C>,
): SubsystemDefinition<AuthData, AuthControl<C>> {
  const now = options.now ?? Date.now;
  const handlers = options.handlers;
  const refreshBeforeMs = options.refreshBeforeMs ?? 60_000;
  const lockout =
    options.lockout === false
      ? null
      : {
          maxAttempts: options.lockout?.maxAttempts ?? 5,
          durationMs: options.lockout?.durationMs ?? 300_000,
        };
  const persist = options.persist ?? 'encrypted';
  const restoreOnStart = options.restoreOnStart ?? true;
  const origins = new Set(
    options.protectedOrigins ??
      (typeof location !== 'undefined' && location.origin && location.origin !== 'null'
        ? [location.origin]
        : []),
  );

  let session: AuthSession | null = null;
  let elevations: Elevation[] = [];
  let store: SessionStore | null = null;
  let network: NetworkLike | null = null;
  let refreshing: Promise<boolean> | null = null;
  let restoring: Promise<boolean> | null = null;
  // Grows with each sign-out, so a restore that started before it is dropped.
  let signOuts = 0;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let context: UnitContext<AuthData> | null = null;
  const skip = new Set<string>();

  const tools = (): AuthTools => ({
    network: network
      ? {
          commands: {
            request: (config) =>
              network!.commands.request({ ...config, headers: { ...config.headers, [SKIP]: '1' } }),
            post: (url, body) =>
              network!.commands.request({ url, method: 'POST', body, headers: { [SKIP]: '1' } }),
          },
        }
      : null,
    fetch: options.fetch ?? ((input, init) => globalThis.fetch(input, init)),
  });

  const announce = (reason: AuthChanged['reason']) => {
    const ctx = context;
    if (!ctx) return;
    const payload: AuthChanged = {
      status: ctx.state.get().status,
      userId: session?.user.id ?? null,
      reason,
    };
    ctx.port
      .send({ eventId: AUTH_CHANGED, payload, importance: 'HIGH' })
      .catch((error: unknown) => ctx.report(error));
  };

  const activeElevations = () => {
    const t = now();
    if (elevations.some((e) => e.expiresAt <= t)) {
      elevations = elevations.filter((e) => e.expiresAt > t);
      context?.state.update(
        (s) => void (s.elevations = elevations.map(({ token: _token, ...rest }) => rest)),
      );
    }
    return elevations;
  };

  function schedule() {
    clearTimeout(timer);
    timer = undefined;
    if (!session?.refreshToken || session.accessExpiresAt === null) return;
    const wait = Math.max(0, session.accessExpiresAt - refreshBeforeMs - now());
    timer = setTimeout(() => void refreshNow(), wait);
    (timer as { unref?: () => void }).unref?.();
  }

  /** Adopts a session: memory, state and the refresh timer. Nothing is stored or broadcast. */
  function adopt(next: AuthSession | null) {
    session = next;
    if (!next) {
      clearTimeout(timer);
      elevations = [];
    } else {
      schedule();
    }
    context?.state.update((s) => {
      s.status = next ? 'AUTHENTICATED' : 'UNAUTHENTICATED';
      s.user = next
        ? { ...next.user, roles: [...next.user.roles], permissions: [...next.user.permissions] }
        : null;
      s.expiresAt = next?.accessExpiresAt ?? null;
      if (!next) s.elevations = [];
    });
  }

  async function save(next: AuthSession | null) {
    if (!store) return;
    try {
      if (next) await store.set('current', next);
      else await store.delete('current');
    } catch (error) {
      context?.report(error);
    }
  }

  /** Asks the server for a session with the restore handler. One restore runs at a time. */
  function restoreNow(): Promise<boolean> {
    if (session) return Promise.resolve(true);
    const restore = handlers.restore;
    if (!restore) return Promise.resolve(false);
    restoring ??= (async () => {
      const ctx = context;
      const started = signOuts;
      const before = ctx?.state.get().status;
      if (before === 'UNAUTHENTICATED')
        ctx?.state.update((s) => void (s.status = 'AUTHENTICATING'));
      try {
        const restored = await restore(tools());
        if (session) return true; // a login or a stored session came first
        if (signOuts !== started) return false; // a sign-out came while the server answered
        // Another tab of this origin may have stored a session meanwhile: one origin shares one session.
        const stored = await store?.get('current').catch(() => undefined);
        if (session) return true;
        if (signOuts !== started) return false;
        if (stored) {
          adopt(stored);
          return true;
        }
        if (!restored) {
          ctx?.state.update((s) => void (s.status = before ?? 'UNAUTHENTICATED'));
          return false;
        }
        adopt(restored);
        await save(restored);
        announce('restore');
        return true;
      } catch (error) {
        // A failed restore is not a failed login: no lockout count.
        ctx?.report(error);
        if (!session) ctx?.state.update((s) => void (s.status = before ?? 'UNAUTHENTICATED'));
        return false;
      }
    })().finally(() => {
      restoring = null;
    });
    return restoring;
  }

  function refreshNow(): Promise<boolean> {
    if (!session?.refreshToken) return Promise.resolve(false);
    refreshing ??= (async () => {
      const work = async () => {
        // Another tab may have refreshed already: rotating refresh tokens allow one refresh.
        const stored = await store?.get('current').catch(() => undefined);
        if (
          stored &&
          session &&
          stored.user.id === session.user.id &&
          (stored.accessExpiresAt ?? 0) > (session.accessExpiresAt ?? 0)
        ) {
          adopt(stored);
          return true;
        }
        const current = session;
        if (!current) return false;
        const retries = options.refreshRetries ?? 3;
        for (let attempt = 0; ; attempt++) {
          try {
            const tokens = await handlers.refresh(current, tools());
            const next: AuthSession = {
              user: tokens.user ?? current.user,
              accessToken: tokens.accessToken,
              refreshToken: tokens.refreshToken,
              accessExpiresAt: tokens.accessExpiresAt,
            };
            adopt(next);
            await save(next);
            announce('refresh');
            return true;
          } catch (error) {
            const status = statusOf(error);
            const definitive = status !== null && status >= 400 && status < 500;
            if (definitive || attempt >= retries) {
              context?.report(error);
              context?.state.update((s) => void (s.status = 'EXPIRED'));
              announce('expired');
              return false;
            }
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                computeBackoff({ base: 500, attempts: attempt, strategy: 'exponential-jitter' }),
              ),
            );
          }
        }
      };
      const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
      return locks ? locks.request('platform-auth:refresh', work) : work();
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  const readable = { readable: true } as const;
  return defineSubsystem({
    id: AUTH_ID,
    scope: 'window',
    kind: 'featurized',
    requires: [
      { target: 'network', kind: 'optional' },
      { target: 'storage', kind: 'optional' },
      { target: 'window', kind: 'optional' },
    ],
    subscribes: [AUTH_CHANGED],
    state: {
      initial: {
        status: 'UNAUTHENTICATED',
        user: null,
        expiresAt: null,
        elevations: [],
        failedAttempts: 0,
        lockedUntil: null,
        persistent: false,
      } as AuthData,
      policy: {
        status: readable,
        user: readable,
        expiresAt: readable,
        elevations: readable,
        failedAttempts: readable,
        lockedUntil: readable,
        persistent: readable,
      },
    },

    init(ctx) {
      context = ctx;
      // Storage is in the kernel and can still start: wait for it before a restore at start,
      // so a stored session of this origin wins over a new one from the server.
      const storageComing = () => {
        const status = ctx.statuses.getSnapshot()['storage']?.status;
        return (
          persist !== false && status !== undefined && status !== 'FAILED' && status !== 'DESTROYED'
        );
      };
      const stopWaiting = ctx.statuses.subscribe(() => {
        if (started || session || store || !restoreOnStart || storageComing()) return;
        started = true; // Storage will not come: restore now, one time.
        void restoreNow();
      });
      const stopStorage = ctx.watch<StorageLike>('storage', (storage) => {
        store =
          storage && persist !== false
            ? storage.commands.collection({
                name: SESSION_COLLECTION,
                encrypt: persist === 'encrypted',
              })
            : null;
        ctx.state.update((s) => void (s.persistent = store !== null));
        // The start: load the stored session (or restore) one time, not after each restart of Storage.
        if (session || started) return;
        if (store) started = true;
        const at = signOuts;
        if (!store) {
          if (restoreOnStart && !storageComing()) {
            started = true;
            void restoreNow();
          }
          return;
        }
        // A reload: take the stored session back, else ask the server.
        void store
          .get('current')
          .then(async (stored) => {
            if (session || signOuts !== at) return;
            if (!stored) {
              if (restoreOnStart) await restoreNow();
              return;
            }
            adopt(stored);
            if (stored.accessExpiresAt !== null && stored.accessExpiresAt <= now())
              await refreshNow();
          })
          .catch((error: unknown) => ctx.report(error));
      });
      let stopInterceptor: (() => void) | undefined;
      const stopNetwork = ctx.watch<NetworkLike>('network', (control) => {
        stopInterceptor?.();
        stopInterceptor = undefined;
        network = control ?? null;
        if (!control) return;
        stopInterceptor = control.commands.intercept({
          request(request) {
            if (request.headers[SKIP] !== undefined) {
              const { [SKIP]: _mark, ...headers } = request.headers;
              skip.add(request.id);
              return { ...request, headers };
            }
            if (!session || !origins.has(new URL(request.url).origin)) return request;
            return {
              ...request,
              headers: { ...request.headers, authorization: `Bearer ${session.accessToken}` },
            };
          },
          async response(response, request) {
            if (skip.delete(request.id)) return undefined;
            if (response.status !== 401 || !session) return undefined;
            const sent = request.headers.authorization;
            if (!sent?.startsWith('Bearer ')) return undefined;
            // The token changed while the request was out: send it again with the new one.
            if (sent !== `Bearer ${session.accessToken}`) return 'retry';
            return (await refreshNow()) ? 'retry' : undefined;
          },
        });
      });
      return () => {
        stopWaiting();
        stopStorage();
        stopNetwork();
        stopInterceptor?.();
        clearTimeout(timer);
        // Sensitive data leaves memory with the unit.
        session = null;
        elevations = [];
        store = null;
        network = null;
        context = null;
        started = false;
      };
    },

    receive(packet, ctx) {
      const change = packet.take() as AuthChanged;
      if (change.status === 'UNAUTHENTICATED') {
        signOuts++;
        if (session) {
          adopt(null);
          void save(null);
        }
        return;
      }
      if (change.status !== 'AUTHENTICATED') return;
      // Same origin: the session is in Storage. Another subdomain: ask the server (the apex cookie).
      const at = signOuts;
      void (store?.get('current') ?? Promise.resolve(undefined))
        .then(async (stored) => {
          if (signOuts !== at) return; // a sign-out came while Storage answered
          if (stored && stored.accessToken !== session?.accessToken) adopt(stored);
          else if (!stored && !session) await restoreNow();
        })
        .catch((error: unknown) => ctx.report(error));
    },

    control: (ctx) => {
      const user = () => session?.user ?? null;
      const hasPermission = (permission: string) => {
        const current = user();
        if (!current) return false;
        if (current.permissions.includes('*') || current.permissions.includes(permission))
          return true;
        return activeElevations().some((e) => e.permissions.includes(permission));
      };
      const hasRole = (role: string) => user()?.roles.includes(role) ?? false;
      return {
        commands: {
          async login(credentials: C) {
            const lockedUntil = ctx.state.get().lockedUntil;
            if (lockedUntil !== null && lockedUntil > now()) throw new AuthLockedError(lockedUntil);
            ctx.state.update((s) => void (s.status = 'AUTHENTICATING'));
            try {
              const next = await handlers.login(credentials, tools());
              ctx.state.update((s) => {
                s.failedAttempts = 0;
                s.lockedUntil = null;
              });
              adopt(next);
              await save(next);
              announce('login');
              return next.user;
            } catch (error) {
              ctx.state.update((s) => {
                s.status = session ? 'AUTHENTICATED' : 'UNAUTHENTICATED';
                s.failedAttempts++;
                if (lockout && s.failedAttempts >= lockout.maxAttempts)
                  s.lockedUntil = now() + lockout.durationMs;
              });
              throw error;
            }
          },
          async logout() {
            signOuts++;
            const current = session;
            if (current && handlers.logout) {
              await handlers.logout(current, tools()).catch((error: unknown) => ctx.report(error));
            }
            adopt(null);
            await save(null);
            announce('logout');
          },
          refresh: () => refreshNow(),
          restore: () => restoreNow(),
          accessToken: () => session?.accessToken ?? null,
          hasPermission,
          hasRole,
          check(requirement: AccessRequirement) {
            const current = user();
            if (!current) return false;
            if (requirement.level !== undefined && current.level < requirement.level) return false;
            if (requirement.roles?.length && !requirement.roles.some(hasRole)) return false;
            return (requirement.permissions ?? []).every(hasPermission);
          },
          async elevate(permissions: readonly string[], durationMs: number, reason: string) {
            const current = session;
            if (!current) throw new Error('[auth] No user is signed in.');
            if (!handlers.elevate) throw new Error('[auth] The app gave no elevate handler.');
            const elevation = await handlers.elevate(
              { permissions, durationMs, reason },
              current,
              tools(),
            );
            elevations = [...activeElevations(), elevation];
            const { token: _token, ...visible } = elevation;
            ctx.state.update((s) => void s.elevations.push(visible));
            return visible;
          },
          elevationToken: (permission: string) =>
            activeElevations().find((e) => e.permissions.includes(permission))?.token ?? null,
        },
        views: { state: ctx.state.readable },
      };
    },
  });
}

/**
 * @summary Tells if a user meets a requirement, without the subsystem. Elevations are not counted.
 * @example
 * In a server-rendered guard
 * ```ts
 * meetsRequirement(user, { roles: ['ADMIN'] });
 * ```
 * @param {AuthUser | null} user The user.
 * @param {AccessRequirement} requirement The requirement.
 * @returns {boolean} `true` when every part passes.
 * @public
 */
export function meetsRequirement(user: AuthUser | null, requirement: AccessRequirement): boolean {
  if (!user) return false;
  if (requirement.level !== undefined && user.level < requirement.level) return false;
  if (requirement.roles?.length && !requirement.roles.some((role) => user.roles.includes(role)))
    return false;
  const all = user.permissions.includes('*');
  return (requirement.permissions ?? []).every((p) => all || user.permissions.includes(p));
}
