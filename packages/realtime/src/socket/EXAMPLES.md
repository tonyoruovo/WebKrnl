# Examples: `@webkrnl/realtime` — the socket module

`createSocketProcessor` is the processor that `realtime.ts` runs on a worker host (or the main thread). These examples call it directly, with a fake socket, the way the worker entry and the virtual host do — without a kernel.

## Run the socket processor on its own

<!-- example id="realtime/socket-standalone" runtime="any" -->

`setup` takes the configuration, `handle` takes one request at a time, and the processor posts notes back with `scope.post`. A fake server here echoes a publish back as a message of the same topic.

```ts file=main.ts
import type { ProcessorScope } from '@webkrnl/core';
import { createSocketProcessor, type SocketFactory, type SocketLike } from '@webkrnl/realtime';

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.({});
    }, 1);
  }
  send(data: string | ArrayBuffer) {
    const frame = JSON.parse(String(data)) as { type: string; topic?: string; data?: unknown };
    if (frame.type === 'publish') {
      setTimeout(
        () =>
          this.onmessage?.({
            data: JSON.stringify({ type: 'message', topic: frame.topic, data: frame.data }),
          }),
        1,
      );
    }
  }
  close() {
    this.readyState = 3;
  }
}
const socket: SocketFactory = (url) => new FakeSocket(url);

const processor = createSocketProcessor({ socket });
const posts: unknown[] = [];
const scope: ProcessorScope = {
  host: 'virtual',
  shouldYield: () => false,
  yield: async () => {},
  post: (message: unknown) => posts.push(message),
};
await processor.setup?.(scope, {
  url: 'wss://chat.example/socket',
  auth: false,
  heartbeatMs: 30_000,
  heartbeatTimeoutMs: 10_000,
  maxAttempts: null,
  retryBaseMs: 500,
  publishBuffer: 10,
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

await processor.handle({ op: 'connect', token: null }, scope);
await processor.handle({ op: 'subscribe', topic: 'room' }, scope);
await wait(5); // the socket opens
await processor.handle({ op: 'publish', topic: 'room', data: { text: 'hi' } }, scope);
await wait(5); // the fake server echoes it

console.log('status:', JSON.stringify(await processor.handle({ op: 'status' }, scope)));
console.log('posts:', JSON.stringify(posts));
await processor.teardown?.();
```

```text output
status: {"status":"open","attempts":0,"lastError":null,"dropped":0}
posts: [{"note":"status","status":"connecting","attempts":0,"lastError":null,"dropped":0},{"note":"status","status":"open","attempts":0,"lastError":null,"dropped":0},{"note":"message","topic":"room","data":{"text":"hi"}}]
```

## Publish without buffering, for an outbox that decides for itself

<!-- example id="realtime/socket-unbuffered-publish" runtime="any" -->

The Global transport's own outbox (ARCHITECTURE §20.1) keeps every envelope until the server acknowledges it, so it publishes with `buffer: false`: the result says whether the frame went out at once, and the outbox — not the socket processor's own buffer — decides whether to send it again. A default `publish` buffers instead, and always returns the status, never `true` or `false`.

```ts file=main.ts
import type { ProcessorScope } from '@webkrnl/core';
import { createSocketProcessor, type SocketLike } from '@webkrnl/realtime';

class SlowSocket implements SocketLike {
  readyState = 0; // connecting, and never gets further in this example
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(readonly url: string) {}
  send() {}
  close() {}
}
const processor = createSocketProcessor({ socket: (url): SocketLike => new SlowSocket(url) });
const scope: ProcessorScope = {
  host: 'virtual',
  shouldYield: () => false,
  yield: async () => {},
  post: () => {},
};
await processor.setup?.(scope, {
  url: 'wss://rt.example/socket',
  auth: false,
  heartbeatMs: 30_000,
  heartbeatTimeoutMs: 10_000,
  maxAttempts: null,
  retryBaseMs: 500,
  publishBuffer: 10,
});

await processor.handle({ op: 'connect', token: null }, scope);
const sent = await processor.handle(
  { op: 'publish', topic: 'platform:global', data: { v: 1 }, buffer: false },
  scope,
);
console.log('sent while not open:', sent);
console.log('status:', JSON.stringify(await processor.handle({ op: 'status' }, scope)));
await processor.teardown?.();
```

```text output
sent while not open: false
status: {"status":"connecting","attempts":0,"lastError":null,"dropped":0}
```
