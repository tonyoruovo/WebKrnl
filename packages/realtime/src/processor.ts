/**
 * @fileoverview
 * @summary The socket processor of Realtime: the WebSocket, reconnects, heartbeats, topics and the publish buffer.
 *
 * @description
 * The processor runs in a dedicated worker, or on the main thread
 * (docs/ARCHITECTURE.md §19.4). It gets requests from the unit and posts
 * notes back with `scope.post`.
 *
 * ```text
 *   requests  connect(token) | disconnect | subscribe | unsubscribe | publish | online | status
 *   socket    open  --> auth frame? --> subscribe every topic --> flush the buffer --> heartbeat
 *             close --> online and attempts left? --> backoff --> open again
 *             ping every heartbeatMs; no pong within heartbeatTimeoutMs --> close --> reconnect
 *   posts     { note: 'status', ... } | { note: 'message', topic, data } | { note: 'presence', data }
 *   ```
 *
 * @example
 * The worker entry
 * ```ts
 * serveProcessor(createSocketProcessor());
 * ```
 *
 * @author MathAid
 */

import {
  computeBackoff,
  defineProcessor,
  fromPortable,
  type ProcessorModule,
  type ProcessorScope,
} from '@platform/core';

import type { Frame, RealtimeProtocol, RealtimeStatus, SocketFactory, SocketLike } from './types';

/**
 * @summary The configuration of the socket processor. The unit gives it to `setup`.
 * @public
 */
export interface SocketConfig {
  /**
   * @summary The URL of the server.
   */
  readonly url: string;
  /**
   * @summary The WebSocket subprotocols.
   */
  readonly protocols?: string | string[];
  /**
   * @summary The protocol, as portable functions. The default is JSON frames.
   */
  readonly protocol?: unknown;
  /**
   * @summary How the token reaches the server.
   */
  readonly auth: 'query' | 'message' | false;
  /**
   * @summary The time between pings, in milliseconds.
   */
  readonly heartbeatMs: number;
  /**
   * @summary How long to wait for a pong, in milliseconds.
   */
  readonly heartbeatTimeoutMs: number;
  /**
   * @summary The reconnect attempts before giving up, or `null` for no limit.
   */
  readonly maxAttempts: number | null;
  /**
   * @summary The base wait of the reconnect backoff, in milliseconds.
   */
  readonly retryBaseMs: number;
  /**
   * @summary The published messages kept while disconnected.
   */
  readonly publishBuffer: number;
}

/**
 * @summary The requests that the socket processor handles.
 * @public
 */
export type SocketRequest =
  | {
      /**
       * @summary Opens the socket, or opens it again with a new token.
       */
      readonly op: 'connect';
      /**
       * @summary The access token, or `null`.
       */
      readonly token: string | null;
    }
  | {
      /**
       * @summary Closes the socket and stops reconnecting.
       */
      readonly op: 'disconnect';
    }
  | {
      /**
       * @summary Subscribes to a topic, now and after each reconnect.
       */
      readonly op: 'subscribe';
      /**
       * @summary The topic.
       */
      readonly topic: string;
    }
  | {
      /**
       * @summary Unsubscribes from a topic.
       */
      readonly op: 'unsubscribe';
      /**
       * @summary The topic.
       */
      readonly topic: string;
    }
  | {
      /**
       * @summary Sends data to a topic, or buffers it.
       */
      readonly op: 'publish';
      /**
       * @summary The topic.
       */
      readonly topic: string;
      /**
       * @summary The data.
       */
      readonly data: unknown;
    }
  | {
      /**
       * @summary Tells the processor if the platform is online.
       */
      readonly op: 'online';
      /**
       * @summary `true` when online.
       */
      readonly online: boolean;
    }
  | {
      /**
       * @summary Returns the status.
       */
      readonly op: 'status';
    }
  | {
      /**
       * @summary Drops the publish buffer. The unit calls it on sign-out (ARCHITECTURE §5.1).
       */
      readonly op: 'reset';
    };

/**
 * @summary A note that the processor posts to the unit.
 * @public
 */
export type SocketNote =
  | {
      /**
       * @summary A change of the status.
       */
      readonly note: 'status';
      /**
       * @summary The status.
       */
      readonly status: RealtimeStatus;
      /**
       * @summary The reconnect attempts.
       */
      readonly attempts: number;
      /**
       * @summary The last error, or `null`.
       */
      readonly lastError: string | null;
      /**
       * @summary The messages that the full buffer dropped.
       */
      readonly dropped: number;
    }
  | {
      /**
       * @summary A message to a topic.
       */
      readonly note: 'message';
      /**
       * @summary The topic.
       */
      readonly topic: string;
      /**
       * @summary The data.
       */
      readonly data: unknown;
    }
  | {
      /**
       * @summary A presence frame.
       */
      readonly note: 'presence';
      /**
       * @summary The data of the frame.
       */
      readonly data: unknown;
    };

/**
 * @summary The default protocol: one JSON object for each frame.
 * @public
 */
export const JSON_PROTOCOL: RealtimeProtocol = {
  encode: (frame) => JSON.stringify(frame),
  decode: (raw) => {
    try {
      const value = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw),
      ) as Frame;
      return value && typeof value.type === 'string' ? value : null;
    } catch {
      return null;
    }
  },
};

/**
 * @summary Options of {@linkcode createSocketProcessor}.
 * @public
 */
export interface SocketProcessorOptions {
  /**
   * @summary Makes the socket. The default is `new WebSocket(url, protocols)`.
   */
  readonly socket?: SocketFactory;
}

/**
 * @summary Makes the socket processor of Realtime.
 * @description The worker entry and the virtual host both use it.
 * @example
 * On the main thread with a fake socket
 * ```ts
 * createSocketProcessor({ socket: (url) => new FakeSocket(url) });
 * ```
 * @param {SocketProcessorOptions} [options] The socket factory.
 * @returns {ProcessorModule<SocketRequest, unknown>} The processor.
 * @public
 */
export function createSocketProcessor(
  options: SocketProcessorOptions = {},
): ProcessorModule<SocketRequest, unknown> {
  const make: SocketFactory =
    options.socket ?? ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike);
  let config: SocketConfig | null = null;
  let protocol: RealtimeProtocol = JSON_PROTOCOL;
  let scope: ProcessorScope | null = null;
  let socket: SocketLike | null = null;
  let token: string | null = null;
  let online = true;
  let wanted = false;
  let attempts = 0;
  let lastError: string | null = null;
  let dropped = 0;
  let status: RealtimeStatus = 'closed';
  const topics = new Set<string>();
  const buffer: Frame[] = [];
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;

  const setStatus = (next: RealtimeStatus) => {
    status = next;
    scope?.post({ note: 'status', status, attempts, lastError, dropped } satisfies SocketNote);
  };
  const send = (frame: Frame) => {
    if (socket?.readyState !== 1) return false;
    socket.send(protocol.encode(frame));
    return true;
  };
  const stopHeartbeat = () => {
    clearInterval(pingTimer);
    clearTimeout(pongTimer);
    pingTimer = undefined;
    pongTimer = undefined;
  };
  const startHeartbeat = () => {
    stopHeartbeat();
    const c = config!;
    pingTimer = setInterval(() => {
      if (!send({ type: 'ping' }) || pongTimer) return;
      pongTimer = setTimeout(() => {
        lastError = `No pong within ${c.heartbeatTimeoutMs} ms.`;
        socket?.close(4000, 'heartbeat timeout');
      }, c.heartbeatTimeoutMs);
    }, c.heartbeatMs);
  };

  function open() {
    const c = config;
    if (!c || !wanted || !online || socket) return;
    setStatus(attempts === 0 ? 'connecting' : 'reconnecting');
    let url = c.url;
    if (c.auth === 'query' && token)
      url += `${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
    let current: SocketLike;
    try {
      current = make(url, c.protocols);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      return retry();
    }
    socket = current;
    current.onopen = () => {
      if (socket !== current) return;
      attempts = 0;
      lastError = null;
      if (c.auth === 'message' && token) send({ type: 'auth', data: token });
      for (const topic of topics) send({ type: 'subscribe', topic });
      while (buffer.length > 0 && send(buffer[0]!)) buffer.shift();
      setStatus('open');
      startHeartbeat();
    };
    current.onmessage = (event) => {
      if (socket !== current) return;
      const frame = protocol.decode(event.data as string | ArrayBuffer);
      if (!frame) return;
      clearTimeout(pongTimer);
      pongTimer = undefined;
      if (frame.type === 'ping') send({ type: 'pong' });
      else if (frame.type === 'message' && frame.topic !== undefined) {
        scope?.post({ note: 'message', topic: frame.topic, data: frame.data } satisfies SocketNote);
      } else if (frame.type === 'presence') {
        scope?.post({ note: 'presence', data: frame.data } satisfies SocketNote);
      }
    };
    current.onerror = () => {
      if (socket === current) lastError = 'The socket reported an error.';
    };
    current.onclose = (event) => {
      if (socket !== current) return;
      socket = null;
      stopHeartbeat();
      if (!lastError && event.code !== 1000)
        lastError = `The socket closed (${event.code ?? 'no code'}).`;
      retry();
    };
  }

  function retry() {
    const c = config!;
    clearTimeout(reconnectTimer);
    if (!wanted || !online) return setStatus('closed');
    if (c.maxAttempts !== null && attempts >= c.maxAttempts) {
      lastError = `Gave up after ${attempts} attempts.`;
      wanted = false;
      return setStatus('closed');
    }
    attempts++;
    setStatus('reconnecting');
    reconnectTimer = setTimeout(
      open,
      computeBackoff({
        base: c.retryBaseMs,
        attempts: attempts - 1,
        strategy: 'exponential-jitter',
      }),
    );
  }

  function close(code: number, reason: string) {
    clearTimeout(reconnectTimer);
    stopHeartbeat();
    const current = socket;
    socket = null;
    if (current) {
      setStatus('closing');
      current.close(code, reason);
    }
  }

  return defineProcessor<SocketRequest, unknown>({
    setup(processorScope, value) {
      scope = processorScope;
      config = value as SocketConfig;
      protocol = config.protocol ? fromPortable<RealtimeProtocol>(config.protocol) : JSON_PROTOCOL;
    },

    handle(request) {
      switch (request.op) {
        case 'connect':
          wanted = true;
          if (request.token !== token || status === 'closed') {
            token = request.token;
            attempts = 0;
            close(1000, 'reconnect');
            open();
          }
          return status;
        case 'disconnect':
          wanted = false;
          close(1000, 'disconnect');
          setStatus('closed');
          return status;
        case 'subscribe':
          if (!topics.has(request.topic)) {
            topics.add(request.topic);
            send({ type: 'subscribe', topic: request.topic });
          }
          return status;
        case 'unsubscribe':
          if (topics.delete(request.topic)) send({ type: 'unsubscribe', topic: request.topic });
          return status;
        case 'publish': {
          const frame: Frame = { type: 'publish', topic: request.topic, data: request.data };
          if (!send(frame)) {
            buffer.push(frame);
            if (buffer.length > config!.publishBuffer) {
              buffer.shift();
              dropped++;
            }
          }
          return status;
        }
        case 'online':
          online = request.online;
          if (online) {
            attempts = 0;
            clearTimeout(reconnectTimer);
            open();
          } else {
            close(1001, 'offline');
            setStatus('closed');
          }
          return status;
        case 'reset':
          buffer.length = 0;
          dropped = 0;
          return status;
        case 'status':
          return { status, attempts, lastError, dropped };
        default:
          throw new Error(`Unknown Realtime operation "${(request as { op: string }).op}".`);
      }
    },

    teardown() {
      wanted = false;
      close(1000, 'teardown');
      scope = null;
    },
  });
}
