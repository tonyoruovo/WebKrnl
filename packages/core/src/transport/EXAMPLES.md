# Examples: `@webkrnl/core` — the transport module

Carrying envelopes between two realms over a `MessageChannel`.

## Talk to another realm over a MessageChannel

<!-- example id="core/transport" runtime="any" -->

A transport carries envelopes between two realms, for example a page and a worker. Each side sets a handler, and a request resolves with the reply of the other side.

```ts file=main.ts
import { createChannelTransportPair, createEnvelope } from '@webkrnl/core';

const [page, worker] = createChannelTransportPair();

worker.onEnvelope((envelope) => {
  const { a, b } = envelope.payload as { a: number; b: number };
  return { sum: a + b };
});

const envelope = createEnvelope(
  { eventId: 'math:add', payload: { a: 2, b: 3 }, target: 'math' },
  { source: 'app', scope: 'tab' },
);
console.log('reply:', JSON.stringify(await page.request(envelope)));

page.close();
worker.close();
```

```text output
reply: {"sum":5}
```
