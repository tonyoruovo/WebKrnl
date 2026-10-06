# Examples: `@webkrnl/sync`

Sync keeps the changes of the user in an outbox until the server confirms each one, exactly once. These examples use a fake server through the Network's `fetch`, and the outbox in memory, so they run in every sandbox. In an app, add Storage, and the outbox survives a reload.

## Work offline, then send everything once

<!-- example id="sync/offline-outbox" runtime="any" -->

A to-do app works on a train. The changes wait in the outbox, and changes to one item merge. The pending work in Global State shows what waits. Back online, Sync sends each change once, even when a response is lost and the request is sent again.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import {
  GLOBAL_STATE_ID,
  createGlobalState,
  createStaticEnvironment,
  type GlobalStateControl,
} from '@webkrnl/global-state';
import { createNetwork } from '@webkrnl/network';
import { SYNC_ID, createSync, type SyncControl } from '@webkrnl/sync';

const applied = new Set<string>(); // the idempotency keys that the server applied
let requests = 0;
let dropNext = true;
// A fake server: it applies each key once, and loses its first response.
const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  requests++;
  applied.add(new Request(input, init).headers.get('idempotency-key')!);
  if (dropNext) {
    dropNext = false;
    throw new TypeError('connection reset');
  }
  return new Response(null, { status: 204 });
};

const environment = createStaticEnvironment({ online: false });
const kernel = new Kernel([
  createGlobalState({ environment }),
  createNetwork({ baseUrl: 'https://api.todo.example/', fetch, retryBaseMs: 1 }),
  createSync({ intervalMs: false, retryBaseMs: 1 }),
]);
await kernel.start();
const sync = kernel.unit<SyncControl>(SYNC_ID).control!;
const globalState = kernel.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!;

const todos = sync.commands.entity<{ title: string }>({
  name: 'todos',
  push: async (change, { network }) => {
    await network.commands.request({
      url: `/todos/${change.entityId}`,
      method: change.op === 'delete' ? 'DELETE' : 'PUT',
      body: change.data ?? undefined,
      idempotencyKey: change.id, // the server applies a key once
    });
  },
});

await todos.create('t1', { title: 'Tea' });
await todos.update('t1', { title: 'Green tea' }); // merges into the create
await todos.create('t2', { title: 'Cups' });
console.log('waiting:', sync.views.state.getSnapshot().pending);
console.log('shown to the user:', globalState.views.state.getSnapshot().pending?.map((w) => w.label).join(', '));

environment.set({ online: true });
while (sync.commands.outbox().length > 0) await new Promise((resolve) => setTimeout(resolve, 5));
console.log('requests:', requests, 'changes applied:', applied.size);
console.log('still shown:', globalState.views.state.getSnapshot().pending?.length);
await kernel.stop();
```

```text output
waiting: 2
shown to the user: 2 changes to todos waiting
requests: 3 changes applied: 2
still shown: 0
```

## Let the user choose in a conflict

<!-- example id="sync/manual-conflict" runtime="any" -->

Two people edit the same document. The server answers `409` with its version. With the `manual` strategy, the change waits in `conflicts` until the user chooses.

```ts file=main.ts
import { Kernel } from '@webkrnl/core';
import { createNetwork } from '@webkrnl/network';
import { SYNC_ID, createSync, type SyncControl } from '@webkrnl/sync';

let serverTitle = 'Plan (edited by Bo)';
// A fake server: a request without "x-force" conflicts.
const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  if (request.headers.get('x-force') !== '1') {
    return Response.json({ title: serverTitle }, { status: 409 });
  }
  serverTitle = ((await request.json()) as { title: string }).title;
  return new Response(null, { status: 204 });
};

const kernel = new Kernel([
  createNetwork({ baseUrl: 'https://api.docs.example/', fetch }),
  createSync({ intervalMs: false }),
]);
await kernel.start();
const sync = kernel.unit<SyncControl>(SYNC_ID).control!;

const docs = sync.commands.entity<{ title: string }>({
  name: 'docs',
  conflict: 'manual',
  push: async (change, { network }) => {
    const response = await network.commands.request<{ title: string }>({
      url: `/docs/${change.entityId}`,
      method: 'PUT',
      body: change.data,
      idempotencyKey: change.id,
      headers: change.force ? { 'x-force': '1' } : {},
      allowErrorStatus: true,
    });
    if (response.status === 409) return { conflict: response.data };
    return undefined;
  },
});

await docs.update('d1', { title: 'Plan (edited by Ada)' });
while (sync.views.state.getSnapshot().conflicts === 0) await new Promise((resolve) => setTimeout(resolve, 5));
const [conflict] = docs.pending();
console.log('mine:', conflict!.data?.title);
console.log('server:', conflict!.remote?.title);

await sync.commands.resolve(conflict!.id, { data: { title: 'Plan (Ada and Bo)' } });
while (sync.commands.outbox().length > 0) await new Promise((resolve) => setTimeout(resolve, 5));
console.log('saved:', serverTitle);
await kernel.stop();
```

```text output
mine: Plan (edited by Ada)
server: Plan (edited by Bo)
saved: Plan (Ada and Bo)
```
