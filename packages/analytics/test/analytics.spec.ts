/**
 * The Analytics subsystem (docs/ARCHITECTURE.md §21.3): consent first,
 * session sampling, batches, the outbox, the beacon and the sign-out wipe.
 */
import { createConsent, type ConsentControl } from '@platform/consent';
import { Kernel, type Scheduler, type SubsystemDefinition } from '@platform/core';
import { createTestAuth } from '@platform/core/testing';
import { createGlobalState, createStaticEnvironment } from '@platform/global-state';
import { createNetwork } from '@platform/network';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';
import { SETTINGS_ID, createSettings, type SettingsControl } from '@platform/settings';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ANALYTICS_ID,
  ANALYTICS_OUTBOX,
  createAnalytics,
  summarize,
  type AnalyticsBatch,
  type AnalyticsControl,
  type AnalyticsOptions,
} from '../src';

const scheduler: Scheduler = {
  kind: 'timeout',
  postTask: (task) => Promise.resolve().then(task),
  yield: () => Promise.resolve(),
  idle: (task) => Promise.resolve().then(task),
};

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.stop();
  vi.unstubAllGlobals();
});

/** A Storage double: one in-memory map for each collection. */
function memoryStorage(maps = new Map<string, Map<string, unknown>>()): SubsystemDefinition {
  return {
    id: 'storage',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    control: () => ({
      commands: {
        collection: ({ name }: { name: string }) => {
          if (!maps.has(name)) maps.set(name, new Map());
          const map = maps.get(name)!;
          return {
            set: async (key: string, value: unknown) => void map.set(key, structuredClone(value)),
            delete: async (key: string) => void map.delete(key),
            entries: async () =>
              [...map].map(([key, value]) => ({ key, value: structuredClone(value) })),
            clear: async () => map.clear(),
          };
        },
      },
      views: {},
    }),
  };
}

async function boot(options: Partial<AnalyticsOptions> = {}, units: SubsystemDefinition[] = []) {
  const batches: AnalyticsBatch[] = [];
  const errors: unknown[] = [];
  const notification = createNotificationCenter();
  const queue = createQueue({ scheduler, fanOut: notification.fanOut });
  const kernel = new Kernel(
    [
      queue.subsystem,
      notification.subsystem,
      createConsent(),
      ...units,
      createAnalytics({
        send: async (batch) => void batches.push(batch),
        flushIntervalMs: 60_000,
        random: () => 0,
        ...options,
      }),
    ] as SubsystemDefinition[],
    { router: queue.router, onError: (error) => void errors.push(error) },
  );
  kernels.push(kernel);
  await kernel.start();
  return {
    kernel,
    batches,
    errors,
    analytics: kernel.unit<AnalyticsControl>(ANALYTICS_ID).control!,
    consent: kernel.unit<ConsentControl>('consent').control!,
  };
}

describe('consent first', () => {
  it('collects nothing without the analytics grant', async () => {
    const { analytics, batches } = await boot();
    analytics.commands.track('ignored');
    analytics.commands.increment('ignored');
    await analytics.commands.flush();
    expect(batches).toEqual([]);
    expect(analytics.views.state.getSnapshot()).toMatchObject({ collecting: false, buffered: 0 });
  });

  it('collects after the grant, and sends one batch with every kind of metric', async () => {
    const { analytics, consent, batches } = await boot();
    consent.commands.grant('analytics');
    await vi.waitFor(() => expect(analytics.views.state.getSnapshot().collecting).toBe(true));
    analytics.commands.increment('page.view');
    analytics.commands.increment('page.view', 2);
    analytics.commands.gauge('cart.size', 1);
    analytics.commands.gauge('cart.size', 4);
    for (const ms of [100, 400, 200, 300]) analytics.commands.histogram('route.ms', ms);
    analytics.commands.track('purchase', { plan: 'pro' });
    expect(analytics.commands.snapshot().counters).toEqual({ 'page.view': 3 });

    await analytics.commands.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      sessionId: analytics.views.state.getSnapshot().sessionId,
      counters: { 'page.view': 3 },
      gauges: { 'cart.size': 4 },
      histograms: { 'route.ms': summarize([100, 200, 300, 400]) },
      events: [{ name: 'purchase', properties: { plan: 'pro' } }],
    });
    expect(analytics.views.state.getSnapshot()).toMatchObject({ buffered: 0, outbox: 0, sent: 1 });
    await analytics.commands.flush(); // nothing new: nothing sent
    expect(batches).toHaveLength(1);
  });

  it('deletes the buffer and the outbox when the grant is revoked', async () => {
    const maps = new Map<string, Map<string, unknown>>();
    const { analytics, consent } = await boot({ send: () => Promise.reject(new Error('down')) }, [
      memoryStorage(maps),
    ]);
    consent.commands.grant('analytics');
    await vi.waitFor(() => expect(analytics.views.state.getSnapshot().collecting).toBe(true));
    analytics.commands.track('a');
    await analytics.commands.flush();
    analytics.commands.track('b');
    expect(analytics.views.state.getSnapshot()).toMatchObject({ outbox: 1, buffered: 1 });
    await vi.waitFor(() => expect(maps.get(ANALYTICS_OUTBOX)?.size).toBe(1));

    consent.commands.revoke('analytics');
    await vi.waitFor(() =>
      expect(analytics.views.state.getSnapshot()).toMatchObject({
        collecting: false,
        outbox: 0,
        buffered: 0,
      }),
    );
    await vi.waitFor(() => expect(maps.get(ANALYTICS_OUTBOX)?.size).toBe(0));
  });
});

describe('sampling', () => {
  it('decides once for the session', async () => {
    const out = await boot({ sampleRate: 0.5, random: () => 0.7 });
    out.consent.commands.grant('analytics');
    await out.kernel.settled();
    expect(out.analytics.views.state.getSnapshot()).toMatchObject({
      sampled: false,
      collecting: false,
    });
    const inside = await boot({ sampleRate: 0.5, random: () => 0.3 });
    inside.consent.commands.grant('analytics');
    await vi.waitFor(() =>
      expect(inside.analytics.views.state.getSnapshot().collecting).toBe(true),
    );
    expect(() => createAnalytics({ send: async () => {}, sampleRate: 2 })).toThrow(RangeError);
    expect(() => createAnalytics({})).toThrow(RangeError);
  });
});

describe('batches', () => {
  it('sends a batch when batchSize events wait', async () => {
    const { analytics, consent, batches } = await boot({ batchSize: 3 });
    consent.commands.grant('analytics');
    await vi.waitFor(() => expect(analytics.views.state.getSnapshot().collecting).toBe(true));
    for (const name of ['a', 'b', 'c', 'd']) analytics.commands.track(name);
    await vi.waitFor(() => expect(batches).toHaveLength(1));
    expect(batches[0]!.events.map((e) => e.name)).toEqual(['a', 'b', 'c']);
    expect(analytics.views.state.getSnapshot().buffered).toBe(1);
  });

  it('keeps a failed batch, and sends the same batch id again', async () => {
    let fail = true;
    const sent: string[] = [];
    const { analytics, consent } = await boot({
      send: async (batch) => {
        sent.push(batch.id);
        if (fail) throw new Error('503');
      },
    });
    consent.commands.grant('analytics');
    await vi.waitFor(() => expect(analytics.views.state.getSnapshot().collecting).toBe(true));
    analytics.commands.track('x');
    await analytics.commands.flush();
    expect(analytics.views.state.getSnapshot()).toMatchObject({ outbox: 1, lastError: '503' });
    fail = false;
    await analytics.commands.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    expect(analytics.views.state.getSnapshot()).toMatchObject({
      outbox: 0,
      sent: 1,
      lastError: null,
    });
  });

  it('waits while offline, and sends when the platform is online', async () => {
    const environment = createStaticEnvironment({ online: false });
    const { analytics, consent, batches } = await boot({}, [
      createGlobalState({ environment }) as SubsystemDefinition,
    ]);
    consent.commands.grant('analytics');
    await vi.waitFor(() => expect(analytics.views.state.getSnapshot().collecting).toBe(true));
    analytics.commands.track('offline');
    await analytics.commands.flush();
    expect(batches).toEqual([]);
    environment.set({ online: true });
    await vi.waitFor(() => expect(batches).toHaveLength(1));
  });

  it('keeps the outbox over a reload with Storage', async () => {
    const maps = new Map<string, Map<string, unknown>>();
    const first = await boot({ send: () => Promise.reject(new Error('down')) }, [
      memoryStorage(maps),
    ]);
    first.consent.commands.grant('analytics');
    await vi.waitFor(() => expect(first.analytics.views.state.getSnapshot().collecting).toBe(true));
    first.analytics.commands.track('kept');
    await first.analytics.commands.flush();
    await vi.waitFor(() => expect(maps.get(ANALYTICS_OUTBOX)?.size).toBe(1));

    const second = await boot({}, [memoryStorage(maps)]);
    second.consent.commands.grant('analytics');
    await vi.waitFor(() => expect(second.batches.map((b) => b.events[0]?.name)).toEqual(['kept']));
    await vi.waitFor(() => expect(maps.get(ANALYTICS_OUTBOX)?.size).toBe(0));
  });

  it('sends through Network with the batch id as Idempotency-Key', async () => {
    const requests: Request[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response(null, { status: 204 });
    });
    const { analytics, consent } = await boot({ send: undefined, endpoint: '/t/batch' }, [
      createNetwork({ fetch, baseUrl: 'https://app.test/' }) as SubsystemDefinition,
    ]);
    consent.commands.grant('analytics');
    await vi.waitFor(() => expect(analytics.views.state.getSnapshot().collecting).toBe(true));
    analytics.commands.increment('n');
    await analytics.commands.flush();
    expect(requests).toHaveLength(1);
    const body = (await requests[0]!.json()) as AnalyticsBatch;
    expect(requests[0]!.url).toBe('https://app.test/t/batch');
    expect(requests[0]!.headers.get('idempotency-key')).toBe(body.id);
    expect(body.counters).toEqual({ n: 1 });
  });
});

describe('the page hides', () => {
  it('sends every batch with a beacon', async () => {
    const handlers = new Map<string, () => void>();
    vi.stubGlobal('addEventListener', (type: string, handler: () => void) =>
      handlers.set(type, handler),
    );
    vi.stubGlobal('removeEventListener', () => {});
    const beacons: Array<{ url: string; body: AnalyticsBatch }> = [];
    const { analytics, consent } = await boot({
      send: undefined,
      endpoint: 'https://t.test/batch',
      beacon: (url, body) => beacons.push({ url, body: JSON.parse(body) as AnalyticsBatch }) > 0,
    });
    consent.commands.grant('analytics');
    await vi.waitFor(() => expect(analytics.views.state.getSnapshot().collecting).toBe(true));
    analytics.commands.track('last');
    handlers.get('pagehide')!();
    expect(beacons.map((b) => [b.url, b.body.events[0]?.name])).toEqual([
      ['https://t.test/batch', 'last'],
    ]);
    expect(analytics.views.state.getSnapshot()).toMatchObject({ outbox: 0, sent: 1 });
  });
});

describe('the data saver', () => {
  it('stops the interval; full batches still go out', async () => {
    const { kernel, analytics, consent, batches } = await boot(
      { flushIntervalMs: 20, batchSize: 2 },
      [createSettings()],
    );
    await kernel.unit<SettingsControl>(SETTINGS_ID).control!.commands.set('dataSaver', true);
    consent.commands.grant('analytics');
    await vi.waitFor(() => expect(analytics.views.state.getSnapshot().collecting).toBe(true));
    analytics.commands.track('one');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(batches).toEqual([]);
    analytics.commands.track('two');
    await vi.waitFor(() => expect(batches).toHaveLength(1));
  });
});

describe('sign-out (ARCHITECTURE §5.1)', () => {
  it('deletes what the user did, and starts a new session', async () => {
    const auth = createTestAuth();
    const { kernel, analytics, consent, batches } = await boot(
      { send: () => Promise.reject(new Error('down')) },
      [auth.unit],
    );
    auth.signIn('u1');
    consent.commands.grant('analytics');
    await vi.waitFor(() => expect(analytics.views.state.getSnapshot().collecting).toBe(true));
    const session = analytics.views.state.getSnapshot().sessionId;
    analytics.commands.track('private');
    await analytics.commands.flush();
    analytics.commands.track('more');

    auth.signOut();
    await kernel.settled();
    await vi.waitFor(() =>
      expect(analytics.views.state.getSnapshot()).toMatchObject({ outbox: 0, buffered: 0 }),
    );
    expect(analytics.views.state.getSnapshot().sessionId).not.toBe(session);
    expect(batches).toEqual([]);
  });
});
