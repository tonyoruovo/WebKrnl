/**
 * @fileoverview
 * @summary The Network subsystem: requests with timeouts, retries, deduplication, a cache, a circuit breaker and interceptors.
 *
 * @description
 * `createNetwork` gives the subsystem `network` (featurized, Tab scope, no
 * required dependency). It runs on the main thread (docs/ARCHITECTURE.md §19.1).
 *
 * ```text
 *   request(config)
 *     cache-only / cache-first (fresh) --> cache
 *     offline --> stale cache (network-first, cache-first) or OfflineError
 *     identical GET in flight --> share it
 *     wait for a slot (priority) --> breaker --> request interceptors --> fetch (timeout)
 *       network error / 408 425 429 5xx --> backoff (Retry-After) --> retry (idempotent or idempotencyKey)
 *       304 --> cached body
 *       response interceptors --> 'retry' sends it one more time
 *     2xx --> cache (GET, strategy not network-only) --> NetworkResponse
 *     other --> HttpError (or the response, with allowErrorStatus)
 *   ```
 *
 * @example
 * Starting the Network
 * ```ts
 * const kernel = new Kernel([createNetwork({ baseUrl: 'https://api.shop.example' })]);
 * await kernel.start();
 * const { commands } = kernel.unit<NetworkControl>(NETWORK_ID).control!;
 * const { data } = await commands.get('/me');
 * ```
 *
 * @author MathAid
 */

import {
  computeBackoff,
  defineSubsystem,
  type ControlInterface,
  type Importance,
  type SubsystemDefinition,
  type UnitContext,
  type View,
} from '@platform/core';

import { Breakers } from './breaker';
import { ResponseCache, type CacheCollection, type CacheEntry } from './cache';
import {
  CircuitOpenError,
  HttpError,
  NetworkError,
  NetworkTimeoutError,
  OfflineError,
  RequestAbortedError,
} from './errors';
import type {
  HttpMethod,
  Interceptor,
  NetworkControl,
  NetworkData,
  NetworkOptions,
  NetworkResponse,
  PreparedRequest,
  RequestConfig,
} from './types';

/**
 * @summary The id of the Network subsystem.
 * @public
 */
export const NETWORK_ID = 'network';

/**
 * @summary The statuses that a request retries.
 * @public
 */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

const IDEMPOTENT: ReadonlySet<HttpMethod> = new Set(['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']);
const RANK: Readonly<Record<Importance, number>> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };

/** The part of Global State that the Network uses. It does not import the package. */
interface GlobalStateLike extends ControlInterface {
  readonly commands: {
    beginWork(work: {
      id: string;
      subsystemId: string;
      importance: Importance;
      label?: string;
    }): boolean;
    endWork(id: string): void;
  };
  readonly views: { readonly state: View<{ readonly online?: boolean }> };
}

/** The part of Storage that the Network uses. */
interface StorageLike extends ControlInterface {
  readonly commands: {
    collection(definition: { name: string; maxEntries?: number }): CacheCollection;
  };
}

function lowerHeaders(headers: Readonly<Record<string, string>> | Headers | undefined) {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers)
    headers.forEach((value, name) => (out[name.toLowerCase()] = value));
  else for (const [name, value] of Object.entries(headers)) out[name.toLowerCase()] = value;
  return out;
}

function isRawBody(body: unknown): body is BodyInit {
  return (
    typeof body === 'string' ||
    (typeof Blob !== 'undefined' && body instanceof Blob) ||
    (typeof FormData !== 'undefined' && body instanceof FormData) ||
    (typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams) ||
    (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  );
}

function retryAfterMs(header: string | undefined, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * @summary Makes the Network subsystem.
 *
 * @example
 * Example 1: An app
 * ```ts
 * const kernel = new Kernel([createGlobalState(), createNetwork({ baseUrl: 'https://api.shop.example' })]);
 * ```
 *
 * @example
 * Example 2: A test with a fake server
 * ```ts
 * createNetwork({ fetch: async (url) => Response.json({ url: String(url) }), retryBaseMs: 1 });
 * ```
 *
 * @param {NetworkOptions} [options] The base URL, timeouts, retries, cache, breaker and `fetch`.
 * @returns {SubsystemDefinition<NetworkData, NetworkControl>} The definition, for the kernel.
 * @public
 */
export function createNetwork(
  options: NetworkOptions = {},
): SubsystemDefinition<NetworkData, NetworkControl> {
  const now = options.now ?? Date.now;
  const base =
    options.baseUrl ??
    (typeof location !== 'undefined' && location.href ? location.href : 'http://localhost/');
  const maxConcurrent = options.maxConcurrent ?? 6;
  const cache = new ResponseCache(options.cacheEntries ?? 200);
  const breakers =
    options.breaker === false
      ? null
      : new Breakers(
          {
            threshold: options.breaker?.threshold ?? 5,
            cooldownMs: options.breaker?.cooldownMs ?? 30_000,
          },
          now,
        );
  const interceptors = new Set<Interceptor>();
  const controllers = new Map<string, AbortController>();
  const waiting: Array<{
    id: string;
    rank: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  const shared = new Map<string, Promise<NetworkResponse<unknown>>>();
  let active = 0;
  let counter = 0;
  let online = true;
  let context: UnitContext<NetworkData> | null = null;

  const doFetch = (input: string, init: RequestInit) =>
    (options.fetch ?? globalThis.fetch)(input, init);
  const update = (change: (s: NetworkData) => void) => context?.state.update(change);
  const counts = () =>
    update((s) => {
      s.inFlight = active;
      s.waiting = waiting.length;
      s.breakers = breakers?.snapshot() ?? {};
    });

  function acquire(id: string, rank: number, signal: AbortSignal): Promise<void> {
    if (active < maxConcurrent) {
      active++;
      counts();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const item = { id, rank, resolve, reject };
      const at = waiting.findIndex((w) => w.rank > rank);
      waiting.splice(at < 0 ? waiting.length : at, 0, item);
      counts();
      signal.addEventListener(
        'abort',
        () => {
          const index = waiting.indexOf(item);
          if (index < 0) return;
          waiting.splice(index, 1);
          counts();
          reject(signal.reason);
        },
        { once: true },
      );
    });
  }

  function release() {
    active--;
    const next = waiting.shift();
    if (next) {
      active++;
      next.resolve();
    }
    counts();
  }

  function fromEntry(
    id: string,
    url: string,
    entry: CacheEntry,
    revalidated: boolean,
    attempts: number,
    started: number,
  ): NetworkResponse<unknown> {
    return {
      id,
      url,
      status: entry.status,
      ok: entry.status >= 200 && entry.status < 300,
      headers: entry.headers,
      data: entry.data,
      fromCache: true,
      revalidated,
      attempts,
      durationMs: now() - started,
    };
  }

  async function parse(
    response: Response,
    method: HttpMethod,
    config: RequestConfig,
  ): Promise<unknown> {
    if (method === 'HEAD' || response.status === 204 || response.status === 304) return null;
    switch (config.responseType ?? 'auto') {
      case 'json':
        return response.json();
      case 'text':
        return response.text();
      case 'blob':
        return response.blob();
      case 'arrayBuffer':
        return response.arrayBuffer();
      default: {
        const text = await response.text();
        const type = response.headers.get('content-type') ?? '';
        if (!type.includes('json') || text === '') return text === '' ? null : text;
        return JSON.parse(text) as unknown;
      }
    }
  }

  async function run<T>(config: RequestConfig): Promise<NetworkResponse<T>> {
    const id = `req-${++counter}`;
    const method = config.method ?? 'GET';
    const target = new URL(config.url, base);
    for (const [name, value] of Object.entries(config.query ?? {})) {
      if (value !== undefined) target.searchParams.set(name, String(value));
    }
    const url = target.href;
    const strategy = config.cache ?? 'network-only';
    const key = ResponseCache.key(method, url);
    const started = now();
    update((s) => void s.requests++);

    const lookup = async () => {
      if (method !== 'GET' || strategy === 'network-only') return undefined;
      const entry = await cache.get(key);
      update((s) => void (entry ? s.cacheHits++ : s.cacheMisses++));
      return entry;
    };
    const entry = await lookup();
    if (strategy === 'cache-only') {
      if (entry) return fromEntry(id, url, entry, false, 0, started) as NetworkResponse<T>;
      throw new OfflineError(`[network] No cached response for ${url}.`, id);
    }
    if (strategy === 'cache-first' && entry && entry.expiresAt > now()) {
      return fromEntry(id, url, entry, false, 0, started) as NetworkResponse<T>;
    }
    if (!online) {
      if (entry) return fromEntry(id, url, entry, false, 0, started) as NetworkResponse<T>;
      update((s) => void s.failures++);
      throw new OfflineError(`[network] The platform is offline: ${method} ${url}.`, id);
    }

    // Identical GETs share one fetch.
    const dedupe = method === 'GET' && config.body === undefined && !config.signal;
    if (dedupe) {
      const pending = shared.get(key);
      if (pending) return pending as Promise<NetworkResponse<T>>;
    }
    const promise = send<T>(id, config, method, url, key, strategy, entry, started);
    if (dedupe) {
      shared.set(key, promise);
      void promise.then(
        () => shared.delete(key),
        () => shared.delete(key),
      );
    }
    return promise;
  }

  async function send<T>(
    id: string,
    config: RequestConfig,
    method: HttpMethod,
    url: string,
    key: string,
    strategy: RequestConfig['cache'],
    entry: CacheEntry | undefined,
    started: number,
  ): Promise<NetworkResponse<T>> {
    const origin = new URL(url).origin;
    const controller = new AbortController();
    controllers.set(id, controller);
    const onCallerAbort = () =>
      controller.abort(new RequestAbortedError('[network] The request was aborted.', id));
    config.signal?.addEventListener('abort', onCallerAbort, { once: true });
    if (config.signal?.aborted) onCallerAbort();

    const globalState = context?.dependency<GlobalStateLike>('global-state');
    const tracked =
      !config.background &&
      (globalState?.commands.beginWork({
        id: `network:${id}`,
        subsystemId: NETWORK_ID,
        importance: config.importance ?? 'MEDIUM',
        label: `${method} ${url}`,
      }) ??
        false);
    const retries = config.retries ?? options.retries ?? 3;
    const canRetry = IDEMPOTENT.has(method) || config.idempotencyKey !== undefined;
    const timeoutMs = config.timeoutMs ?? options.timeoutMs ?? 30_000;
    const stale = () =>
      (strategy === 'network-first' || strategy === 'cache-first') && entry
        ? (fromEntry(id, url, entry, false, attempt, started) as NetworkResponse<T>)
        : null;
    const backoff = (attempt: number) =>
      computeBackoff({
        base: options.retryBaseMs ?? 300,
        attempts: attempt - 1,
        strategy: 'exponential-jitter',
        ...(options.random ? { random: options.random } : {}),
      });
    const fail = (error: unknown): never => {
      update((s) => void s.failures++);
      throw error;
    };

    let attempt = 0;
    let replayed = false;
    let slot = false;
    try {
      await acquire(id, RANK[config.importance ?? 'MEDIUM'], controller.signal).catch(fail);
      slot = true;
      for (;;) {
        attempt++;
        if (breakers && !breakers.allow(origin)) {
          counts();
          return (
            stale() ??
            fail(new CircuitOpenError(id, origin, breakers.state(origin).retryAt ?? now()))
          );
        }
        const headers = lowerHeaders(config.headers);
        let body: BodyInit | null = null;
        if (config.body !== undefined && config.body !== null) {
          if (isRawBody(config.body)) body = config.body;
          else {
            body = JSON.stringify(config.body);
            headers['content-type'] ??= 'application/json';
          }
        }
        if (config.idempotencyKey !== undefined) headers['idempotency-key'] = config.idempotencyKey;
        if (entry?.etag && method === 'GET') headers['if-none-match'] = entry.etag;
        let prepared: PreparedRequest = { id, url, method, headers, body, attempt };
        for (const interceptor of interceptors) {
          if (interceptor.request) prepared = await interceptor.request(prepared);
        }

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort(
            new NetworkTimeoutError(`[network] No response within ${timeoutMs} ms.`, id),
          );
        }, timeoutMs);
        let raw: Response;
        try {
          raw = await doFetch(prepared.url, {
            method: prepared.method,
            headers: prepared.headers,
            body: prepared.body,
            signal: controller.signal,
            credentials: config.credentials ?? 'same-origin',
          });
        } catch (cause) {
          clearTimeout(timer);
          if (controller.signal.aborted && !timedOut) return fail(controller.signal.reason);
          breakers?.failure(origin);
          counts();
          const error = timedOut
            ? (controller.signal.reason as NetworkTimeoutError)
            : new NetworkError(`[network] ${method} ${url} failed.`, id, { cause });
          if (canRetry && attempt <= retries && !timedOut) {
            await sleep(backoff(attempt), controller.signal).catch(fail);
            continue;
          }
          return stale() ?? fail(error);
        }
        clearTimeout(timer);

        const headersOut = lowerHeaders(raw.headers);
        if (raw.status === 304 && entry) {
          breakers?.success(origin);
          counts();
          const refreshed: CacheEntry = {
            ...entry,
            storedAt: now(),
            expiresAt: now() + (config.cacheTtlMs ?? options.cacheTtlMs ?? 300_000),
          };
          await cache.set(key, refreshed);
          return fromEntry(id, url, refreshed, true, attempt, started) as NetworkResponse<T>;
        }
        const data = await parse(raw, method, config).catch((cause: unknown) =>
          fail(new NetworkError(`[network] The body of ${url} does not parse.`, id, { cause })),
        );
        const response: NetworkResponse<T> = {
          id,
          url,
          status: raw.status,
          ok: raw.ok,
          headers: headersOut,
          data: data as T,
          fromCache: false,
          revalidated: false,
          attempts: attempt,
          durationMs: now() - started,
        };

        let again = false;
        for (const interceptor of interceptors) {
          if (interceptor.response && (await interceptor.response(response, prepared)) === 'retry')
            again = true;
        }
        if (again && !replayed) {
          replayed = true;
          continue;
        }

        if (!raw.ok) {
          if (raw.status >= 500) breakers?.failure(origin);
          else breakers?.success(origin);
          counts();
          if (RETRYABLE_STATUSES.has(raw.status) && canRetry && attempt <= retries) {
            const wait = retryAfterMs(headersOut['retry-after'], now()) ?? backoff(attempt);
            await sleep(Math.min(wait, 60_000), controller.signal).catch(fail);
            continue;
          }
          if (raw.status >= 500) {
            const fallback = stale();
            if (fallback) return fallback;
          }
          if (config.allowErrorStatus) return response;
          return fail(new HttpError(response));
        }

        breakers?.success(origin);
        counts();
        if (method === 'GET' && strategy !== 'network-only') {
          const isCloneable = !(data instanceof Blob) && !(data instanceof ArrayBuffer);
          if (isCloneable) {
            await cache.set(key, {
              status: raw.status,
              headers: headersOut,
              data,
              etag: headersOut.etag ?? null,
              storedAt: now(),
              expiresAt: now() + (config.cacheTtlMs ?? options.cacheTtlMs ?? 300_000),
            });
          }
        }
        return response;
      }
    } finally {
      config.signal?.removeEventListener('abort', onCallerAbort);
      controllers.delete(id);
      if (slot) release();
      if (tracked) globalState?.commands.endWork(`network:${id}`);
    }
  }

  const readable = { readable: true } as const;
  return defineSubsystem({
    id: NETWORK_ID,
    scope: 'tab',
    kind: 'featurized',
    requires: [
      { target: 'global-state', kind: 'optional' },
      { target: 'storage', kind: 'optional' },
    ],
    state: {
      initial: {
        online: true,
        inFlight: 0,
        waiting: 0,
        breakers: {},
        requests: 0,
        failures: 0,
        cacheHits: 0,
        cacheMisses: 0,
      } as NetworkData,
      policy: {
        online: readable,
        inFlight: readable,
        waiting: readable,
        breakers: readable,
        requests: readable,
        failures: readable,
        cacheHits: readable,
        cacheMisses: readable,
      },
    },

    init(ctx) {
      context = ctx;
      const setOnline = (value: boolean) => {
        online = value;
        ctx.state.update((s) => void (s.online = value));
      };
      // Global State decides when it runs; the browser events decide otherwise.
      let fromGlobal = false;
      let stopView: (() => void) | undefined;
      const stopGlobal = ctx.watch<GlobalStateLike>('global-state', (globalState) => {
        stopView?.();
        stopView = undefined;
        fromGlobal = globalState !== undefined;
        if (!globalState) {
          setOnline(typeof navigator === 'undefined' || navigator.onLine !== false);
          return;
        }
        const read = () => setOnline(globalState.views.state.getSnapshot().online ?? true);
        stopView = globalState.views.state.subscribe(read);
        read();
      });
      const onBrowser = () => {
        if (!fromGlobal) setOnline(navigator.onLine !== false);
      };
      const events = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
      if (events) {
        window.addEventListener('online', onBrowser);
        window.addEventListener('offline', onBrowser);
      }
      const stopStorage = ctx.watch<StorageLike>('storage', (storage) =>
        cache.bind(
          storage ? storage.commands.collection({ name: 'network.cache', maxEntries: 500 }) : null,
        ),
      );
      return () => {
        stopGlobal();
        stopView?.();
        stopStorage();
        cache.bind(null);
        if (events) {
          window.removeEventListener('online', onBrowser);
          window.removeEventListener('offline', onBrowser);
        }
        for (const controller of controllers.values()) {
          controller.abort(new RequestAbortedError('[network] The Network stopped.', ''));
        }
        context = null;
      };
    },

    control: (ctx) => {
      const abortOne = (id: string) => {
        const controller = controllers.get(id);
        if (!controller) return false;
        controller.abort(new RequestAbortedError('[network] The request was aborted.', id));
        return true;
      };
      return {
        commands: {
          request: <T>(config: RequestConfig) => run<T>(config),
          get: <T>(url: string, config: Omit<RequestConfig, 'url' | 'method'> = {}) =>
            run<T>({ ...config, url, method: 'GET' }),
          post: <T>(
            url: string,
            body: unknown,
            config: Omit<RequestConfig, 'url' | 'method' | 'body'> = {},
          ) => run<T>({ ...config, url, body, method: 'POST' }),
          put: <T>(
            url: string,
            body: unknown,
            config: Omit<RequestConfig, 'url' | 'method' | 'body'> = {},
          ) => run<T>({ ...config, url, body, method: 'PUT' }),
          patch: <T>(
            url: string,
            body: unknown,
            config: Omit<RequestConfig, 'url' | 'method' | 'body'> = {},
          ) => run<T>({ ...config, url, body, method: 'PATCH' }),
          delete: <T>(url: string, config: Omit<RequestConfig, 'url' | 'method'> = {}) =>
            run<T>({ ...config, url, method: 'DELETE' }),
          abort: abortOne,
          abortAll: () => [...controllers.keys()].filter(abortOne).length,
          requestIds: () => [...controllers.keys()],
          invalidate: (prefix?: string) => cache.invalidate(prefix),
          intercept(interceptor: Interceptor) {
            interceptors.add(interceptor);
            return () => void interceptors.delete(interceptor);
          },
        },
        views: { state: ctx.state.readable },
      };
    },
  });
}
