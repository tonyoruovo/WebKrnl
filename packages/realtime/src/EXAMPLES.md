# Examples: `@webkrnl/realtime`

Realtime keeps one socket for many topics. In an app, the socket runs in a dedicated worker and talks to your server. These examples run the socket on the main thread (`hosts: ['virtual']`) with a small fake server, so they run in every sandbox.

## Subscribe to a topic and publish to it

<!-- example id="realtime/topics" runtime="any" -->

A chat room listens to its topic and sends messages to it. One socket carries every topic. The fake server sends each publish back as a message.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import { REALTIME_ID, createRealtime, type RealtimeControl, type SocketLike } from '@webkrnl/realtime';

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
import { Kernel } from '@webkrnl/core';
import { REALTIME_ID, createRealtime, type RealtimeControl, type SocketLike } from '@webkrnl/realtime';

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

## Send a Global broadcast to another device

<!-- example id="realtime/global" runtime="any" -->

The user changes a setting on the laptop. The phone gets the change. Each device runs Realtime with the option `global`; the fake server forwards `platform:global` to the other sockets and acknowledges each envelope, as [the wire protocol](../../../docs/WIRE-PROTOCOL.md) says.

```ts file=main.ts
import { Kernel, NO_CONTROL, type PacketPort, type SubsystemDefinition } from '@webkrnl/core';
import { createNotificationCenter } from '@webkrnl/notification';
import { createQueue } from '@webkrnl/queue';
import { REALTIME_ID, createRealtime, type GlobalControl, type SocketLike } from '@webkrnl/realtime';

// A fake server: it forwards a reserved topic to the other subscribers, then sends an ack.
const subscribers = new Map<SocketLike, Set<string>>();
function connect(): SocketLike {
  const deliver = (to: SocketLike, frame: unknown) => setTimeout(() => to.onmessage?.({ data: JSON.stringify(frame) }), 1);
  const socket: SocketLike = {
    readyState: 0,
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      const frame = JSON.parse(String(data)) as { type: string; topic?: string; data?: { metadata: { messageId: string } } };
      if (frame.type === 'subscribe') subscribers.get(socket)!.add(frame.topic!);
      if (frame.type !== 'publish') return;
      for (const [other, topics] of subscribers) {
        if (other !== socket && topics.has(frame.topic!)) deliver(other, { type: 'message', topic: frame.topic, data: frame.data });
      }
      deliver(socket, { type: 'ack', data: frame.data!.metadata.messageId });
    },
    close() {},
  };
  subscribers.set(socket, new Set());
  setTimeout(() => {
    (socket as { readyState: number }).readyState = 1;
    socket.onopen?.({});
  }, 1);
  return socket;
}

async function device(name: string) {
  let port: PacketPort | undefined;
  const settings: SubsystemDefinition = {
    id: 'settings',
    scope: 'global',
    kind: 'featurized',
    state: { initial: {} },
    subscribes: ['settings:changed'],
    init: (ctx) => void (port = ctx.port),
    receive: (packet) => console.log(`${name} got:`, JSON.stringify(packet.take())),
    control: () => NO_CONTROL,
  };
  const notification = createNotificationCenter();
  const queue = createQueue({ fanOut: notification.fanOut });
  const kernel = new Kernel(
    [
      queue.subsystem,
      notification.subsystem,
      createRealtime({ url: 'wss://rt.example/socket', hosts: ['virtual'], socket: connect, global: {} }),
      settings,
    ] as SubsystemDefinition[],
    { router: queue.router },
  );
  await kernel.start();
  const global = kernel.unit<GlobalControl>(`${REALTIME_ID}/global`).control!;
  return { kernel, port: () => port!, global };
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const laptop = await device('laptop');
const phone = await device('phone');
while (laptop.global.views.state.getSnapshot().transport !== 'socket') await wait(5);
await wait(20); // the subscriptions reach the server

await laptop.port().send({ eventId: 'settings:changed', payload: { theme: 'dark' } });
while (laptop.global.views.state.getSnapshot().outbox !== 0) await wait(5);
await wait(20);
console.log('laptop outbox:', laptop.global.views.state.getSnapshot().outbox);
await laptop.kernel.stop();
await phone.kernel.stop();
```

```text output
phone got: {"theme":"dark"}
laptop outbox: 0
```
