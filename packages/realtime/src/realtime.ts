/**
 * @fileoverview
 * @summary The Realtime subsystem: one socket for many topics, with reconnects, heartbeats and presence.
 *
 * @description
 * `createRealtime` gives the subsystem `realtime` (featurized, Tab scope, no
 * required dependency). Its processor `socket` owns the WebSocket in a
 * dedicated worker, or on the main thread (docs/ARCHITECTURE.md §19.4).
 *
 * ```text
 *   subscribe(topic, listener) --> first listener --> processor 'subscribe' (again after each reconnect)
 *   processor note 'message'   --> listeners of the topic --> 'realtime:message' (broadcast topics)
 *   processor note 'status'    --> state --> 'realtime:connection-changed'
 *   Global State online        --> processor 'online' (offline closes; online reconnects at once)
 *   Auth token changes         --> processor 'connect' with the new token
 *   ```
 *
 * @example
 * A chat room
 * ```ts
 * const kernel = new Kernel([createRealtime({ url: 'wss://rt.shop.example' })]);
 * await kernel.start();
 * const realtime = kernel.unit<RealtimeControl>(REALTIME_ID).control!;
 * realtime.commands.subscribe('chat:42', (data) => render(data));
 * ```
 *
 * @author MathAid
 */

import {
  defineSubsystem,
  toPortable,
  type ControlInterface,
  type ProcessorDef,
  type SubsystemDefinition,
  type View,
} from '@platform/core';

import {
  createSocketProcessor,
  type SocketConfig,
  type SocketNote,
  type SocketRequest,
} from './processor';
import type {
  ConnectionChanged,
  Presence,
  RealtimeControl,
  RealtimeData,
  RealtimeMessage,
  RealtimeOptions,
} from './types';

/**
 * @summary The id of the Realtime subsystem.
 * @public
 */
export const REALTIME_ID = 'realtime';

/**
 * @summary The Tab broadcast after each change of the socket status. The payload is a {@linkcode ConnectionChanged}.
 * @public
 */
export const REALTIME_CONNECTION_CHANGED = 'realtime:connection-changed';

/**
 * @summary The Tab broadcast for each message to a topic subscribed with `broadcast: true`. The payload is a {@linkcode RealtimeMessage}.
 * @public
 */
export const REALTIME_MESSAGE = 'realtime:message';

/** The part of Global State that Realtime uses. */
interface GlobalStateLike extends ControlInterface {
  readonly views: { readonly state: View<{ readonly online?: boolean }> };
}

/** The part of Auth that Realtime uses. */
interface AuthLike extends ControlInterface {
  readonly commands: { accessToken(): string | null };
  readonly views: {
    readonly state: View<{ readonly status?: string; readonly expiresAt?: number | null }>;
  };
}

/**
 * @summary Makes the Realtime subsystem.
 *
 * @example
 * Example 1: An app with Auth
 * ```ts
 * createRealtime({ url: 'wss://rt.shop.example/socket', auth: 'query' });
 * ```
 *
 * @example
 * Example 2: A test with a fake socket on the main thread
 * ```ts
 * createRealtime({ url: 'ws://test', hosts: ['virtual'], socket: (url) => server.connect(url) });
 * ```
 *
 * @param {RealtimeOptions} options The URL, hosts, socket factory, protocol, auth and timings.
 * @returns {SubsystemDefinition<RealtimeData, RealtimeControl>} The definition, for the kernel.
 * @public
 */
export function createRealtime(
  options: RealtimeOptions,
): SubsystemDefinition<RealtimeData, RealtimeControl> {
  const config: SocketConfig = {
    url: options.url,
    ...(options.protocols ? { protocols: options.protocols } : {}),
    ...(options.protocol ? { protocol: toPortable(options.protocol) } : {}),
    auth: options.auth ?? false,
    heartbeatMs: options.heartbeatMs ?? 25_000,
    heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 10_000,
    maxAttempts: options.maxAttempts ?? null,
    retryBaseMs: options.retryBaseMs ?? 500,
    publishBuffer: options.publishBuffer ?? 100,
  };
  const processor: ProcessorDef<SocketRequest, unknown> = {
    id: 'socket',
    job: 'notifier',
    hosts: options.hosts ?? ['dedicated', 'virtual'],
    config,
    load: async () => createSocketProcessor(options.socket ? { socket: options.socket } : {}),
    dedicated: () => new Worker(new URL('./socket.worker.ts', import.meta.url), { type: 'module' }),
  };
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  const broadcastTopics = new Map<string, number>();
  const presenceTimeoutMs = options.presenceTimeoutMs ?? 60_000;

  const readable = { readable: true } as const;
  return defineSubsystem({
    id: REALTIME_ID,
    scope: 'tab',
    kind: 'featurized',
    processors: [processor],
    requires: [
      { target: 'global-state', kind: 'optional' },
      { target: 'auth', kind: 'optional' },
    ],
    state: {
      initial: {
        host: null,
        status: 'closed',
        attempts: 0,
        lastError: null,
        topics: [],
        presence: {},
        dropped: 0,
      } as RealtimeData,
      policy: {
        host: readable,
        status: readable,
        attempts: readable,
        lastError: readable,
        topics: readable,
        presence: readable,
        dropped: readable,
      },
    },

    init(ctx) {
      const handle = ctx.processor<SocketRequest, unknown>('socket');
      const call = (request: SocketRequest) =>
        handle.call(request).catch((error: unknown) => ctx.report(error));
      const token = () =>
        config.auth === false
          ? null
          : (ctx.dependency<AuthLike>('auth')?.commands.accessToken() ?? null);

      const stopHost = handle.status.subscribe(() => {
        const host = handle.status.getSnapshot().host;
        ctx.state.update((s) => void (s.host = host));
        // A failover starts a new processor: give it the topics and the connection again.
        if (host) {
          for (const topic of listeners.keys()) void call({ op: 'subscribe', topic });
          if (ctx.state.get().status !== 'closed' || options.autoConnect !== false) {
            void call({ op: 'connect', token: token() });
          }
        }
      });
      ctx.state.update((s) => void (s.host = handle.status.getSnapshot().host));

      const stopPosts = handle.onPost((message) => {
        const note = message as SocketNote;
        if (note.note === 'status') {
          const from = ctx.state.get().status;
          ctx.state.update((s) => {
            s.status = note.status;
            s.attempts = note.attempts;
            s.lastError = note.lastError;
            s.dropped = note.dropped;
          });
          if (from !== note.status) {
            const payload: ConnectionChanged = { from, to: note.status, attempts: note.attempts };
            ctx.port
              .send({ eventId: REALTIME_CONNECTION_CHANGED, payload, importance: 'HIGH' })
              .catch((error: unknown) => ctx.report(error));
          }
        } else if (note.note === 'message') {
          for (const listener of listeners.get(note.topic) ?? []) {
            try {
              listener(note.data);
            } catch (error) {
              ctx.report(error);
            }
          }
          if ((broadcastTopics.get(note.topic) ?? 0) > 0) {
            const payload: RealtimeMessage = {
              topic: note.topic,
              data: note.data,
              receivedAt: Date.now(),
            };
            ctx.port
              .send({ eventId: REALTIME_MESSAGE, payload })
              .catch((error: unknown) => ctx.report(error));
          }
        } else if (note.note === 'presence') {
          const data = note.data as { peer?: unknown; status?: unknown } | null;
          if (typeof data?.peer !== 'string') return;
          const status =
            data.status === 'away' || data.status === 'offline' ? data.status : 'online';
          ctx.state.update(
            (s) => void (s.presence[data.peer as string] = { status, lastSeen: Date.now() }),
          );
        }
      });

      // Peers without news become offline.
      const sweep = setInterval(
        () => {
          const limit = Date.now() - presenceTimeoutMs;
          const stale = Object.entries(ctx.state.get().presence).filter(
            ([, p]) => p.status !== 'offline' && p.lastSeen < limit,
          );
          if (stale.length === 0) return;
          ctx.state.update((s) => {
            for (const [peer, p] of stale) s.presence[peer] = { ...p, status: 'offline' };
          });
        },
        Math.min(presenceTimeoutMs, 10_000),
      );
      (sweep as { unref?: () => void }).unref?.();

      let stopOnline: (() => void) | undefined;
      const stopGlobal = ctx.watch<GlobalStateLike>('global-state', (globalState) => {
        stopOnline?.();
        stopOnline = undefined;
        if (!globalState) return;
        let last: boolean | undefined;
        const read = () => {
          const online = globalState.views.state.getSnapshot().online ?? true;
          if (online === last) return;
          last = online;
          void call({ op: 'online', online });
        };
        stopOnline = globalState.views.state.subscribe(read);
        read();
      });

      // A new token (sign-in, refresh, sign-out) opens the socket again.
      let stopToken: (() => void) | undefined;
      const stopAuth =
        config.auth === false
          ? () => {}
          : ctx.watch<AuthLike>('auth', (auth) => {
              stopToken?.();
              stopToken = undefined;
              if (!auth) return;
              let last = auth.commands.accessToken();
              stopToken = auth.views.state.subscribe(() => {
                const next = auth.commands.accessToken();
                if (next === last) return;
                last = next;
                if (ctx.state.get().status !== 'closed' || options.autoConnect !== false) {
                  void call({ op: 'connect', token: next });
                }
              });
            });

      if (options.autoConnect !== false) void call({ op: 'connect', token: token() });

      return () => {
        stopHost();
        stopPosts();
        clearInterval(sweep);
        stopGlobal();
        stopOnline?.();
        stopAuth();
        stopToken?.();
      };
    },

    control: (ctx) => {
      const handle = () => ctx.processor<SocketRequest, unknown>('socket');
      const token = () =>
        config.auth === false
          ? null
          : (ctx.dependency<AuthLike>('auth')?.commands.accessToken() ?? null);
      const topics = () => ctx.state.update((s) => void (s.topics = [...listeners.keys()]));
      return {
        commands: {
          connect: async () => void (await handle().call({ op: 'connect', token: token() })),
          disconnect: async () => void (await handle().call({ op: 'disconnect' })),
          subscribe(
            topic: string,
            listener: (data: unknown) => void,
            subscribeOptions: { readonly broadcast?: boolean } = {},
          ) {
            let set = listeners.get(topic);
            if (!set) {
              listeners.set(topic, (set = new Set()));
              topics();
              void handle()
                .call({ op: 'subscribe', topic })
                .catch((error: unknown) => ctx.report(error));
            }
            set.add(listener);
            if (subscribeOptions.broadcast)
              broadcastTopics.set(topic, (broadcastTopics.get(topic) ?? 0) + 1);
            let active = true;
            return () => {
              if (!active) return;
              active = false;
              set.delete(listener);
              if (subscribeOptions.broadcast)
                broadcastTopics.set(topic, (broadcastTopics.get(topic) ?? 1) - 1);
              if (set.size > 0) return;
              listeners.delete(topic);
              topics();
              void handle()
                .call({ op: 'unsubscribe', topic })
                .catch((error: unknown) => ctx.report(error));
            };
          },
          publish: async (topic: string, data: unknown) =>
            void (await handle().call({ op: 'publish', topic, data })),
          presence: (peer: string): Presence | undefined => ctx.state.get().presence[peer],
        },
        views: { state: ctx.state.readable },
      };
    },
  });
}
