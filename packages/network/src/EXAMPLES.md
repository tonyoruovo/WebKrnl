# Examples: `@webkrnl/network`

The Network sends requests for every subsystem: with timeouts, retries, a shared fetch for identical requests, a cache, a circuit breaker and interceptors. These examples give the Network a fake `fetch`, so they run in every sandbox without a server.

## Retry a busy server

<!-- example id="network/retries" runtime="any" -->

A product API answers `503` under load. The Network waits (it honours `Retry-After`) and sends the `GET` again. A `POST` retries only with an idempotency key, so a payment is never sent twice by accident.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import { NETWORK_ID, createNetwork, type NetworkControl } from '@webkrnl/network';

const seen = new Set<string>();
// A fake server: the first request to each URL gets 503.
const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (!seen.has(request.url)) {
    seen.add(request.url);
    return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
  }
  return Response.json({ ok: true, key: request.headers.get('idempotency-key') });
};

const kernel = new Kernel([createNetwork({ baseUrl: 'https://api.shop.example/', fetch, retryBaseMs: 1 })]);
await kernel.start();
const { commands } = kernel.unit<NetworkControl>(NETWORK_ID).control!;

const products = await commands.get('/products');
console.log('GET attempts:', products.attempts);

const pay = await commands.post<{ key: string }>('/payments', { amount: 30 }, { idempotencyKey: 'order-42' });
console.log('POST attempts:', pay.attempts, 'key:', pay.data.key);
await kernel.stop();
```

```text output
GET attempts: 2
POST attempts: 2 key: order-42
```

## Cache a response, and check it with an ETag

<!-- example id="network/cache-etag" runtime="any" -->

A settings screen loads the same data often. With `cache-first`, a fresh entry answers at once. When the entry is stale, the Network asks the server with `If-None-Match`, and a `304` reuses the cached body.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import { NETWORK_ID, createNetwork, type NetworkControl } from '@webkrnl/network';

let requests = 0;
const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  requests++;
  const request = new Request(input, init);
  if (request.headers.get('if-none-match') === '"v1"') return new Response(null, { status: 304 });
  return Response.json({ theme: 'dark' }, { headers: { etag: '"v1"' } });
};

let clock = 0;
const kernel = new Kernel([createNetwork({ baseUrl: 'https://api.shop.example/', fetch, now: () => clock })]);
await kernel.start();
const { commands } = kernel.unit<NetworkControl>(NETWORK_ID).control!;

const options = { cache: 'cache-first', cacheTtlMs: 1000 } as const;
await commands.get('/settings', options);
const fresh = await commands.get('/settings', options);
console.log('fresh from cache:', fresh.fromCache, 'requests:', requests);

clock = 5000; // the entry is stale now
const checked = await commands.get<{ theme: string }>('/settings', options);
console.log('revalidated:', checked.revalidated, 'theme:', checked.data.theme, 'requests:', requests);
await kernel.stop();
```

```text output
fresh from cache: true requests: 1
revalidated: true theme: dark requests: 2
```

## Show cached data when offline

<!-- example id="network/offline" runtime="any" -->

A news app keeps working in a tunnel. With `network-first`, the Network uses the cache when the platform is offline. A request without a cached answer fails at once with `OfflineError`.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import { createGlobalState, createStaticEnvironment } from '@webkrnl/global-state';
import { NETWORK_ID, OfflineError, createNetwork, type NetworkControl } from '@webkrnl/network';

const fetch = async () => Response.json(['Rain at noon', 'Market opens']);
const environment = createStaticEnvironment();
const kernel = new Kernel([
  createGlobalState({ environment }),
  createNetwork({ baseUrl: 'https://news.example/', fetch }),
]);
await kernel.start();
const { commands, views } = kernel.unit<NetworkControl>(NETWORK_ID).control!;

await commands.get('/headlines', { cache: 'network-first' });
environment.set({ online: false });
await new Promise((resolve) => setTimeout(resolve, 0));
console.log('online:', views.state.getSnapshot().online);

const headlines = await commands.get<string[]>('/headlines', { cache: 'network-first' });
console.log('from cache:', headlines.fromCache, 'first:', headlines.data[0]);
try {
  await commands.get('/weather');
} catch (error) {
  console.log('no cache:', error instanceof OfflineError);
}
await kernel.stop();
```

```text output
online: false
from cache: true first: Rain at noon
no cache: true
```

## Stop calling a service that is down

<!-- example id="network/circuit-breaker" runtime="any" -->

A recommendations service is down. After 3 failures in a row, the breaker of its origin opens, and requests fail at once instead of waiting for timeouts. After the cool-down, one trial request closes it again.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import { CircuitOpenError, NETWORK_ID, createNetwork, type NetworkControl } from '@webkrnl/network';

let up = false;
let calls = 0;
const fetch = async () => {
  calls++;
  return up ? Response.json(['tea']) : new Response('down', { status: 502 });
};
let clock = 0;
const kernel = new Kernel([
  createNetwork({
    baseUrl: 'https://recs.example/',
    fetch,
    retries: 0,
    now: () => clock,
    breaker: { threshold: 3, cooldownMs: 10_000 },
  }),
]);
await kernel.start();
const { commands, views } = kernel.unit<NetworkControl>(NETWORK_ID).control!;

for (let i = 0; i < 4; i++) {
  try {
    await commands.get('/for-you');
  } catch (error) {
    console.log(`request ${i + 1}:`, error instanceof CircuitOpenError ? 'refused at once' : 'failed');
  }
}
console.log('breaker:', views.state.getSnapshot().breakers?.['https://recs.example']?.state, 'calls:', calls);

clock = 20_000;
up = true;
console.log('after the cool-down:', (await commands.get('/for-you')).ok);
await kernel.stop();
```

```text output
request 1: failed
request 2: failed
request 3: failed
request 4: refused at once
breaker: open calls: 3
after the cool-down: true
```

## Add a header to every request

<!-- example id="network/interceptors" runtime="any" -->

An app sends its version with each request, and logs slow responses. Interceptors do both without touching the callers. Auth uses the same mechanism for its tokens.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import { NETWORK_ID, createNetwork, type NetworkControl } from '@webkrnl/network';

const fetch = async (input: RequestInfo | URL, init?: RequestInit) =>
  Response.json({ version: new Request(input, init).headers.get('x-app-version') });

const kernel = new Kernel([createNetwork({ baseUrl: 'https://api.shop.example/', fetch })]);
await kernel.start();
const { commands } = kernel.unit<NetworkControl>(NETWORK_ID).control!;

const remove = commands.intercept({
  request: (request) => ({ ...request, headers: { ...request.headers, 'x-app-version': '2.4.0' } }),
  response: (response) => void console.log('response:', response.status, new URL(response.url).pathname),
});
const { data } = await commands.get<{ version: string }>('/status');
console.log('server saw version:', data.version);

remove();
console.log('after removal:', (await commands.get<{ version: string | null }>('/status')).data.version);
await kernel.stop();
```

```text output
response: 200 /status
server saw version: 2.4.0
after removal: null
```
