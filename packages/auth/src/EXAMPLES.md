# Examples: `@platform/auth`

Auth keeps the session of the user. The app gives handlers that talk to its server, so any login (password, MFA, OAuth) works. These examples use fake handlers and a fake `fetch`, and keep the session in memory (`persist: false`), so they run in every sandbox.

## Sign in and check permissions

<!-- example id="auth/login-and-permissions" runtime="any" -->

An admin console signs the user in, then shows a menu by role and a button by permission. The state that every unit can read has the user, never a token.

```ts file=main.ts
import { AUTH_ID, createAuth, type AuthControl, type AuthSession } from '@platform/auth';
import { Kernel } from '@platform/core';

interface Credentials {
  email: string;
  password: string;
}

const auth = createAuth<Credentials>({
  persist: false,
  handlers: {
    // In an app, these call your server.
    login: async (credentials): Promise<AuthSession> => {
      if (credentials.password !== 'correct horse') throw new Error('Wrong email or password.');
      return {
        user: { id: 'u7', name: 'Ada', roles: ['EDITOR'], permissions: ['posts:write'], level: 40 },
        accessToken: 'secret-access-token',
        refreshToken: 'secret-refresh-token',
        accessExpiresAt: null,
      };
    },
    refresh: async (session) => session,
  },
});

const kernel = new Kernel([auth]);
await kernel.start();
const { commands, views } = kernel.unit<AuthControl<Credentials>>(AUTH_ID).control!;

try {
  await commands.login({ email: 'ada@example.com', password: 'guess' });
} catch (error) {
  console.log('first try:', (error as Error).message, 'failed attempts:', views.state.getSnapshot().failedAttempts);
}
const user = await commands.login({ email: 'ada@example.com', password: 'correct horse' });
console.log('signed in:', user.name, views.state.getSnapshot().status);
console.log('can write posts:', commands.hasPermission('posts:write'));
console.log('admin menu:', commands.check({ roles: ['ADMIN'] }));
console.log('token in state:', JSON.stringify(views.state.getSnapshot()).includes('secret'));
await commands.logout();
console.log('after logout:', views.state.getSnapshot().status);
await kernel.stop();
```

```text output
first try: Wrong email or password. failed attempts: 1
signed in: Ada AUTHENTICATED
can write posts: true
admin menu: false
token in state: false
after logout: UNAUTHENTICATED
```

## Send the token to your API, and refresh it on a 401

<!-- example id="auth/network-token" runtime="any" -->

With Network in the kernel, Auth adds the token to requests for your API only, never to other origins. When the API answers `401`, Auth refreshes the token one time and the Network sends the request again.

```ts file=main.ts
import { AUTH_ID, createAuth, type AuthControl } from '@platform/auth';
import { Kernel } from '@platform/core';
import { NETWORK_ID, createNetwork, type NetworkControl } from '@platform/network';

let valid = 'token-1';
const sent: string[] = [];
// A fake API that accepts only the newest token.
const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const authorization = request.headers.get('authorization');
  sent.push(`${new URL(request.url).host} ${authorization ?? 'no token'}`);
  if (!request.url.startsWith('https://api.shop.example')) return Response.json('public');
  return authorization === `Bearer ${valid}` ? Response.json('your orders') : new Response(null, { status: 401 });
};

let issued = 0;
const kernel = new Kernel([
  createNetwork({ fetch, baseUrl: 'https://shop.example/' }),
  createAuth<null>({
    persist: false,
    protectedOrigins: ['https://api.shop.example'],
    handlers: {
      login: async () => ({
        user: { id: 'u1', roles: [], permissions: [], level: 1 },
        accessToken: `token-${++issued}`,
        refreshToken: 'r',
        accessExpiresAt: null,
      }),
      refresh: async () => ({ accessToken: `token-${++issued}`, refreshToken: 'r', accessExpiresAt: null }),
    },
  }),
]);
await kernel.start();
const auth = kernel.unit<AuthControl<null>>(AUTH_ID).control!;
const network = kernel.unit<NetworkControl>(NETWORK_ID).control!;

await auth.commands.login(null);
await network.commands.get('https://cdn.example/logo.svg');
valid = 'token-2'; // the server rotated its keys: token-1 is refused now
const orders = await network.commands.get<string>('https://api.shop.example/orders');
console.log('data:', orders.data);
for (const line of sent) console.log(line);
await kernel.stop();
```

```text output
data: your orders
cdn.example no token
api.shop.example Bearer token-1
api.shop.example Bearer token-2
```

## Ask for more permissions for a short time

<!-- example id="auth/elevation" runtime="any" -->

A support agent refunds an order. The refund needs a permission that the agent gets only after a second check, for a few minutes. The elevation expires by itself.

```ts file=main.ts
import { AUTH_ID, createAuth, type AuthControl } from '@platform/auth';
import { Kernel } from '@platform/core';

const kernel = new Kernel([
  createAuth<null>({
    persist: false,
    handlers: {
      login: async () => ({
        user: { id: 'agent-3', roles: ['SUPPORT'], permissions: ['orders:read'], level: 20 },
        accessToken: 'a',
        refreshToken: null,
        accessExpiresAt: null,
      }),
      refresh: async (session) => session,
      // In an app, the server checks a PIN or a second factor here.
      elevate: async (request) => ({
        token: 'elevation-proof',
        permissions: request.permissions,
        expiresAt: Date.now() + request.durationMs,
        reason: request.reason,
      }),
    },
  }),
]);
await kernel.start();
const { commands } = kernel.unit<AuthControl<null>>(AUTH_ID).control!;
await commands.login(null);

console.log('can refund:', commands.hasPermission('orders:refund'));
await commands.elevate(['orders:refund'], 50, 'Refund for order 42');
console.log('can refund now:', commands.hasPermission('orders:refund'));
console.log('proof for the server:', commands.elevationToken('orders:refund'));
await new Promise((resolve) => setTimeout(resolve, 80));
console.log('can refund later:', commands.hasPermission('orders:refund'));
await kernel.stop();
```

```text output
can refund: false
can refund now: true
proof for the server: elevation-proof
can refund later: false
```

## Sign in on another subdomain with the apex cookie

<!-- example id="auth/restore" runtime="any" -->

A user signs in on `shop.example.com`, then opens `account.example.com`. Storage is per origin, so the second site cannot read the first one's session, and tokens never travel between them. Instead, the server keeps an `HttpOnly` session cookie on `example.com`, and the `restore` handler asks the server for a session for this origin.

```ts file=main.ts
import { AUTH_ID, createAuth, type AuthControl, type AuthHandlers, type AuthSession } from '@platform/auth';
import { Kernel } from '@platform/core';

// A fake server. In a browser, the cookie is HttpOnly on the apex domain: no script can read it.
const server = { cookie: false, issued: 0 };
const issue = (): AuthSession => ({
  user: { id: 'u1', name: 'Ada', roles: [], permissions: [], level: 1 },
  accessToken: `token-for-this-origin-${++server.issued}`,
  refreshToken: null,
  accessExpiresAt: null,
});
const handlers: AuthHandlers<null> = {
  login: async () => {
    server.cookie = true; // Set-Cookie: session=…; HttpOnly; Secure; SameSite=Lax; Domain=example.com
    return issue();
  },
  refresh: async (session) => session,
  logout: async () => {
    server.cookie = false; // the server clears the cookie
  },
  restore: async () => (server.cookie ? issue() : null), // POST /auth/restore, with the cookie
};

async function site() {
  const kernel = new Kernel([createAuth<null>({ handlers, persist: false })]);
  await kernel.start();
  return { kernel, auth: kernel.unit<AuthControl<null>>(AUTH_ID).control! };
}

const shop = await site();
await shop.auth.commands.login(null);
console.log('shop:', shop.auth.views.state.getSnapshot().status);

// account.example.com opens later. At start, it asks the server.
const account = await site();
while (account.auth.views.state.getSnapshot().status !== 'AUTHENTICATED') {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
console.log('account:', account.auth.views.state.getSnapshot().status, 'user:', account.auth.views.state.getSnapshot().user?.name);
console.log('same token:', shop.auth.commands.accessToken() === account.auth.commands.accessToken());

await shop.auth.commands.logout();
const later = await site();
console.log('restored after logout:', await later.auth.commands.restore());
for (const s of [shop, account, later]) await s.kernel.stop();
```

```text output
shop: AUTHENTICATED
account: AUTHENTICATED user: Ada
same token: false
restored after logout: false
```
