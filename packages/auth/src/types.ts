/**
 * @fileoverview
 * @summary The types of the Auth subsystem: sessions, handlers, state, options and the control interface.
 * @description
 * The app gives handlers that talk to its server ({@linkcode AuthHandlers}).
 * Auth keeps the {@linkcode AuthSession}, refreshes it, and shows only the
 * parts without secrets in its state (docs/ARCHITECTURE.md §19.2).
 *
 * @example
 * Handlers for a JSON API
 * ```ts
 * const handlers: AuthHandlers<{ email: string; password: string }> = {
 *   login: async (credentials, { network }) => (await network!.commands.post<AuthSession>('/auth/login', credentials)).data,
 *   refresh: async (session, { network }) => (await network!.commands.post<AuthSession>('/auth/refresh', { token: session.refreshToken })).data,
 * };
 * ```
 *
 * @author MathAid
 */

import type { View } from '@platform/core';

/**
 * @summary The signed-in user.
 * @example
 * Example 1: A user
 * ```ts
 * const user: AuthUser = { id: 'u1', name: 'Ada', roles: ['USER'], permissions: ['orders:read'], level: 10 };
 * ```
 * @example
 * Example 2: An administrator
 * ```ts
 * const admin: AuthUser = { id: 'u2', roles: ['ADMIN'], permissions: ['*'], level: 100 };
 * ```
 * @public
 */
export interface AuthUser {
  /**
   * @summary The id of the user.
   */
  readonly id: string;
  /**
   * @summary The display name.
   */
  readonly name?: string;
  /**
   * @summary The roles, for example `USER` or `ADMIN`.
   */
  readonly roles: readonly string[];
  /**
   * @summary The permissions. `*` grants every permission.
   */
  readonly permissions: readonly string[];
  /**
   * @summary The auth level, from 0 (guest) to 100 (administrator).
   */
  readonly level: number;
}

/**
 * @summary A session: the user and the tokens.
 * @description It never goes into the unit state, which every unit can read.
 * @example
 * Example 1: What a login handler returns
 * ```ts
 * // { user: { id: 'u1', roles: ['USER'], permissions: [], level: 10 }, accessToken: 'eyJ…', refreshToken: 'r1', accessExpiresAt: 1700000900000 }
 * ```
 * @example
 * Example 2: A session without expiry
 * ```ts
 * // { user, accessToken: 'opaque', refreshToken: null, accessExpiresAt: null }
 * ```
 * @public
 */
export interface AuthSession {
  /**
   * @summary The user.
   */
  readonly user: AuthUser;
  /**
   * @summary The access token.
   */
  readonly accessToken: string;
  /**
   * @summary The refresh token, or `null`.
   */
  readonly refreshToken: string | null;
  /**
   * @summary When the access token expires, in Unix milliseconds, or `null` for never.
   */
  readonly accessExpiresAt: number | null;
}

/**
 * @summary A temporary grant of more permissions.
 * @public
 */
export interface Elevation {
  /**
   * @summary The token that proves the elevation to the server.
   */
  readonly token: string;
  /**
   * @summary The permissions that it grants.
   */
  readonly permissions: readonly string[];
  /**
   * @summary When it expires, in Unix milliseconds.
   */
  readonly expiresAt: number;
  /**
   * @summary Why it was asked for.
   */
  readonly reason: string;
}

/**
 * @summary The part of the Network control that Auth gives to handlers.
 * @description Auth does not import `@platform/network`. Requests made through
 * it skip the token refresh of Auth, so a refresh handler cannot loop.
 * @public
 */
export interface AuthNetwork {
  /**
   * @summary The commands of the Network.
   */
  readonly commands: {
    /**
     * @summary Sends a request through the Network.
     * @example
     * A login request
     * ```ts
     * await network.commands.request({ url: '/auth/login', method: 'POST', body: credentials });
     * ```
     * @param config The request.
     * @returns The response of the Network.
     */
    request<T = unknown>(config: {
      url: string;
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
    }): Promise<{ readonly status: number; readonly data: T }>;
    /**
     * @summary Sends a `POST` request through the Network.
     * @example
     * A refresh request
     * ```ts
     * await network.commands.post('/auth/refresh', { token });
     * ```
     * @param {string} url The URL.
     * @param {unknown} body The body.
     * @returns The response of the Network.
     */
    post<T = unknown>(
      url: string,
      body: unknown,
    ): Promise<{ readonly status: number; readonly data: T }>;
  };
}

/**
 * @summary What a handler gets to talk to the server.
 * @example
 * Example 1: With Network
 * ```ts
 * login: async (credentials, { network }) => (await network!.commands.post<AuthSession>('/auth/login', credentials)).data
 * ```
 * @example
 * Example 2: Without Network
 * ```ts
 * login: async (credentials, { fetch }) => (await fetch('/auth/login', { method: 'POST', body: JSON.stringify(credentials) })).json()
 * ```
 * @public
 */
export interface AuthTools {
  /**
   * @summary The Network, when it runs.
   */
  readonly network: AuthNetwork | null;
  /**
   * @summary The `fetch` function.
   */
  readonly fetch: typeof fetch;
}

/**
 * @summary The functions that talk to the server of the app.
 * @description Auth does not know the shape of the credentials, so MFA,
 * OAuth and passkeys stay in these handlers.
 * @example
 * Example 1: Login and refresh
 * ```ts
 * const handlers: AuthHandlers<Credentials> = { login: loginWithPassword, refresh: refreshTokens };
 * ```
 * @example
 * Example 2: With logout and elevation
 * ```ts
 * const handlers: AuthHandlers<Credentials> = { login, refresh, logout: revoke, elevate: askForPin };
 * ```
 * @template C The type of the credentials.
 * @public
 */
export interface AuthHandlers<C> {
  /**
   * @summary Signs the user in.
   * @example
   * Password login
   * ```ts
   * login: async (c, { network }) => (await network!.commands.post<AuthSession>('/auth/login', c)).data
   * ```
   * @param {C} credentials The credentials.
   * @param {AuthTools} tools The Network and `fetch`.
   * @returns {Promise<AuthSession>} The new session.
   */
  login(credentials: C, tools: AuthTools): Promise<AuthSession>;
  /**
   * @summary Gets new tokens. It can return a new user too.
   * @example
   * A refresh
   * ```ts
   * refresh: async (s, { network }) => (await network!.commands.post<AuthSession>('/auth/refresh', { token: s.refreshToken })).data
   * ```
   * @param {AuthSession} session The current session.
   * @param {AuthTools} tools The Network and `fetch`.
   * @returns {Promise<Omit<AuthSession, 'user'> & { user?: AuthUser }>} The new tokens.
   */
  refresh(
    session: AuthSession,
    tools: AuthTools,
  ): Promise<Omit<AuthSession, 'user'> & { readonly user?: AuthUser }>;
  /**
   * @summary Tells the server that the user signs out.
   * @example
   * Revoking the refresh token
   * ```ts
   * logout: async (s, { network }) => void (await network!.commands.post('/auth/logout', { token: s.refreshToken }))
   * ```
   * @param {AuthSession} session The session.
   * @param {AuthTools} tools The Network and `fetch`.
   * @returns {Promise<void>} Resolves when the server knows.
   */
  logout?(session: AuthSession, tools: AuthTools): Promise<void>;
  /**
   * @summary Asks the server for more permissions for a short time.
   * @example
   * Asking with a PIN
   * ```ts
   * elevate: async (request, session, { network }) => (await network!.commands.post<Elevation>('/auth/elevate', request)).data
   * ```
   * @param request The permissions, the duration and the reason.
   * @param {AuthSession} session The session.
   * @param {AuthTools} tools The Network and `fetch`.
   * @returns {Promise<Elevation>} The elevation.
   */
  elevate?(
    request: {
      readonly permissions: readonly string[];
      readonly durationMs: number;
      readonly reason: string;
    },
    session: AuthSession,
    tools: AuthTools,
  ): Promise<Elevation>;
  /**
   * @summary Asks the server for a session for this origin, with the session cookie on the apex domain.
   * @description Auth calls it at start when no session is stored, and when
   * another tab announces a sign-in that this tab cannot load from Storage
   * (a tab on another subdomain). The cookie must be `HttpOnly; Secure;
   * SameSite=Lax` with `Domain` set to the apex. Tokens never travel
   * between tabs (docs/ARCHITECTURE.md §19.2).
   * @example
   * A restore endpoint
   * ```ts
   * restore: async ({ network }) => {
   *   const response = await network!.commands.request<AuthSession>({ url: '/auth/restore', method: 'POST', allowErrorStatus: true });
   *   return response.status === 200 ? response.data : null;
   * }
   * ```
   * @param {AuthTools} tools The Network and `fetch`.
   * @returns {Promise<AuthSession | null>} A session, or `null` when the server has no session.
   */
  restore?(tools: AuthTools): Promise<AuthSession | null>;
}

/**
 * @summary The status of Auth.
 * @public
 */
export type AuthStatus =
  'UNAUTHENTICATED' | 'AUTHENTICATING' | 'AUTHENTICATED' | 'EXPIRED' | 'ERROR';

/**
 * @summary The state of Auth. It has no tokens.
 * @example
 * Example 1: Signed in
 * ```ts
 * // { status: 'AUTHENTICATED', user: { id: 'u1', ... }, expiresAt: 1700000900000, elevations: [], failedAttempts: 0, lockedUntil: null, persistent: true }
 * ```
 * @example
 * Example 2: Locked out
 * ```ts
 * // { status: 'UNAUTHENTICATED', user: null, failedAttempts: 5, lockedUntil: 1700000300000, ... }
 * ```
 * @public
 */
export interface AuthData {
  /**
   * @summary The status.
   */
  status: AuthStatus;
  /**
   * @summary The user, or `null`.
   */
  user: AuthUser | null;
  /**
   * @summary When the access token expires, in Unix milliseconds, or `null`.
   */
  expiresAt: number | null;
  /**
   * @summary The active elevations, without their tokens.
   */
  elevations: Array<Omit<Elevation, 'token'>>;
  /**
   * @summary The failed logins in a row.
   */
  failedAttempts: number;
  /**
   * @summary When login is allowed again, in Unix milliseconds, or `null`.
   */
  lockedUntil: number | null;
  /**
   * @summary Tells if the session is kept in Storage, so it survives a reload.
   */
  persistent: boolean;
}

/**
 * @summary The payload of the Window broadcast `auth:changed`. It has no tokens.
 * @example
 * Example 1: A login in another tab
 * ```ts
 * // { status: 'AUTHENTICATED', userId: 'u1', reason: 'login' }
 * ```
 * @example
 * Example 2: A logout
 * ```ts
 * // { status: 'UNAUTHENTICATED', userId: null, reason: 'logout' }
 * ```
 * @public
 */
export interface AuthChanged {
  /**
   * @summary The new status.
   */
  readonly status: AuthStatus;
  /**
   * @summary The id of the user, or `null`.
   */
  readonly userId: string | null;
  /**
   * @summary What happened.
   */
  readonly reason: 'login' | 'logout' | 'refresh' | 'expired' | 'restore';
}

/**
 * @summary What `check` asks for. Every part must pass.
 * @example
 * Example 1: A permission and a level
 * ```ts
 * auth.commands.check({ permissions: ['orders:refund'], level: 50 });
 * ```
 * @example
 * Example 2: A role
 * ```ts
 * auth.commands.check({ roles: ['ADMIN'] });
 * ```
 * @public
 */
export interface AccessRequirement {
  /**
   * @summary Permissions that the user must have, all of them.
   */
  readonly permissions?: readonly string[];
  /**
   * @summary Roles of which the user must have one.
   */
  readonly roles?: readonly string[];
  /**
   * @summary The lowest auth level.
   */
  readonly level?: number;
}

/**
 * @summary Options of {@linkcode createAuth}.
 * @example
 * Example 1: An app
 * ```ts
 * createAuth({ handlers, protectedOrigins: ['https://api.shop.example'] });
 * ```
 * @example
 * Example 2: A strict lockout
 * ```ts
 * createAuth({ handlers, lockout: { maxAttempts: 3, durationMs: 15 * 60_000 } });
 * ```
 * @template C The type of the credentials.
 * @public
 */
export interface AuthOptions<C> {
  /**
   * @summary The functions that talk to the server.
   */
  readonly handlers: AuthHandlers<C>;
  /**
   * @summary The origins that get the access token. The default is the origin of the page.
   */
  readonly protectedOrigins?: readonly string[];
  /**
   * @summary How long before expiry Auth refreshes the access token, in milliseconds. The default is 60 000.
   */
  readonly refreshBeforeMs?: number;
  /**
   * @summary The retries of a failed refresh. The default is 3.
   */
  readonly refreshRetries?: number;
  /**
   * @summary The login lockout, or `false` to turn it off.
   */
  readonly lockout?:
    | {
        /**
         * @summary The failed logins in a row that lock login. The default is 5.
         */
        readonly maxAttempts?: number;
        /**
         * @summary How long login stays locked, in milliseconds. The default is 300 000.
         */
        readonly durationMs?: number;
      }
    | false;
  /**
   * @summary Calls the restore handler at start when no session is stored. The default is `true`.
   */
  readonly restoreOnStart?: boolean;
  /**
   * @summary How the session is kept in Storage: `encrypted` (the default), `plain`, or `false` for memory only.
   */
  readonly persist?: 'encrypted' | 'plain' | false;
  /**
   * @summary The `fetch` function for handlers. The default is the global `fetch`.
   */
  readonly fetch?: typeof fetch;
  /**
   * @summary The clock, in Unix milliseconds. The default is `Date.now`.
   */
  readonly now?: () => number;
}

/**
 * @summary The control interface of Auth.
 * @template C The type of the credentials.
 * @public
 */
export interface AuthControl<C = unknown> {
  /**
   * @summary The commands.
   */
  readonly commands: {
    /**
     * @summary Signs the user in with the login handler.
     * @example
     * Signing in
     * ```ts
     * const user = await commands.login({ email, password });
     * ```
     * @param {C} credentials The credentials.
     * @returns {Promise<AuthUser>} The user.
     * @throws {AuthLockedError} When too many logins failed.
     * @throws {Error} What the login handler throws.
     */
    login(credentials: C): Promise<AuthUser>;
    /**
     * @summary Signs the user out in every tab of the site.
     * @example
     * Signing out
     * ```ts
     * await commands.logout();
     * ```
     * @returns {Promise<void>} Resolves when the session is gone.
     */
    logout(): Promise<void>;
    /**
     * @summary Asks the server for a session with the restore handler (the cookie on the apex domain).
     * @description Auth calls it by itself at start and after a sign-in in
     * another tab. Call it after the server set the cookie in another way,
     * for example after an OAuth redirect.
     * @example
     * After an OAuth redirect
     * ```ts
     * if (await commands.restore()) router.push('/home');
     * ```
     * @returns {Promise<boolean>} `true` when a user is signed in afterwards.
     */
    restore(): Promise<boolean>;
    /**
     * @summary Refreshes the access token now.
     * @example
     * Before a long upload
     * ```ts
     * await commands.refresh();
     * ```
     * @returns {Promise<boolean>} `true` when the refresh worked.
     */
    refresh(): Promise<boolean>;
    /**
     * @summary Returns the access token, or `null` when no user is signed in.
     * @description Realtime and handlers of other subsystems use it. Never put it in state or logs.
     * @example
     * For a socket URL
     * ```ts
     * const token = commands.accessToken();
     * ```
     * @returns {string | null} The token.
     */
    accessToken(): string | null;
    /**
     * @summary Tells if the user has a permission, also through an active elevation.
     * @example
     * Showing a button
     * ```ts
     * if (commands.hasPermission('orders:refund')) showRefund();
     * ```
     * @param {string} permission The permission.
     * @returns {boolean} `true` when the user has it.
     */
    hasPermission(permission: string): boolean;
    /**
     * @summary Tells if the user has a role.
     * @example
     * An admin menu
     * ```ts
     * commands.hasRole('ADMIN');
     * ```
     * @param {string} role The role.
     * @returns {boolean} `true` when the user has it.
     */
    hasRole(role: string): boolean;
    /**
     * @summary Tells if the user meets a requirement: all permissions, one of the roles, and the level.
     * @example
     * A route guard
     * ```ts
     * if (!commands.check({ roles: ['ADMIN'], level: 50 })) redirect('/');
     * ```
     * @param {AccessRequirement} requirement The requirement.
     * @returns {boolean} `true` when every part passes. Without a user, `false`.
     */
    check(requirement: AccessRequirement): boolean;
    /**
     * @summary Asks for more permissions for a short time, with the elevate handler.
     * @example
     * Before a refund
     * ```ts
     * await commands.elevate(['orders:refund'], 5 * 60_000, 'Refund for order 42');
     * ```
     * @param {readonly string[]} permissions The permissions.
     * @param {number} durationMs How long, in milliseconds.
     * @param {string} reason Why.
     * @returns {Promise<Omit<Elevation, 'token'>>} The elevation, without its token.
     * @throws {Error} When no user is signed in, or there is no elevate handler.
     */
    elevate(
      permissions: readonly string[],
      durationMs: number,
      reason: string,
    ): Promise<Omit<Elevation, 'token'>>;
    /**
     * @summary Returns the token of an active elevation that grants a permission, or `null`.
     * @example
     * Proving the elevation
     * ```ts
     * headers['x-elevation'] = commands.elevationToken('orders:refund') ?? '';
     * ```
     * @param {string} permission The permission.
     * @returns {string | null} The token.
     */
    elevationToken(permission: string): string | null;
  };
  /**
   * @summary The views.
   */
  readonly views: {
    /**
     * @summary The state of Auth. It has no tokens.
     */
    readonly state: View<Partial<AuthData>>;
  };
}
