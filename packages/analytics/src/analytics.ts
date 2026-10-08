/**
 * @fileoverview
 * @summary The Analytics subsystem: metrics and events, only with consent, sent in batches.
 * @description
 * Implements docs/ARCHITECTURE.md §21.3 (amended proposal:
 * `docs/proposals/analytics_PROPOSAL.md`). Analytics is the sink of the platform:
 * other units report to it, and no unit depends on it. Telemetry never slows
 * the app: it is sampled, batched, and gated on consent.
 *
 * ```text
 *   increment / gauge / histogram / track
 *     consent 'analytics' granted, and this session sampled?  no --> dropped
 *     --> buffer --> batch (counters, gauges, histogram summaries, events, batch id, session id)
 *         when batchSize events wait, every flushIntervalMs, on flush(), or when the page hides
 *     --> outbox (memory, and Storage 'analytics.outbox') --> POST endpoint (Network, Idempotency-Key: batch id)
 *         ok: out of the outbox      failed or offline: stays; sent when the platform is online
 *     page hides --> navigator.sendBeacon for each batch (it cannot wait for a worker or a promise)
 *
 *   consent revoked, sign-out --> the buffer and the outbox are deleted
 *   ```
 *
 * @example
 * Recording a purchase
 * ```ts
 * const analytics = kernel.unit<AnalyticsControl>('analytics').control!;
 * analytics.commands.track('purchase', { plan: 'pro' });
 * analytics.commands.histogram('checkout.ms', performance.now() - started);
 * ```
 *
 * @author MathAid
 */

import {
  defineSubsystem,
  watchSignOut,
  type ControlInterface,
  type SubsystemDefinition,
  type View,
} from '@webkrnl/core';

/**
 * @summary The id the Analytics subsystem registers under.
 * @constant {'analytics'}
 * @public
 */
export const ANALYTICS_ID = 'analytics';

/**
 * @summary The Storage collection where batches wait while they cannot be sent.
 * @constant {'analytics.outbox'}
 * @public
 */
export const ANALYTICS_OUTBOX = 'analytics.outbox';

/**
 * @summary The summary of the values of one histogram in one batch.
 *
 * @example
 * Example 1: Load times
 * ```ts
 * // { count: 4, sum: 1000, min: 100, max: 400, p50: 200, p90: 400, p99: 400 }
 * ```
 *
 * @example
 * Example 2: Making one
 * ```ts
 * summarize([100, 200, 300, 400]).p50; // 200
 * ```
 *
 * @public
 */
export interface HistogramSummary {
  /**
   * @summary The number of values.
   */
  readonly count: number;
  /**
   * @summary The sum of the values.
   */
  readonly sum: number;
  /**
   * @summary The smallest value.
   */
  readonly min: number;
  /**
   * @summary The largest value.
   */
  readonly max: number;
  /**
   * @summary The median (nearest rank).
   */
  readonly p50: number;
  /**
   * @summary The 90th percentile (nearest rank).
   */
  readonly p90: number;
  /**
   * @summary The 99th percentile (nearest rank).
   */
  readonly p99: number;
}

/**
 * @summary One usage event.
 * @public
 */
export interface AnalyticsEvent {
  /**
   * @summary The name of the event, for example `purchase`.
   */
  readonly name: string;
  /**
   * @summary The properties of the event. They must be JSON data.
   */
  readonly properties: Readonly<Record<string, unknown>>;
  /**
   * @summary The time of the event, in Unix milliseconds.
   */
  readonly timestamp: number;
}

/**
 * @summary What one request to the server carries.
 *
 * @example
 * Example 1: A batch
 * ```ts
 * // { id: 'b1…', sessionId: 's1…', createdAt: 1767225600000, counters: { 'page.view': 3 }, gauges: {}, histograms: {}, events: [] }
 * ```
 *
 * @example
 * Example 2: On the server, dropping repeats
 * ```ts
 * if (await seen(request.headers['idempotency-key'])) return reply(200);
 * ```
 *
 * @public
 */
export interface AnalyticsBatch {
  /**
   * @summary The id of the batch. It is also the `Idempotency-Key`, so a batch sent twice counts once.
   */
  readonly id: string;
  /**
   * @summary The id of the session. A sign-out starts a new one.
   */
  readonly sessionId: string;
  /**
   * @summary When the batch was made, in Unix milliseconds.
   */
  readonly createdAt: number;
  /**
   * @summary The counters: the sum of the increments in this batch.
   */
  readonly counters: Readonly<Record<string, number>>;
  /**
   * @summary The gauges: the last value in this batch.
   */
  readonly gauges: Readonly<Record<string, number>>;
  /**
   * @summary The histograms: a summary of the values in this batch.
   */
  readonly histograms: Readonly<Record<string, HistogramSummary>>;
  /**
   * @summary The events, oldest first.
   */
  readonly events: readonly AnalyticsEvent[];
}

/**
 * @summary Options for {@linkcode createAnalytics}.
 *
 * @example
 * Example 1: An endpoint, a sample of one session in ten
 * ```ts
 * createAnalytics({ endpoint: 'https://t.shop.example/batch', sampleRate: 0.1 });
 * ```
 *
 * @example
 * Example 2: A vendor SDK
 * ```ts
 * createAnalytics({ send: (batch) => vendor.ingest(batch) });
 * ```
 *
 * @public
 */
export interface AnalyticsOptions {
  /**
   * @summary The URL that receives batches as JSON (`POST`, and `sendBeacon` when the page hides).
   */
  readonly endpoint?: string;
  /**
   * @summary Sends a batch another way. It replaces the `POST` to `endpoint`.
   * @description When the page hides, a batch still goes with `sendBeacon` to `endpoint`, if there is one.
   * @param {AnalyticsBatch} batch The batch.
   * @returns {Promise<void>} Resolves when the batch is accepted.
   */
  send?(batch: AnalyticsBatch): Promise<void>;
  /**
   * @summary The number of events that makes a batch go out. The default is 50.
   */
  readonly batchSize?: number;
  /**
   * @summary The time between batches, in milliseconds. The default is 30 000.
   */
  readonly flushIntervalMs?: number;
  /**
   * @summary The part of sessions that collect, from 0 to 1. The default is 1.
   * @description Decided once for each session, so a sampled session is complete.
   */
  readonly sampleRate?: number;
  /**
   * @summary The largest number of batches that wait to be sent. The default is 100. The oldest goes first.
   */
  readonly maxStored?: number;
  /**
   * @summary The largest number of values of one histogram in one batch. The default is 1000.
   */
  readonly maxHistogramValues?: number;
  /**
   * @summary The clock, in Unix milliseconds. The default is `Date.now`.
   */
  readonly now?: () => number;
  /**
   * @summary The random source of sampling. The default is `Math.random`.
   */
  readonly random?: () => number;
  /**
   * @summary Sends a beacon. The default is `navigator.sendBeacon`.
   * @param {string} url The URL.
   * @param {string} body The JSON body.
   * @returns {boolean} `true` when the browser accepted it.
   */
  beacon?(url: string, body: string): boolean;
}

/**
 * @summary The state of Analytics.
 *
 * @example
 * Example 1: Collecting
 * ```ts
 * // { collecting: true, sampled: true, sessionId: 's1…', buffered: 3, outbox: 0, sent: 2, dropped: 0, lastError: null }
 * ```
 *
 * @example
 * Example 2: Showing the state on a privacy page
 * ```ts
 * status.textContent = views.state.getSnapshot().collecting ? 'On' : 'Off';
 * ```
 *
 * @public
 */
export interface AnalyticsData {
  /**
   * @summary Tells if Analytics collects now: consent is granted, and the session is sampled.
   */
  collecting: boolean;
  /**
   * @summary Tells if this session is in the sample.
   */
  sampled: boolean;
  /**
   * @summary The id of the session.
   */
  sessionId: string;
  /**
   * @summary The number of events in the buffer.
   */
  buffered: number;
  /**
   * @summary The number of batches that wait to be sent.
   */
  outbox: number;
  /**
   * @summary The number of batches sent.
   */
  sent: number;
  /**
   * @summary The number of batches dropped from a full outbox.
   */
  dropped: number;
  /**
   * @summary The message of the last failed send, or `null`.
   */
  lastError: string | null;
}

/**
 * @summary The control interface of Analytics.
 *
 * @example
 * Example 1: Recording
 * ```ts
 * const { commands } = kernel.unit<AnalyticsControl>('analytics').control!;
 * commands.increment('page.view');
 * commands.gauge('cart.size', 3);
 * ```
 *
 * @example
 * Example 2: Before a test ends
 * ```ts
 * await commands.flush();
 * ```
 *
 * @public
 */
export interface AnalyticsControl {
  /**
   * @summary The commands of Analytics. Without consent, recording does nothing.
   */
  readonly commands: {
    /**
     * @summary Adds to a counter.
     * @example
     * A page view
     * ```ts
     * commands.increment('page.view');
     * ```
     * @param {string} name The counter.
     * @param {number} [amount] The amount. The default is 1.
     * @returns {void}
     */
    increment(name: string, amount?: number): void;
    /**
     * @summary Sets a gauge. The batch keeps the last value.
     * @example
     * The memory in use
     * ```ts
     * commands.gauge('memory.mb', usedMb);
     * ```
     * @param {string} name The gauge.
     * @param {number} value The value.
     * @returns {void}
     */
    gauge(name: string, value: number): void;
    /**
     * @summary Adds a value to a histogram. The batch has a summary with percentiles.
     * @example
     * A load time
     * ```ts
     * commands.histogram('route.ms', duration);
     * ```
     * @param {string} name The histogram.
     * @param {number} value The value.
     * @returns {void}
     */
    histogram(name: string, value: number): void;
    /**
     * @summary Records a usage event.
     * @example
     * A sign-up
     * ```ts
     * commands.track('sign-up', { plan: 'free' });
     * ```
     * @param {string} name The event.
     * @param {Readonly<Record<string, unknown>>} [properties] The properties, JSON data.
     * @returns {void}
     */
    track(name: string, properties?: Readonly<Record<string, unknown>>): void;
    /**
     * @summary Makes a batch of the buffer, and sends every waiting batch now.
     * @example
     * After a checkout
     * ```ts
     * await commands.flush();
     * ```
     * @returns {Promise<void>} Resolves when the sends end. A failure stays in the outbox.
     */
    flush(): Promise<void>;
    /**
     * @summary Returns what the buffer would send now, without sending it.
     * @example
     * In a developer panel
     * ```ts
     * console.log(commands.snapshot().counters);
     * ```
     * @returns {AnalyticsBatch} The batch of the buffer.
     */
    snapshot(): AnalyticsBatch;
  };
  /**
   * @summary The views of Analytics.
   */
  readonly views: {
    /**
     * @summary The state: collecting, the buffer, the outbox and the counts.
     */
    readonly state: View<Partial<AnalyticsData>>;
  };
}

/** The parts of other subsystems that Analytics uses. It imports none of them. */
interface ConsentLike extends ControlInterface {
  readonly commands: { isGranted(category: string): boolean };
  readonly views: { readonly grants: View<Readonly<Record<string, boolean>>> };
}
interface NetworkLike extends ControlInterface {
  readonly commands: {
    request(config: {
      url: string;
      method: 'POST';
      body: unknown;
      idempotencyKey: string;
      importance: 'LOW';
      background: boolean;
    }): Promise<unknown>;
  };
}
interface OnlineSource extends ControlInterface {
  readonly views: { readonly state: View<{ readonly online?: boolean }> };
}
interface SettingsLike extends ControlInterface {
  readonly views: { readonly values: View<Readonly<Record<string, unknown>>> };
}
interface StoredOutbox {
  set(key: string, value: AnalyticsBatch): Promise<void>;
  delete(key: string): Promise<void>;
  entries(): Promise<Array<{ key: string; value: AnalyticsBatch }>>;
  clear(): Promise<void>;
}
interface StorageLike extends ControlInterface {
  readonly commands: {
    collection(definition: { name: string; maxEntries?: number }): StoredOutbox;
  };
}

/**
 * @summary Summarizes the values of a histogram: count, sum, min, max and percentiles (nearest rank).
 *
 * @example
 * Example 1: Four values
 * ```ts
 * summarize([400, 100, 300, 200]); // { count: 4, sum: 1000, min: 100, max: 400, p50: 200, p90: 400, p99: 400 }
 * ```
 *
 * @example
 * Example 2: No values
 * ```ts
 * summarize([]).count; // 0
 * ```
 *
 * @param {readonly number[]} values The values.
 * @returns {HistogramSummary} The summary.
 *
 * @public
 */
export function summarize(values: readonly number[]): HistogramSummary {
  if (values.length === 0) return { count: 0, sum: 0, min: 0, max: 0, p50: 0, p90: 0, p99: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
  return {
    count: sorted.length,
    sum: sorted.reduce((sum, v) => sum + v, 0),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p50: rank(50),
    p90: rank(90),
    p99: rank(99),
  };
}

/**
 * @summary Creates the Analytics subsystem.
 *
 * @description
 * Returns the subsystem definition (id {@linkcode ANALYTICS_ID}, featurized,
 * Tab scope). It requires Consent. Network, Storage, Settings, Global State
 * and Auth are optional: Network sends the batches (otherwise `fetch`),
 * Storage keeps the outbox over a reload, Settings gives the data saver,
 * Global State gives the online status, and Auth gives the sign-out.
 *
 * @example
 * Example 1: Registering
 * ```ts
 * new Kernel([...centralized, createConsent(), createNetwork(), createAnalytics({ endpoint: '/t/batch' })], { router: queue.router });
 * ```
 *
 * @example
 * Example 2: In a test, with a fake clock and no sampling loss
 * ```ts
 * createAnalytics({ send: async (batch) => void batches.push(batch), now: () => clock, random: () => 0 });
 * ```
 *
 * @param {AnalyticsOptions} options The endpoint or the send function, the batch rules and the sampling.
 * @returns {SubsystemDefinition<AnalyticsData, AnalyticsControl>} The subsystem.
 * @throws {RangeError} Without `endpoint` and without `send`, or for a `sampleRate` outside 0 to 1.
 *
 * @public
 */
export function createAnalytics(
  options: AnalyticsOptions,
): SubsystemDefinition<AnalyticsData, AnalyticsControl> {
  if (!options.endpoint && !options.send) {
    throw new RangeError('Analytics needs an endpoint or a send function.');
  }
  const sampleRate = options.sampleRate ?? 1;
  if (!(sampleRate >= 0 && sampleRate <= 1))
    throw new RangeError('sampleRate must be from 0 to 1.');
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const batchSize = options.batchSize ?? 50;
  const flushIntervalMs = options.flushIntervalMs ?? 30_000;
  const maxStored = options.maxStored ?? 100;
  const maxHistogramValues = options.maxHistogramValues ?? 1000;
  const beacon =
    options.beacon ??
    ((url: string, body: string) =>
      typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function'
        ? navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
        : false);

  // The buffer of the current batch.
  const counters = new Map<string, number>();
  const gauges = new Map<string, number>();
  const histograms = new Map<string, number[]>();
  const events: AnalyticsEvent[] = [];
  const clearBuffer = () => {
    counters.clear();
    gauges.clear();
    histograms.clear();
    events.length = 0;
  };
  const empty = () =>
    counters.size === 0 && gauges.size === 0 && histograms.size === 0 && events.length === 0;

  let api: { record(change: () => void, isEvent: boolean): void; flush(): Promise<void> } | null =
    null;

  return defineSubsystem({
    id: ANALYTICS_ID,
    scope: 'tab',
    kind: 'featurized',
    requires: [
      { target: 'consent' },
      { target: 'network', kind: 'optional' },
      { target: 'storage', kind: 'optional' },
      { target: 'settings', kind: 'optional' },
      { target: 'global-state', kind: 'optional' },
      { target: 'auth', kind: 'optional' },
    ],
    state: {
      initial: {
        collecting: false,
        sampled: false,
        sessionId: '',
        buffered: 0,
        outbox: 0,
        sent: 0,
        dropped: 0,
        lastError: null,
      } as AnalyticsData,
      policy: {
        collecting: { readable: true },
        sampled: { readable: true },
        sessionId: { readable: true },
        buffered: { readable: true },
        outbox: { readable: true },
        sent: { readable: true },
        dropped: { readable: true },
        lastError: { readable: true },
      },
    },
    async init(ctx) {
      const outbox: AnalyticsBatch[] = [];
      let stored: StoredOutbox | null = null;
      let sending: Promise<void> | null = null;
      let generation = 0; // a wipe raises it, so work of the old session is dropped

      const newSession = () => {
        ctx.state.update((s) => {
          s.sessionId = crypto.randomUUID();
          s.sampled = random() < sampleRate;
        });
      };
      newSession();

      const consent = () => ctx.dependency<ConsentLike>('consent');
      const granted = () => consent()?.commands.isGranted('analytics') ?? false;
      const online = () => {
        const fromState = ctx
          .dependency<OnlineSource>('global-state')
          ?.views.state.getSnapshot().online;
        if (typeof fromState === 'boolean') return fromState;
        return typeof navigator === 'undefined' || navigator.onLine !== false;
      };
      const saving = () => {
        const values = ctx.dependency<SettingsLike>('settings')?.views.values.getSnapshot();
        return values?.dataSaver === true || (values?.bandwidthMode ?? 'FULL') !== 'FULL';
      };
      const showCounts = () =>
        ctx.state.update((s) => {
          s.buffered = events.length;
          s.outbox = outbox.length;
        });
      const updateCollecting = () => {
        const collecting = granted() && ctx.state.get().sampled;
        if (collecting !== ctx.state.get().collecting) {
          ctx.state.update((s) => void (s.collecting = collecting));
        }
      };

      const makeBatch = (): AnalyticsBatch => ({
        id: crypto.randomUUID(),
        sessionId: ctx.state.get().sessionId,
        createdAt: now(),
        counters: Object.fromEntries(counters),
        gauges: Object.fromEntries(gauges),
        histograms: Object.fromEntries(
          [...histograms].map(([name, values]) => [name, summarize(values)]),
        ),
        events: [...events],
      });

      /** Moves the buffer into the outbox (and Storage). */
      const seal = () => {
        if (empty()) return;
        const batch = makeBatch();
        clearBuffer();
        outbox.push(batch);
        while (outbox.length > maxStored) {
          const dropped = outbox.shift()!;
          void stored?.delete(dropped.id).catch(() => {});
          ctx.state.update((s) => void s.dropped++);
        }
        void stored?.set(batch.id, batch).catch((error: unknown) => ctx.report(error));
        showCounts();
      };

      const sendOne = async (batch: AnalyticsBatch) => {
        if (options.send) return options.send(batch);
        const network = ctx.dependency<NetworkLike>('network');
        if (network) {
          await network.commands.request({
            url: options.endpoint!,
            method: 'POST',
            body: batch,
            idempotencyKey: batch.id,
            importance: 'LOW',
            background: true,
          });
          return;
        }
        const response = await fetch(options.endpoint!, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': batch.id },
          body: JSON.stringify(batch),
        });
        if (!response.ok) throw new Error(`The analytics endpoint answered ${response.status}.`);
      };

      /** Sends the outbox in order, until one fails. One run at a time. */
      const drain = (): Promise<void> => {
        if (sending) return sending;
        sending = (async () => {
          const started = generation;
          while (outbox.length > 0 && online() && granted()) {
            const batch = outbox[0]!;
            try {
              await sendOne(batch);
            } catch (error) {
              if (started === generation) {
                ctx.state.update(
                  (s) => void (s.lastError = (error as Error)?.message ?? String(error)),
                );
              }
              return;
            }
            if (started !== generation) return;
            if (outbox[0] === batch) outbox.shift();
            await stored?.delete(batch.id).catch(() => {});
            ctx.state.update((s) => {
              s.sent++;
              s.lastError = null;
            });
            showCounts();
          }
        })().finally(() => (sending = null));
        return sending;
      };

      const flush = async () => {
        seal();
        await drain();
      };

      /** The page hides: the last chance. Seal and beacon every batch. */
      const hide = () => {
        if (!granted()) return;
        seal();
        if (!options.endpoint) return void drain();
        for (const batch of [...outbox]) {
          if (!beacon(options.endpoint, JSON.stringify(batch))) break;
          outbox.splice(outbox.indexOf(batch), 1);
          void stored?.delete(batch.id).catch(() => {});
          ctx.state.update((s) => void s.sent++);
        }
        showCounts();
      };

      /** Deletes everything that was collected: consent revoked, or sign-out. */
      const wipe = async () => {
        generation++;
        clearBuffer();
        outbox.length = 0;
        showCounts();
        await stored?.clear().catch((error: unknown) => ctx.report(error));
      };

      api = {
        record(change, isEvent) {
          if (!ctx.state.get().collecting) return;
          change();
          if (isEvent) {
            ctx.state.update((s) => void (s.buffered = events.length));
            if (events.length >= batchSize) void flush();
          }
        },
        flush,
      };

      // Consent: collect only with the grant; a revoke deletes what was collected.
      let stopGrants: (() => void) | undefined;
      const stopConsent = ctx.watch<ConsentLike>('consent', (next) => {
        stopGrants?.();
        let wasGranted = granted();
        stopGrants = next?.views.grants.subscribe(() => {
          const isGranted = granted();
          updateCollecting();
          // Only a change of the analytics grant matters: a revoke deletes, a grant sends.
          if (wasGranted && !isGranted) void wipe();
          else if (!wasGranted && isGranted) void drain();
          wasGranted = isGranted;
        });
        updateCollecting();
      });

      // Storage: batches of an earlier page come back, and new ones are kept.
      const stopStorage = ctx.watch<StorageLike>('storage', (storage) => {
        stored =
          typeof storage?.commands?.collection === 'function'
            ? storage.commands.collection({ name: ANALYTICS_OUTBOX, maxEntries: maxStored })
            : null;
        if (!stored) return;
        const started = generation;
        void stored
          .entries()
          .then((entries) => {
            // Batches of an earlier page wait for the grant; a revoke deletes them.
            if (started !== generation) return;
            const known = new Set(outbox.map((b) => b.id));
            const earlier = entries.map((e) => e.value).filter((b) => !known.has(b.id));
            outbox.unshift(...earlier.sort((a, b) => a.createdAt - b.createdAt));
            showCounts();
            void drain();
          })
          .catch((error: unknown) => ctx.report(error));
      });

      // Online again: send what waits.
      let stopOnline: (() => void) | undefined;
      const stopGlobalState = ctx.watch<OnlineSource>('global-state', (next) => {
        stopOnline?.();
        let last = next?.views.state.getSnapshot().online;
        stopOnline = next?.views.state.subscribe(() => {
          const value = next.views.state.getSnapshot().online;
          if (value === true && last !== true) void drain();
          last = value;
        });
      });
      const onOnline = () => void drain();
      const onHide = () => {
        if (typeof document === 'undefined' || document.visibilityState === 'hidden') hide();
      };
      if (typeof addEventListener === 'function') {
        addEventListener('online', onOnline);
        addEventListener('pagehide', hide);
        addEventListener('visibilitychange', onHide);
      }

      // The interval. With the data saver, batches go out only when full or when the page hides.
      const timer = setInterval(() => {
        if (!saving()) void flush();
      }, flushIntervalMs);

      // Sign-out (§5.1): delete what the user did, and start a new session.
      const stopSignOut = watchSignOut(ctx, async () => {
        await wipe();
        newSession();
        updateCollecting();
      });

      return () => {
        clearInterval(timer);
        stopSignOut();
        stopConsent();
        stopGrants?.();
        stopStorage();
        stopGlobalState();
        stopOnline?.();
        if (typeof removeEventListener === 'function') {
          removeEventListener('online', onOnline);
          removeEventListener('pagehide', hide);
          removeEventListener('visibilitychange', onHide);
        }
        api = null;
      };
    },
    control: (ctx) => {
      const record = (change: () => void, isEvent = false) => api?.record(change, isEvent);
      return {
        commands: {
          increment: (name: string, amount = 1) =>
            record(() => counters.set(name, (counters.get(name) ?? 0) + amount)),
          gauge: (name: string, value: number) => record(() => gauges.set(name, value)),
          histogram: (name: string, value: number) =>
            record(() => {
              let values = histograms.get(name);
              if (!values) histograms.set(name, (values = []));
              if (values.length < maxHistogramValues) values.push(value);
            }),
          track: (name: string, properties: Readonly<Record<string, unknown>> = {}) =>
            record(
              () =>
                events.push({ name, properties: structuredClone(properties), timestamp: now() }),
              true,
            ),
          flush: () => api?.flush() ?? Promise.resolve(),
          snapshot: (): AnalyticsBatch => ({
            id: '',
            sessionId: ctx.state.get().sessionId,
            createdAt: now(),
            counters: Object.fromEntries(counters),
            gauges: Object.fromEntries(gauges),
            histograms: Object.fromEntries(
              [...histograms].map(([name, values]) => [name, summarize(values)]),
            ),
            events: [...events],
          }),
        },
        views: { state: ctx.state.readable },
      };
    },
  });
}
