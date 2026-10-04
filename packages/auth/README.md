# @platform/auth

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

The **Auth** subsystem (id `auth`, featurized, **Window** scope). It keeps the session of the user:

- **Handlers, not endpoints**: the app gives `login`, `refresh`, and optionally `logout` and `elevate`. Auth does not know the shape of the credentials, so passwords, MFA, OAuth and passkeys all work.
- **Tokens stay secret**: the access and refresh tokens are never in the unit state. When Storage runs, the session is kept in the **encrypted** collection `auth.session`, so a reload stays signed in.
- **Refresh**: before the access token expires, and once on a `401`. One refresh runs at a time, also across tabs (a Web Lock), which rotating refresh tokens need.
- **Every tab of the site**: `auth:changed` carries the status and the user id (never a token). A sign-out in one tab signs out every tab.
- **Network**: the token goes only to `protectedOrigins` (default: the page origin), never to a third party.
- **Permissions**: roles, permissions, levels, and elevations that expire.
- **Lockout**: after repeated failed logins, `login` fails at once for a while.

Network is optional; Storage and Crypto are late-bound. Design: [ARCHITECTURE §19.2](../../docs/ARCHITECTURE.md#192-auth) and the amended [Auth proposal](../../proposals/auth_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@platform/core": "workspace:*",
    "@platform/auth": "workspace:*"
  }
}
```

## Entry points

| Import           | Contents                                                              |
| ---------------- | --------------------------------------------------------------------- |
| `@platform/auth` | `createAuth`, `meetsRequirement`, `AuthLockedError`, and the types     |

## Usage

```ts
import { createAuth, type AuthControl, type AuthHandlers, type AuthSession } from '@platform/auth';

const handlers: AuthHandlers<{ email: string; password: string }> = {
  login: async (credentials, { network }) =>
    (await network!.commands.post<AuthSession>('/auth/login', credentials)).data,
  refresh: async (session, { network }) =>
    (await network!.commands.post<AuthSession>('/auth/refresh', { token: session.refreshToken })).data,
};

const kernel = new Kernel(
  [...centralized, createCrypto(), createStorage(), createNetwork(), createAuth({ handlers, protectedOrigins: ['https://api.shop.example'] })],
  { router: queue.router },
);
await kernel.start();

const { commands, views } = kernel.unit<AuthControl<{ email: string; password: string }>>('auth').control!;
await commands.login({ email, password });
commands.hasPermission('orders:refund');
commands.check({ roles: ['ADMIN'], level: 50 });
views.state.subscribe(() => render(views.state.getSnapshot().status));
```

Requests that handlers make through `tools.network` skip the 401 refresh, so a refresh handler cannot loop.

## Behaviour

| Situation                                           | Result                                                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `login` succeeds                                    | `AUTHENTICATED`; the session is stored (encrypted); `auth:changed` to every tab           |
| `login` fails `lockout.maxAttempts` times in a row  | `AuthLockedError` until `lockedUntil`                                                     |
| The access token is near its expiry                 | Refresh `refreshBeforeMs` before it                                                       |
| The API answers `401`                               | One refresh, then the request is sent again                                               |
| The refresh is refused (4xx) or keeps failing       | `EXPIRED`; `auth:changed` with `reason: 'expired'`                                        |
| Two tabs refresh at the same time                   | One refresh; the other tab takes the stored session                                       |
| Another tab signs in or refreshes (same origin)     | This tab loads the session from Storage                                                   |
| Another tab signs out                               | This tab signs out too                                                                    |
| Auth stops                                          | Tokens and elevations leave memory                                                        |

## Options

| Option             | Default                                   | Purpose                                                   |
| ------------------ | ----------------------------------------- | --------------------------------------------------------- |
| `handlers`         | (required)                                | `login`, `refresh`, `logout?`, `elevate?`.                |
| `protectedOrigins` | the page origin                           | The origins that get the token.                           |
| `refreshBeforeMs`  | `60_000`                                  | How early to refresh.                                     |
| `refreshRetries`   | `3`                                       | Retries of a failed refresh.                              |
| `lockout`          | `{ maxAttempts: 5, durationMs: 300_000 }` | The login lockout, or `false`.                            |
| `persist`          | `'encrypted'`                             | How the session is kept in Storage, or `false`.           |
| `fetch`            | the global `fetch`                        | Given to handlers when Network does not run.              |

## Testing

```bash
pnpm exec vitest run --project node packages/auth
```
