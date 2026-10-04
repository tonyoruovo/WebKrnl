# @platform/sync

> **Pre-alpha (`0.0.2`).** Not published to npm yet. `@platform` is a placeholder scope until milestone M9.

The **Sync** subsystem (id `sync`, featurized, Tab scope). It gets the changes of the user to the server, **exactly once**, also after hours offline:

- **Entities**: `entity({ name, push, pull?, apply?, merge?, conflict? })` declares an entity type and returns a handle with `create`, `update`, `remove` and `pending`.
- **Outbox**: each change waits in an outbox until the server confirms it. When Storage runs, the outbox is the collection `sync.outbox.<name>`, so changes survive a reload.
- **No duplicates**: each change has a stable id. The push handler sends it as the `Idempotency-Key`, so a retry is applied once by the server. Two waiting changes to one entity merge, but only when the first was never sent.
- **One replayer**: the outbox is shared by every tab of the origin, and a Web Lock lets one tab send it at a time.
- **Failures**: transient failures retry with backoff, and later changes to the same entity wait behind them. Permanent failures (4xx) go to `failed` and `sync:failed`.
- **Conflicts**: `server-wins`, `client-wins`, `merge`, or `manual` with `resolve(id, choice)`.
- **Pull**: `pull(cursor)` gives changes from the server, and `apply` writes them. A waiting local change wins.
- **Pending work**: Global State shows what waits, one entry for each entity type ("3 changes to todos waiting").

Network is required; Storage is late-bound. Design: [ARCHITECTURE §19.3](../../docs/ARCHITECTURE.md#193-sync) and the amended [Sync proposal](../../proposals/sync_PROPOSAL.md).

## Installation

```json
{
  "peerDependencies": {
    "@platform/core": "workspace:*",
    "@platform/network": "workspace:*",
    "@platform/sync": "workspace:*"
  }
}
```

## Entry points

| Import           | Contents                                                                   |
| ---------------- | -------------------------------------------------------------------------- |
| `@platform/sync` | `createSync`, `Outbox`, `mergeOps`, `isPermanent`, and the types            |

## Usage

```ts
import { createSync, type SyncControl } from '@platform/sync';

const kernel = new Kernel([...centralized, createStorage(), createNetwork(), createSync()], { router: queue.router });
await kernel.start();

const { commands, views } = kernel.unit<SyncControl>('sync').control!;
const todos = commands.entity<Todo>({
  name: 'todos',
  push: async (change, { network }) => {
    const response = await network.commands.request<Todo>({
      url: `/todos/${change.entityId}`,
      method: change.op === 'delete' ? 'DELETE' : 'PUT',
      body: change.data ?? undefined,
      idempotencyKey: change.id,
      allowErrorStatus: true,
    });
    if (response.status === 409) return { conflict: response.data };
    if (response.status >= 400) throw Object.assign(new Error('push failed'), { status: response.status });
  },
  conflict: 'server-wins',
});

await todos.update('t1', { title: 'Buy tea', done: false }); // works offline too
views.state.subscribe(() => showBadge(views.state.getSnapshot().pending));
```

The push handler decides how a change reaches your API. Throw an error with a `status` of 4xx for a permanent failure.

## Behaviour

| Situation                                   | Result                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A change while online                       | Sent at once                                                                                 |
| A change while offline                      | Waits; `status` is `OFFLINE`; the pending work shows the count                               |
| Back online                                 | The outbox is sent, oldest first, then a pull                                                |
| A response is lost and the request is sent again | The server applies the change once (same idempotency key)                              |
| Transient failure (offline, timeout, 5xx, 429) | The change stays; retry with backoff; later changes of the entity wait                    |
| Permanent failure (other 4xx)               | `failed`; `sync:failed`; `retryFailed()` puts it back                                        |
| The server answers with a conflict          | The entity's strategy decides; `manual` waits for `resolve`                                  |
| Two tabs with the same outbox               | One tab sends it at a time                                                                   |
| A reload with changes in the outbox (Storage) | The changes come back and are sent                                                         |
| `pause()`                                   | No automatic runs until `resume()`                                                           |

## Options

| Option        | Default             | Purpose                                                       |
| ------------- | ------------------- | ------------------------------------------------------------- |
| `intervalMs`  | `300_000`           | Automatic runs while visible, or `false`.                     |
| `retryBaseMs` | `1_000`             | The base wait after a transient failure.                      |
| `name`        | `default`           | The name of the outbox and of the Web Lock.                   |

## Testing

```bash
pnpm exec vitest run --project node packages/sync
```

`test/gate.spec.ts` is the M7 gate: offline work, then online with failures, and every change applied once while the pending work matches the outbox.
