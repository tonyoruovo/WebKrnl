# Examples: `@platform/realtime`

Realtime keeps one socket for many topics. In an app, the socket runs in a dedicated worker and talks to your server. These examples run the socket on the main thread (`hosts: ['virtual']`) with a small fake server, so they run in every sandbox.

## Subscribe to a topic and publish to it

<!-- example id="realtime/topics" runtime="any" -->

A chat room listens to its topic and sends messages to it. One socket carries every topic. The fake server sends each publish back as a message.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { REALTIME_ID, createRealtime, type RealtimeControl, type SocketLike } from '@platform/realtime';

// A fake echo server: each publish comes back as a message to its topic.
function echoSocket(): SocketLike {
  const socket: SocketLike = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      const frame = JSON.parse(String(data)) as { type: string; topic?: string; data?: unknown };
      if (frame.type === 'publish') {
        setTimeout(() => socket.onmessage?.({ data: JSON.stringify({ type: 'message', topic: frame.topic, data: frame.data }) }), 1);
      }
    },
    close() {
      (socket as { readyState: number }).readyState = 3;
    },
  };
  setTimeout(() => {
    (socket as { readyState: number }).readyState = 1;
    socket.onopen?.({});
  }, 1);
  return socket;
}

const kernel = new Kernel([createRealtime({ url: 'wss://chat.example/socket', hosts: ['virtual'], socket: echoSocket })]);
await kernel.start();
const realtime = kernel.unit<RealtimeControl>(REALTIME_ID).control!;

const room = new Promise<unknown>((resolve) => realtime.commands.subscribe('room:42', resolve));
await realtime.commands.publish('room:42', { from: 'Ada', text: 'Hello!' });
console.log('received:', JSON.stringify(await room));
console.log('status:', realtime.views.state.getSnapshot().status);
console.log('topics:', realtime.views.state.getSnapshot().topics?.join(', '));
await kernel.stop();
```

```text output
received: {"from":"Ada","text":"Hello!"}
status: open
topics: room:42
```

## Reconnect after a drop

<!-- example id="realtime/reconnect" runtime="any" -->

The connection drops. Realtime reconnects with backoff and subscribes every topic again, so no listener has to do anything.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { REALTIME_ID, createRealtime, type RealtimeControl, type SocketLike } from '@platform/realtime';

const sockets: SocketLike[] = [];
const subscribes: string[] = [];
function fakeSocket(): SocketLike {
  const socket: SocketLike = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      const frame = JSON.parse(String(data)) as { type: string; topic?: string };
      if (frame.type === 'subscribe') subscribes.push(`socket ${sockets.indexOf(socket) + 1}: ${frame.topic}`);
    },
    close() {},
  };
  sockets.push(socket);
  setTimeout(() => {
    (socket as { readyState: number }).readyState = 1;
    socket.onopen?.({});
  }, 1);
  return socket;
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const kernel = new Kernel([
  createRealtime({ url: 'wss://rt.example/socket', hosts: ['virtual'], socket: fakeSocket, retryBaseMs: 5 }),
]);
await kernel.start();
const realtime = kernel.unit<RealtimeControl>(REALTIME_ID).control!;
realtime.commands.subscribe('prices', () => {});
realtime.commands.subscribe('orders', () => {});
while (subscribes.length < 2) await wait(5);

// The network drops the connection.
(sockets[0] as { readyState: number }).readyState = 3;
sockets[0]!.onclose?.({ code: 1006 });
console.log('status after the drop:', realtime.views.state.getSnapshot().status);
while (realtime.views.state.getSnapshot().status !== 'open') await wait(5);
await wait(5);
console.log('status:', realtime.views.state.getSnapshot().status, 'sockets:', sockets.length);
for (const line of subscribes) console.log(line);
await kernel.stop();
```

```text output
status after the drop: reconnecting
status: open sockets: 2
socket 1: prices
socket 1: orders
socket 2: prices
socket 2: orders
```
