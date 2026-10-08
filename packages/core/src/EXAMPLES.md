# Examples: `@webkrnl/core`

The kernel of the platform. Each `src/` module that has more than one file has its own `EXAMPLES.md`: [`unit/`](unit/EXAMPLES.md), [`state/`](state/EXAMPLES.md), [`processor/`](processor/EXAMPLES.md), [`packet/`](packet/EXAMPLES.md), [`transport/`](transport/EXAMPLES.md), [`scope/`](scope/EXAMPLES.md). These examples are for the files that stay flat at `src/` root: `view.ts`, `backoff.ts` and `ring.ts`.

## Render a view in any framework

<!-- example id="core/views" runtime="any" -->

A view is an external store: `getSnapshot` and `subscribe`. Listeners run one time for each task, after all changes of that task. `deriveView` computes a value from another view.

```ts file=main.ts
import { createStore, deriveView } from '@webkrnl/core';

const cart = createStore({ items: [{ name: 'Tea', price: 4 }] });
const total = deriveView(cart.view, (snapshot) =>
  snapshot.items.reduce((sum, item) => sum + item.price, 0),
);

total.subscribe(() => console.log('render total:', total.getSnapshot()));

// Two changes in one task cause one render.
cart.set({ items: [...cart.view.getSnapshot().items, { name: 'Cake', price: 6 }] });
cart.set({ items: [...cart.view.getSnapshot().items, { name: 'Milk', price: 2 }] });
await Promise.resolve();

console.log('snapshots are frozen:', Object.isFrozen(cart.view.getSnapshot()));
```

```text output
render total: 12
snapshots are frozen: true
```

## Retry a failed call with backoff

<!-- example id="core/backoff" runtime="any" -->

`computeBackoff` gives the wait before each retry. Use a jitter strategy in production. This example uses `exponential`, which has no randomness.

```ts file=main.ts
import { computeBackoff } from '@webkrnl/core';

let calls = 0;
async function flakyUpload(): Promise<string> {
  calls += 1;
  if (calls < 3) throw new Error('HTTP 503');
  return 'uploaded';
}

for (let attempts = 1; ; attempts++) {
  try {
    console.log(await flakyUpload(), 'after', attempts, 'attempts');
    break;
  } catch (error) {
    const wait = computeBackoff({ base: 10, attempts, strategy: 'exponential' });
    console.log(`attempt ${attempts} failed (${(error as Error).message}), waiting ${wait} ms`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}
```

```text output
attempt 1 failed (HTTP 503), waiting 20 ms
attempt 2 failed (HTTP 503), waiting 40 ms
uploaded after 3 attempts
```

## Keep a bounded history and drop repeats

<!-- example id="core/ring-and-dedupe" runtime="any" -->

A notification panel shows the last three messages, and a message that arrives two times shows one time only.

```ts file=main.ts
import { createDeduplicator, createRingBuffer } from '@webkrnl/core';

const recent = createRingBuffer<string>(3);
const dedupe = createDeduplicator(1000);

const arrivals = [
  { id: 'm1', text: 'Build started' },
  { id: 'm2', text: 'Tests passed' },
  { id: 'm2', text: 'Tests passed' }, // the same message, from a second channel
  { id: 'm3', text: 'Deployed to staging' },
  { id: 'm4', text: 'Deployed to production' },
];

for (const message of arrivals) {
  if (dedupe.seen(message.id)) continue;
  recent.push(message.text);
}

console.log(JSON.stringify(recent.view.getSnapshot()));
console.log('dropped from the panel:', recent.dropped);
```

```text output
["Tests passed","Deployed to staging","Deployed to production"]
dropped from the panel: 1
```
