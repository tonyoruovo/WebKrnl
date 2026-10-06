/**
 * @fileoverview
 * @summary The Global transport: the feature `global` of Realtime, which carries Global and Window envelopes through the server.
 *
 * @description
 * The feature attaches to the Notification Center as the relay of Global
 * scope, keeps each outgoing envelope in an outbox until the server
 * acknowledges it, and gives envelopes from the server to the Queue
 * (docs/ARCHITECTURE.md §20.1). It also gives the hub a Window relay (§20.2).
 *
 * ```text
 *   send     Global broadcast --> encodeWire --> outbox (memory + 'realtime.global-outbox')
 *            socket open:   publish on 'platform:global' --> server 'ack' --> out of the outbox
 *            socket closed: POST <http>/publish (Network) --> { ack } --> out of the outbox
 *            no ack within ackTimeoutMs, or a reconnect --> send again (receivers drop repeats)
 *   receive  'platform:global' (socket) or GET <http>/poll --> decodeWire --> Queue.ingest
 *   window   publish(windowId) --> 'platform:window:<windowId>' through the same outbox
 *   ```
 *
 * @example
 * Turning the transport on
 * ```ts
 * createRealtime({ url: 'wss://rt.shop.example/socket', auth: 'message', global: { http: 'https://rt.shop.example/global' } });
 * ```
 *
 * @author MathAid
 */

import {
  createDeduplicator,
  createStore,
  decodeWire,
  defineUnit,
  encodeWire,
  watchSignOut,
  type ControlInterface,
  type PacketEnvelope,
  type ScopeRelay,
  type UnitContext,
  type UnitDefinition,
  type View,
} from '@webkrnl/core';

import type { RealtimeStatus } from './types';

/**
 * @summary The reserved topic of Global envelopes.
 * @public
 */
export const GLOBAL_TOPIC = 'platform:global';

/**
 * @summary The Storage collection of the outbox.
 * @public
 */
export const GLOBAL_OUTBOX = 'realtime.global-outbox';

/**
 * @summary Returns the reserved topic of the Window relay for one window id.
 * @example
 * A topic
 * ```ts
 * windowTopic('w-42'); // 'platform:window:w-42'
 * ```
 * @param {string} windowId The window id (from the session cookie on the apex domain).
 * @returns {string} The topic.
 * @public
 */
export function windowTopic(windowId: string): string {
  return `platform:window:${windowId}`;
}

/**
 * @summary What the feature needs from the Realtime socket. Realtime gives it.
 * @public
 */
export interface SocketBridge {
  /**
   * @summary The status of the socket.
   */
  readonly status: View<RealtimeStatus>;
  /**
   * @summary Sends a frame on a topic, without the publish buffer.
   * @example
   * Sending
   * ```ts
   * const sent = await bridge.send('platform:global', envelope);
   * ```
   * @param {string} topic The topic.
   * @param {unknown} data The data.
   * @returns {Promise<boolean>} `true` when the frame went out.
   */
  send(topic: string, data: unknown): Promise<boolean>;
  /**
   * @summary Listens to a topic. Realtime subscribes on the server, also after each reconnect.
   * @example
   * Listening
   * ```ts
   * const stop = bridge.subscribe('platform:global', (data) => receive(data));
   * ```
   * @param {string} topic The topic.
   * @param {Function} listener Gets the data of each message.
   * @returns {() => void} Stops listening.
   */
  subscribe(topic: string, listener: (data: unknown) => void): () => void;
  /**
   * @summary Listens to the acknowledgements of the server.
   * @example
   * Listening
   * ```ts
   * bridge.onAck((messageId) => outbox.delete(messageId));
   * ```
   * @param {Function} listener Gets the `messageId` of each acknowledged envelope.
   * @returns {() => void} Stops listening.
   */
  onAck(listener: (messageId: string) => void): () => void;
}

/**
 * @summary The Window relay that the feature gives to the hub (docs/ARCHITECTURE.md §20.2).
 * @description It has the shape of `WindowRelay` of `@webkrnl/hub`.
 * @public
 */
export interface GlobalWindowRelay {
  /**
   * @summary Sends a Window envelope to the other connections of the same window id.
   * @example
   * Sending
   * ```ts
   * relay.publish(windowId, envelope);
   * ```
   * @param {string} windowId The window id.
   * @param {PacketEnvelope} envelope The envelope.
   * @returns {void}
   */
  publish(windowId: string, envelope: PacketEnvelope): void;
  /**
   * @summary Receives the Window envelopes of a window id.
   * @example
   * Receiving
   * ```ts
   * const stop = relay.subscribe(windowId, (envelope) => deliver(envelope));
   * ```
   * @param {string} windowId The window id.
   * @param {Function} listener Gets each envelope.
   * @returns {() => void} Stops receiving.
   */
  subscribe(windowId: string, listener: (envelope: PacketEnvelope) => void): () => void;
  /**
   * @summary `true` while the socket is open or HTTP polling runs.
   */
  readonly connected: View<boolean>;
}

/**
 * @summary Options of the Global transport (`createRealtime({ global })`).
 * @example
 * Example 1: The socket only
 * ```ts
 * const global: GlobalOptions = {};
 * ```
 * @example
 * Example 2: With the HTTP fallback
 * ```ts
 * const global: GlobalOptions = { http: 'https://rt.shop.example/global', ackTimeoutMs: 5000 };
 * ```
 * @public
 */
export interface GlobalOptions {
  /**
   * @summary The base URL of the HTTP fallback (`<http>/publish`, `<http>/poll`). Without it, there is no fallback.
   */
  readonly http?: string;
  /**
   * @summary How long to wait for an acknowledgement before sending again, in milliseconds. The default is 10 000.
   */
  readonly ackTimeoutMs?: number;
  /**
   * @summary The largest number of envelopes in the outbox. The default is 500.
   */
  readonly maxOutbox?: number;
  /**
   * @summary How long the server may hold a poll, in milliseconds. The default is 25 000.
   */
  readonly pollTimeoutMs?: number;
}

/**
 * @summary The state of the Global transport.
 * @example
 * Example 1: Online
 * ```ts
 * // { transport: 'socket', outbox: 0, sent: 12, received: 30, dropped: 0 }
 * ```
 * @example
 * Example 2: Offline with work
 * ```ts
 * // { transport: 'none', outbox: 3, ... }
 * ```
 * @public
 */
export interface GlobalData {
  /**
   * @summary How envelopes travel now.
   */
  transport: 'socket' | 'http' | 'none';
  /**
   * @summary The envelopes that wait for an acknowledgement.
   */
  outbox: number;
  /**
   * @summary The envelopes sent, repeats included.
   */
  sent: number;
  /**
   * @summary The envelopes received and given to the Queue.
   */
  received: number;
  /**
   * @summary The envelopes dropped: invalid, expired, or out of a full outbox.
   */
  dropped: number;
}

/**
 * @summary The control interface of the Global transport.
 * @public
 */
export interface GlobalControl {
  /**
   * @summary The commands.
   */
  readonly commands: {
    /**
     * @summary Sends the outbox now, if a transport is available.
     * @example
     * After a long pause
     * ```ts
     * await commands.flush();
     * ```
     * @returns {Promise<void>} Resolves when the run ends.
     */
    flush(): Promise<void>;
  };
  /**
   * @summary The views.
   */
  readonly views: {
    /**
     * @summary The state of the transport.
     */
    readonly state: View<Partial<GlobalData>>;
  };
}

/** One envelope in the outbox. */
interface OutboxEntry {
  readonly id: string;
  readonly channel: string;
  readonly wire: string;
  readonly queuedAt: number;
}

interface NotificationLike extends ControlInterface {
  readonly commands: { attachRelay(relay: ScopeRelay): () => void };
}
interface QueueLike extends ControlInterface {
  readonly commands: { ingest(envelope: PacketEnvelope): Promise<boolean> };
}
interface StoredOutbox {
  set(key: string, value: Omit<OutboxEntry, 'id'>): Promise<void>;
  delete(key: string): Promise<void>;
  entries(): Promise<Array<{ key: string; value: Omit<OutboxEntry, 'id'> }>>;
  clear(): Promise<void>;
}
interface StorageLike extends ControlInterface {
  readonly commands: {
    collection(definition: { name: string; maxEntries?: number }): StoredOutbox;
  };
}
interface NetworkLike extends ControlInterface {
  readonly commands: {
    request<T = unknown>(config: {
      url: string;
      method?: 'GET' | 'POST';
      body?: unknown;
      query?: Record<string, string>;
      timeoutMs?: number;
      background?: boolean;
      retries?: number;
      signal?: AbortSignal;
    }): Promise<{ readonly data: T }>;
  };
  readonly views: { readonly state: View<{ readonly online?: boolean }> };
}

/**
 * @summary Makes the Global transport: the feature unit and its Window relay.
 * @description Realtime calls it when `createRealtime` gets the option `global`.
 * @example
 * In Realtime
 * ```ts
 * const global = createGlobalFeature(bridge, options.global);
 * defineSubsystem({ ..., features: [global.unit] });
 * ```
 * @param {SocketBridge} bridge The socket of Realtime.
 * @param {GlobalOptions} [options] The fallback, the timeouts and the outbox size.
 * @returns The feature unit, and the Window relay for the hub.
 * @public
 */
export function createGlobalFeature(
  bridge: SocketBridge,
  options: GlobalOptions = {},
): { unit: UnitDefinition<GlobalData, GlobalControl>; relay: GlobalWindowRelay } {
  const ackTimeoutMs = options.ackTimeoutMs ?? 10_000;
  const maxOutbox = options.maxOutbox ?? 500;
  const outbox = new Map<string, OutboxEntry>();
  const sentAt = new Map<string, number>();
  const connected = createStore(false);
  const windowListeners = new Map<string, Set<(envelope: PacketEnvelope) => void>>();
  const topicStops = new Map<string, () => void>();
  // The envelopes that this tab sent. A poll, or a server, can send them back: they are dropped.
  const own = createDeduplicator(1000);
  const isOwn = (envelope: PacketEnvelope) => own.seen(envelope.metadata.messageId);
  let context: UnitContext<GlobalData> | null = null;
  let flush: () => Promise<void> = async () => {};

  const relay: GlobalWindowRelay = {
    publish: (windowId, envelope) => enqueue(windowTopic(windowId), envelope),
    subscribe(windowId, listener) {
      let set = windowListeners.get(windowId);
      let stopTopic: (() => void) | undefined;
      if (!set) {
        windowListeners.set(windowId, (set = new Set()));
        stopTopic = bridge.subscribe(windowTopic(windowId), (data) => {
          const envelope = decode(data);
          if (envelope && !isOwn(envelope)) {
            for (const l of [...(windowListeners.get(windowId) ?? [])]) l(envelope);
          }
        });
        topicStops.set(windowId, stopTopic);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size > 0) return;
        windowListeners.delete(windowId);
        topicStops.get(windowId)?.();
        topicStops.delete(windowId);
      };
    },
    connected: connected.view,
  };

  function decode(data: unknown): PacketEnvelope | null {
    try {
      return decodeWire(data);
    } catch (error) {
      context?.report(error);
      context?.state.update((s) => void s.dropped++);
      return null;
    }
  }

  function enqueue(channel: string, envelope: PacketEnvelope) {
    const ctx = context;
    let wire: string;
    try {
      wire = encodeWire(envelope);
    } catch (error) {
      ctx?.report(error);
      ctx?.state.update((s) => void s.dropped++);
      return;
    }
    own.seen(envelope.metadata.messageId);
    const entry: OutboxEntry = {
      id: envelope.metadata.messageId,
      channel,
      wire,
      queuedAt: Date.now(),
    };
    outbox.set(entry.id, entry);
    while (outbox.size > maxOutbox) {
      const oldest = outbox.keys().next().value!;
      remove(oldest);
      ctx?.state.update((s) => void s.dropped++);
    }
    store
      ?.set(entry.id, { channel, wire, queuedAt: entry.queuedAt })
      .catch((e: unknown) => ctx?.report(e));
    count();
    void flush();
  }

  let store: StoredOutbox | null = null;
  const count = () => context?.state.update((s) => void (s.outbox = outbox.size));
  function remove(id: string) {
    if (!outbox.delete(id)) return;
    sentAt.delete(id);
    store?.delete(id).catch((e: unknown) => context?.report(e));
    count();
  }

  const readable = { readable: true } as const;
  const unit = defineUnit<GlobalData, GlobalControl>({
    id: 'global',
    requires: [
      { target: 'notification', kind: 'optional' },
      { target: 'queue', kind: 'optional' },
      { target: 'storage', kind: 'optional' },
      { target: 'network', kind: 'optional' },
      { target: 'auth', kind: 'optional' },
    ],
    state: {
      initial: { transport: 'none', outbox: 0, sent: 0, received: 0, dropped: 0 } as GlobalData,
      policy: {
        transport: readable,
        outbox: readable,
        sent: readable,
        received: readable,
        dropped: readable,
      },
    },

    init(ctx) {
      context = ctx;
      let running = true;
      let flushing: Promise<void> | null = null;
      let again = false;
      let poller: AbortController | null = null;

      const network = () => ctx.dependency<NetworkLike>('network');
      const online = () => network()?.views.state.getSnapshot().online ?? true;
      const transport = (): GlobalData['transport'] => {
        if (bridge.status.getSnapshot() === 'open') return 'socket';
        if (options.http && network() && online()) return 'http';
        return 'none';
      };
      const ingest = (envelope: PacketEnvelope) => {
        ctx.state.update((s) => void s.received++);
        const queue = ctx.dependency<QueueLike>('queue');
        if (!queue) return;
        // The Queue drops repeats by messageId, our own envelope included.
        queue.commands.ingest(envelope).catch((error: unknown) => ctx.report(error));
      };
      const deliver = (channel: string, data: unknown) => {
        const envelope = decode(data);
        if (!envelope || isOwn(envelope)) return;
        if (channel === GLOBAL_TOPIC) return ingest(envelope);
        const windowId = channel.slice('platform:window:'.length);
        for (const listener of [...(windowListeners.get(windowId) ?? [])]) listener(envelope);
      };

      async function sendOne(entry: OutboxEntry, via: GlobalData['transport']): Promise<boolean> {
        const envelope = JSON.parse(entry.wire) as unknown;
        if (via === 'socket') {
          const sent = await bridge.send(entry.channel, envelope);
          if (sent) sentAt.set(entry.id, Date.now());
          return sent;
        }
        const response = await network()!.commands.request<{ ack?: string }>({
          url: `${options.http}/publish`,
          method: 'POST',
          body: { channel: entry.channel, envelope },
          background: true,
          retries: 0,
        });
        if (response.data?.ack === entry.id) remove(entry.id);
        return true;
      }

      flush = () => {
        if (flushing) {
          again = true;
          return flushing;
        }
        flushing = (async () => {
          do {
            again = false;
            const via = transport();
            if (via === 'none') break;
            for (const entry of [...outbox.values()]) {
              if (!running) return;
              const { ttl, timestamp } = (JSON.parse(entry.wire) as PacketEnvelope).metadata;
              if (ttl !== undefined && timestamp + ttl < Date.now()) {
                remove(entry.id);
                ctx.state.update((s) => void s.dropped++);
                continue;
              }
              const last = sentAt.get(entry.id);
              if (via === 'socket' && last !== undefined && Date.now() - last < ackTimeoutMs)
                continue;
              try {
                if (!(await sendOne(entry, via))) break;
                ctx.state.update((s) => void s.sent++);
              } catch (error) {
                ctx.report(error);
                break;
              }
            }
          } while (again && running);
        })().finally(() => {
          flushing = null;
        });
        return flushing;
      };

      // HTTP long polling while the socket is not open.
      let cursor: string | null = null;
      async function poll(signal: AbortSignal) {
        while (!signal.aborted) {
          try {
            const channels = [GLOBAL_TOPIC, ...[...windowListeners.keys()].map(windowTopic)];
            const response = await network()!.commands.request<{
              envelopes?: Array<{ channel: string; envelope: unknown }>;
              cursor?: string;
            }>({
              url: `${options.http}/poll`,
              query: { channels: channels.join(','), ...(cursor ? { cursor } : {}) },
              timeoutMs: (options.pollTimeoutMs ?? 25_000) + 5_000,
              background: true,
              retries: 0,
              signal,
            });
            cursor = response.data?.cursor ?? cursor;
            for (const item of response.data?.envelopes ?? []) deliver(item.channel, item.envelope);
          } catch {
            if (signal.aborted) return;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }
      }

      const sync = () => {
        const via = transport();
        const before = ctx.state.get().transport;
        if (via !== before) ctx.state.update((s) => void (s.transport = via));
        connected.set(via !== 'none');
        if (via === 'http' && !poller) {
          poller = new AbortController();
          void poll(poller.signal);
        } else if (via !== 'http' && poller) {
          poller.abort();
          poller = null;
        }
        // A new connection: everything that waits for an ack goes out again.
        if (via !== before && via !== 'none') {
          sentAt.clear();
          void flush();
        }
      };

      const stopStatus = bridge.status.subscribe(sync);
      const stopAcks = bridge.onAck((id) => remove(id));
      const stopGlobal = bridge.subscribe(GLOBAL_TOPIC, (data) => deliver(GLOBAL_TOPIC, data));
      let stopNetworkView: (() => void) | undefined;
      const stopNetwork = ctx.watch<NetworkLike>('network', (control) => {
        stopNetworkView?.();
        stopNetworkView = control?.views.state.subscribe(sync);
        sync();
      });
      let detach: (() => void) | undefined;
      const stopNotification = ctx.watch<NotificationLike>('notification', (notification) => {
        detach?.();
        detach = notification?.commands.attachRelay({
          scope: 'global',
          publish: (envelope) => enqueue(GLOBAL_TOPIC, envelope),
        });
      });
      const stopStorage = ctx.watch<StorageLike>('storage', (storage) => {
        store = storage
          ? storage.commands.collection({ name: GLOBAL_OUTBOX, maxEntries: maxOutbox })
          : null;
        const bound = store;
        if (!bound) return;
        // Envelopes of a session before a reload come back, and the ones of this session are stored.
        // Storage can answer before its coordinator is ready: try again a few times.
        const load = async (attempt: number): Promise<void> => {
          let rows: Array<{ key: string; value: Omit<OutboxEntry, 'id'> }>;
          try {
            rows = await bound.entries();
          } catch (error) {
            if (store !== bound) return;
            if (attempt >= 20) return ctx.report(error);
            await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
            return load(attempt + 1);
          }
          if (store !== bound) return;
          for (const { key, value } of rows) {
            if (!outbox.has(key)) outbox.set(key, { id: key, ...value });
          }
          const stored = new Set(rows.map((row) => row.key));
          for (const entry of outbox.values()) {
            if (!stored.has(entry.id)) {
              await bound.set(entry.id, {
                channel: entry.channel,
                wire: entry.wire,
                queuedAt: entry.queuedAt,
              });
            }
          }
          count();
          await flush();
        };
        void load(0).catch((error: unknown) => ctx.report(error));
      });
      // Resend what waits too long for an acknowledgement.
      const timer = setInterval(() => void flush(), Math.max(50, ackTimeoutMs / 2));
      (timer as { unref?: () => void }).unref?.();
      // Sign-out (ARCHITECTURE §5.1): the outbox holds the envelopes of the user.
      const stopSignOut = watchSignOut(ctx, async () => {
        outbox.clear();
        sentAt.clear();
        count();
        await store?.clear();
      });
      sync();

      return () => {
        running = false;
        stopSignOut();
        clearInterval(timer);
        poller?.abort();
        poller = null;
        detach?.();
        stopNotification();
        stopStorage();
        stopNetwork();
        stopNetworkView?.();
        stopGlobal();
        stopAcks();
        stopStatus();
        store = null;
        connected.set(false);
        flush = async () => {};
        context = null;
      };
    },

    control: (ctx) => ({
      commands: { flush: () => flush() },
      views: { state: ctx.state.readable },
    }),
  });
  return { unit, relay };
}
