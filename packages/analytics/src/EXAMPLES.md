# Examples: `@platform/analytics`

Analytics collects metrics and events only with the `analytics` grant of Consent, and sends them in batches. These examples send the batches to a function instead of a server.

## Collect only after consent

<!-- example id="analytics/consent" runtime="any" -->

Before the user decides, nothing is collected. After the grant, a page view, a load time and a purchase go out in one batch. When the user revokes the grant, what waits is deleted.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { createConsent, type ConsentControl } from '@platform/consent';
import { ANALYTICS_ID, createAnalytics, type AnalyticsControl } from '@platform/analytics';

const kernel = new Kernel([
  createConsent(),
  createAnalytics({
    send: async (batch) => {
      console.log('sent:', JSON.stringify({ counters: batch.counters, events: batch.events.map((e) => e.name) }));
      console.log('route.ms:', JSON.stringify(batch.histograms['route.ms']));
    },
  }),
]);
await kernel.start();
const consent = kernel.unit<ConsentControl>('consent').control!;
const { commands, views } = kernel.unit<AnalyticsControl>(ANALYTICS_ID).control!;

commands.track('before consent');
console.log('collecting:', views.state.getSnapshot().collecting);

consent.commands.grant('analytics');
await kernel.settled();
commands.increment('page.view');
for (const ms of [120, 80, 300, 95]) commands.histogram('route.ms', ms);
commands.track('purchase', { plan: 'pro' });
await commands.flush();

commands.track('after');
consent.commands.revoke('analytics');
await kernel.settled();
console.log('after the revoke:', JSON.stringify({ buffered: views.state.getSnapshot().buffered, collecting: views.state.getSnapshot().collecting }));
await kernel.stop();
```

```text output
collecting: false
sent: {"counters":{"page.view":1},"events":["purchase"]}
route.ms: {"count":4,"sum":595,"min":80,"max":300,"p50":95,"p90":300,"p99":300}
after the revoke: {"buffered":0,"collecting":false}
```

## Keep a batch that fails, and send it again

<!-- example id="analytics/retry" runtime="any" -->

The server is down for the first send. The batch stays in the outbox and goes again later with the same id, so a server that drops repeats by `Idempotency-Key` counts it once.

```ts file=main.ts
import { Kernel } from '@platform/core';
import { createConsent, type ConsentControl } from '@platform/consent';
import { ANALYTICS_ID, createAnalytics, type AnalyticsControl } from '@platform/analytics';

let up = false;
const ids: string[] = [];
const kernel = new Kernel([
  createConsent(),
  createAnalytics({
    send: async (batch) => {
      ids.push(batch.id);
      if (!up) throw new Error('503 Service Unavailable');
    },
  }),
]);
await kernel.start();
kernel.unit<ConsentControl>('consent').control!.commands.grant('analytics');
await kernel.settled();
const { commands, views } = kernel.unit<AnalyticsControl>(ANALYTICS_ID).control!;

commands.track('search', { results: 12 });
await commands.flush();
console.log('outbox:', views.state.getSnapshot().outbox, '-', views.state.getSnapshot().lastError);

up = true;
await commands.flush();
console.log('outbox:', views.state.getSnapshot().outbox, '- sent:', views.state.getSnapshot().sent);
console.log('same batch both times:', ids.length === 2 && ids[0] === ids[1]);
await kernel.stop();
```

```text output
outbox: 1 - 503 Service Unavailable
outbox: 0 - sent: 1
same batch both times: true
```
