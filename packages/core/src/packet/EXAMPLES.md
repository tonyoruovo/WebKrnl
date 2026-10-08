# Examples: `@webkrnl/core` — the packet module

Sending a 1-to-1 request and a broadcast with the packet port.

## Ask another subsystem for data, and announce a change

<!-- example id="core/request-and-broadcast" runtime="any" -->

Subsystems talk through packets. `request` sends a 1-to-1 packet and returns the reply. `send` without a target is a broadcast to every subscriber.

```ts file=main.ts
import { Kernel, NO_CONTROL, defineSubsystem, type PacketPort } from '@webkrnl/core';

let authPort: PacketPort | undefined;

const users = defineSubsystem({
  id: 'users',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  receive: (packet) => {
    const { id } = packet.take() as { id: string };
    return { id, name: id === 'u1' ? 'Ada' : 'Unknown' };
  },
  control: () => NO_CONTROL,
});

const auth = defineSubsystem({
  id: 'auth',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  init: (ctx) => void (authPort = ctx.port),
  control: () => NO_CONTROL,
});

const audit = defineSubsystem({
  id: 'audit',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  subscribes: ['auth:login'],
  receive: (packet) =>
    console.log('audit heard:', packet.header.eventId, JSON.stringify(packet.take())),
  control: () => NO_CONTROL,
});

const kernel = new Kernel([users, auth, audit]);
await kernel.start();

const user = await authPort!.request<{ name: string }>({
  eventId: 'users:get',
  payload: { id: 'u1' },
  target: 'users',
});
console.log('reply:', user.name);
await authPort!.send({ eventId: 'auth:login', payload: { user: user.name } });
await kernel.stop();
```

```text output
reply: Ada
audit heard: auth:login {"user":"Ada"}
```
