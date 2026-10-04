import 'fake-indexeddb/auto';

import type { SubsystemDefinition } from '@platform/core';
import { createTestPlatform } from '@platform/core/testing';
import {
  GLOBAL_STATE_ID,
  createGlobalState,
  createStaticEnvironment,
  type GlobalStateControl,
} from '@platform/global-state';
import { createStorage } from '@platform/storage';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CircuitOpenError,
  HttpError,
  NETWORK_ID,
  NetworkError,
  NetworkTimeoutError,
  OfflineError,
  RequestAbortedError,
  createNetwork,
  type NetworkControl,
  type NetworkOptions,
} from '../src';

const platforms: ReturnType<typeof createTestPlatform>[] = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
});

type Handler = (request: Request, call: number) => Response | Promise<Response>;

/** A fake server: records every request and answers with the handler. */
function server(handler: Handler) {
  const calls: Request[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(request);
    if (init?.signal?.aborted) throw init.signal.reason;
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      Promise.resolve(handler(request, calls.length)).then(resolve, reject);
    });
  };
  return { calls, fetch: fetch as typeof globalThis.fetch };
}

async function start(options: NetworkOptions, extra: SubsystemDefinition[] = []) {
  const platform = createTestPlatform([
    createNetwork({
      baseUrl: 'https://api.test/',
      retryBaseMs: 1,
      random: () => 0,
      ...options,
    }) as SubsystemDefinition,
    ...extra,
  ]);
  platforms.push(platform);
  await platform.start();
  return { platform, network: platform.unit<NetworkControl>(NETWORK_ID).control! };
}

describe('requests', () => {
  it('sends GET with a query, parses JSON, and counts requests', async () => {
    const { calls, fetch } = server((r) => Response.json({ url: r.url }));
    const { network } = await start({ fetch });
    const response = await network.commands.get<{ url: string }>('/orders', {
      query: { status: 'open', page: 2, skip: undefined },
    });
    expect(response).toMatchObject({ status: 200, ok: true, fromCache: false, attempts: 1 });
    expect(response.data.url).toBe('https://api.test/orders?status=open&page=2');
    expect(response.headers['content-type']).toContain('application/json');
    expect(calls[0]!.method).toBe('GET');
    expect(network.views.state.getSnapshot()).toMatchObject({
      requests: 1,
      failures: 0,
      inFlight: 0,
    });
  });

  it('sends a plain object as JSON, and throws HttpError for a failure status', async () => {
    const { calls, fetch } = server(async (r) =>
      r.url.endsWith('/missing')
        ? Response.json({ error: 'nope' }, { status: 404 })
        : Response.json(await r.json()),
    );
    const { network } = await start({ fetch });
    const echo = await network.commands.post<{ a: number }>('/echo', { a: 1 });
    expect(echo.data).toEqual({ a: 1 });
    expect(calls[0]!.headers.get('content-type')).toBe('application/json');

    const error = await network.commands.get('/missing').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
    expect((error as HttpError).response.data).toEqual({ error: 'nope' });
    const allowed = await network.commands.get('/missing', { allowErrorStatus: true });
    expect(allowed.ok).toBe(false);
  });

  it('retries a retryable status with Retry-After, but a POST only with an idempotency key', async () => {
    const seen = new Set<string>();
    const { calls, fetch } = server((r) => {
      if (seen.has(r.url)) return Response.json('ok');
      seen.add(r.url); // the first call to each path fails
      return new Response('busy', { status: 503, headers: { 'retry-after': '0' } });
    });
    const { network } = await start({ fetch });
    expect((await network.commands.get('/a')).attempts).toBe(2);

    await expect(network.commands.post('/b', { x: 1 })).rejects.toBeInstanceOf(HttpError);
    const safe = await network.commands.post('/c', { x: 1 }, { idempotencyKey: 'change-1' });
    expect(safe.attempts).toBe(2);
    expect(calls.at(-1)!.headers.get('idempotency-key')).toBe('change-1');
  });

  it('retries a network error, and reports a timeout as NetworkTimeoutError', async () => {
    const { fetch } = server((r, call) => {
      if (r.url.endsWith('/flaky') && call === 1) throw new TypeError('fetch failed');
      if (r.url.endsWith('/slow')) return new Promise<Response>(() => {});
      return Response.json('ok');
    });
    const { network } = await start({ fetch });
    expect((await network.commands.get('/flaky')).attempts).toBe(2);
    await expect(network.commands.get('/slow', { timeoutMs: 20 })).rejects.toBeInstanceOf(
      NetworkTimeoutError,
    );
  });

  it('shares one fetch between identical GETs in flight', async () => {
    const { calls, fetch } = server(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return Response.json('once');
    });
    const { network } = await start({ fetch });
    const [a, b] = await Promise.all([
      network.commands.get('/same'),
      network.commands.get('/same'),
    ]);
    expect(a.data).toBe('once');
    expect(b.data).toBe('once');
    expect(calls).toHaveLength(1);
  });

  it('aborts one request or all, and runs higher importance first when slots are full', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetch } = server(async (r) => {
      order.push(new URL(r.url).pathname);
      if (r.url.endsWith('/hold')) await gate;
      return Response.json('ok');
    });
    const { network } = await start({ fetch, maxConcurrent: 1 });
    const hold = network.commands.get('/hold');
    const low = network.commands.get('/low', { importance: 'LOW' });
    const high = network.commands.get('/high', { importance: 'HIGH' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(network.views.state.getSnapshot().waiting).toBe(2);
    release();
    await Promise.all([hold, low, high]);
    expect(order).toEqual(['/hold', '/high', '/low']);

    const { fetch: never } = server(() => new Promise<Response>(() => {}));
    const second = await start({ fetch: never });
    const a = second.network.commands.get('/x');
    const b = second.network.commands.get('/y');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const [id] = second.network.commands.requestIds();
    expect(second.network.commands.abort(id!)).toBe(true);
    await expect(a).rejects.toBeInstanceOf(RequestAbortedError);
    expect(second.network.commands.abortAll()).toBe(1);
    await expect(b).rejects.toBeInstanceOf(RequestAbortedError);
  });
});

describe('cache', () => {
  it('serves cache-first from a fresh entry, and revalidates with an ETag', async () => {
    let version = 1;
    const { calls, fetch } = server((r) =>
      r.headers.get('if-none-match') === `"v${version}"`
        ? new Response(null, { status: 304 })
        : Response.json({ version }, { headers: { etag: `"v${version}"` } }),
    );
    let clock = 1_000;
    const { network } = await start({ fetch, now: () => clock });
    await network.commands.get('/p', { cache: 'cache-first', cacheTtlMs: 100 });
    const hit = await network.commands.get('/p', { cache: 'cache-first', cacheTtlMs: 100 });
    expect(hit.fromCache).toBe(true);
    expect(calls).toHaveLength(1);

    clock += 200; // stale: ask the server, which confirms with 304
    const revalidated = await network.commands.get<{ version: number }>('/p', {
      cache: 'cache-first',
    });
    expect(revalidated).toMatchObject({ fromCache: true, revalidated: true, data: { version: 1 } });
    version = 2;
    clock += 400_000;
    expect(
      (await network.commands.get<{ version: number }>('/p', { cache: 'cache-first' })).data
        .version,
    ).toBe(2);
    expect(await network.commands.invalidate('https://api.test/p')).toBe(1);
    await expect(network.commands.get('/p', { cache: 'cache-only' })).rejects.toBeInstanceOf(
      OfflineError,
    );
  });

  it('falls back to the cache on failure and offline with network-first; network-only fails offline', async () => {
    let up = true;
    const { fetch } = server(() =>
      up ? Response.json('fresh') : new Response('down', { status: 500 }),
    );
    const environment = createStaticEnvironment();
    const { network, platform } = await start({ fetch, retries: 0 }, [
      createGlobalState({ environment }) as SubsystemDefinition,
    ]);
    await network.commands.get('/feed', { cache: 'network-first' });
    up = false;
    expect((await network.commands.get('/feed', { cache: 'network-first' })).fromCache).toBe(true);

    environment.set({ online: false });
    await platform.settle();
    expect(network.views.state.getSnapshot().online).toBe(false);
    expect((await network.commands.get('/feed', { cache: 'network-first' })).data).toBe('fresh');
    await expect(network.commands.get('/other')).rejects.toBeInstanceOf(OfflineError);
  });

  it('keeps cached responses in Storage, so a reload can use them', async () => {
    const database = `net-${Date.now()}`;
    const storage = () =>
      createStorage({
        domain: 'shop',
        database,
        hosts: ['virtual'],
        keys: null,
        quota: false,
      }) as SubsystemDefinition;
    const { fetch } = server(() => Response.json({ cached: true }));
    const first = await start({ fetch }, [storage()]);
    await first.platform.settle();
    await first.network.commands.get('/settings', { cache: 'cache-first' });
    await first.platform.stop();
    platforms.splice(0);

    const { fetch: down, calls } = server(() => new Response('down', { status: 500 }));
    const second = await start({ fetch: down }, [storage()]);
    await second.platform.settle();
    const response = await second.network.commands.get<{ cached: boolean }>('/settings', {
      cache: 'cache-first',
    });
    expect(response).toMatchObject({ fromCache: true, data: { cached: true } });
    expect(calls).toHaveLength(0);
  });
});

describe('circuit breaker, interceptors and pending work', () => {
  it('opens after failures in a row, then lets one trial request close it', async () => {
    let up = false;
    const { fetch } = server(() =>
      up ? Response.json('ok') : new Response('down', { status: 502 }),
    );
    let clock = 0;
    const { network } = await start({
      fetch,
      retries: 0,
      now: () => clock,
      breaker: { threshold: 2, cooldownMs: 1000 },
    });
    await expect(network.commands.get('/a')).rejects.toBeInstanceOf(HttpError);
    await expect(network.commands.get('/a')).rejects.toBeInstanceOf(HttpError);
    await expect(network.commands.get('/a')).rejects.toBeInstanceOf(CircuitOpenError);
    expect(network.views.state.getSnapshot().breakers?.['https://api.test']?.state).toBe('open');
    clock = 1500;
    up = true;
    expect((await network.commands.get('/a')).ok).toBe(true);
    expect(network.views.state.getSnapshot().breakers).toEqual({});
  });

  it('runs request interceptors, and sends a request again when a response interceptor asks', async () => {
    let token = 'old';
    const { calls, fetch } = server((r) =>
      r.headers.get('authorization') === 'Bearer new'
        ? Response.json('secret')
        : new Response(null, { status: 401 }),
    );
    const { network } = await start({ fetch });
    const remove = network.commands.intercept({
      request: (r) => ({ ...r, headers: { ...r.headers, authorization: `Bearer ${token}` } }),
      response: (response) => {
        if (response.status !== 401) return undefined;
        token = 'new';
        return 'retry';
      },
    });
    expect((await network.commands.get('/me')).data).toBe('secret');
    expect(calls.map((c) => c.headers.get('authorization'))).toEqual(['Bearer old', 'Bearer new']);
    remove();
    await expect(network.commands.get('/me')).rejects.toBeInstanceOf(HttpError);
  });

  it('shows each request as pending work in Global State, except background requests', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { fetch } = server(async () => {
      await gate;
      return Response.json('ok');
    });
    const { network, platform } = await start({ fetch }, [
      createGlobalState({ environment: createStaticEnvironment() }) as SubsystemDefinition,
    ]);
    const globalState = platform.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!;
    const shown = network.commands.get('/a');
    const hidden = network.commands.get('/b', { background: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(globalState.views.state.getSnapshot().pending?.map((w) => w.label)).toEqual([
      'GET https://api.test/a',
    ]);
    release();
    await Promise.all([shown, hidden]);
    expect(globalState.views.state.getSnapshot().pending).toEqual([]);
  });

  it('makes every failure a NetworkError', async () => {
    const { fetch } = server(() => {
      throw new TypeError('down');
    });
    const { network } = await start({ fetch, retries: 0 });
    await expect(network.commands.get('/x')).rejects.toBeInstanceOf(NetworkError);
    expect(network.views.state.getSnapshot().failures).toBe(1);
  });
});
