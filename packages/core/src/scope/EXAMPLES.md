# Examples: `@webkrnl/core` — the scope module

The Global wire protocol, and the route source Page scope ends on.

## Send a packet to a server

<!-- example id="core/wire-protocol" runtime="any" -->

Global packets travel as JSON in the versioned wire format. `encodeWire` checks an envelope before it leaves, and `decodeWire` checks what arrives.

```ts file=main.ts
import { WireProtocolError, createEnvelope, decodeWire, encodeWire } from '@webkrnl/core';

let n = 0;
const envelope = createEnvelope(
  { eventId: 'chat:message', payload: { text: 'Hello' }, target: 'chat' },
  { source: 'app', scope: 'global', ids: () => `id-${++n}`, now: () => 1_700_000_000_000 },
);

const json = encodeWire(envelope);
console.log('wire version:', JSON.parse(json).v);

const received = decodeWire(json);
console.log('received:', received.eventId, JSON.stringify(received.payload));

try {
  decodeWire('{"v":2}');
} catch (error) {
  if (error instanceof WireProtocolError) console.log('refused:', error.message);
}
```

```text output
wire version: 1
received: chat:message {"text":"Hello"}
refused: Unsupported wire protocol version: 2.
```

## Follow the route for Page scope

<!-- example id="core/route-source" runtime="browser" -->

Page scope ends when the path changes. The browser route source reports each completed navigation, from the Navigation API or the History API. A navigation that a newer one interrupts is not reported.

```ts file=main.ts
import { createBrowserRouteSource } from '@webkrnl/core';

const routes = createBrowserRouteSource();
console.log('start:', routes.current());

const stop = routes.subscribe((path) => console.log('page changed to', path));
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
history.pushState(null, '', '/settings');
await settle();
history.pushState(null, '', '/settings/profile');
await settle();
stop();
```

```text output
start: /
page changed to /settings
page changed to /settings/profile
```
