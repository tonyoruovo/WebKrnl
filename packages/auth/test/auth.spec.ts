import 'fake-indexeddb/auto';

import { Kernel, type SubsystemDefinition } from '@platform/core';
import {
  WINDOW_TRANSPORT_ID,
  createWindowTransport,
  type WindowTransportControl,
} from '@platform/hub';
import { NETWORK_ID, createNetwork, type NetworkControl } from '@platform/network';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';
import { createStorage } from '@platform/storage';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AUTH_ID,
  AuthLockedError,
  createAuth,
  meetsRequirement,
  type AuthControl,
  type AuthHandlers,
  type AuthOptions,
  type AuthSession,
} from '../src';

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop();
});

interface Credentials {
  readonly user: string;
  readonly password: string;
}

const user = { id: 'u1', name: 'Ada', roles: ['USER'], permissions: ['orders:read'], level: 10 };

/** A fake auth server: tokens are 'access-<n>'; /api accepts only the newest one. */
function authServer(options: { accessTtlMs?: number; refreshFails?: boolean } = {}) {
  let generation = 0;
  const log: string[] = [];
  const session = (): AuthSession => ({
    user,
    accessToken: `access-${++generation}`,
    refreshToken: `refresh-${generation}`,
    accessExpiresAt: Date.now() + (options.accessTtlMs ?? 60 * 60_000),
  });
  const handlers: AuthHandlers<Credentials> = {
    async login(credentials) {
      log.push('login');
      if (credentials.password !== 'right')
        throw Object.assign(new Error('bad password'), { status: 401 });
      return session();
    },
    async refresh(current, { network }) {
      log.push(`refresh:${current.refreshToken}`);
      if (network)
        await network.commands.post('https://api.test/auth/refresh', {
          token: current.refreshToken,
        });
      if (options.refreshFails) throw Object.assign(new Error('revoked'), { status: 401 });
      return session();
    },
    async logout() {
      log.push('logout');
    },
    async elevate(request) {
      return {
        token: 'elev-1',
        permissions: request.permissions,
        expiresAt: Date.now() + request.durationMs,
        reason: request.reason,
      };
    },
  };
  const seen: Array<{ url: string; authorization: string | null }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push({ url: request.url, authorization: request.headers.get('authorization') });
    if (request.url.endsWith('/auth/refresh')) {
      return options.refreshFails ? new Response(null, { status: 401 }) : Response.json('ok');
    }
    if (request.url.startsWith('https://api.test/')) {
      return request.headers.get('authorization') === `Bearer access-${generation}`
        ? Response.json('secret')
        : new Response(null, { status: 401 });
    }
    return Response.json('public');
  }) as typeof globalThis.fetch;
  return { handlers, log, seen, fetch, expire: () => generation++ };
}

/** One tab: Queue, Notification Center, window transport, Network, Storage and Auth. */
async function tab(
  server: ReturnType<typeof authServer>,
  options: Partial<AuthOptions<Credentials>> & { database?: string; channel?: string } = {},
) {
  const { database, channel, ...authOptions } = options;
  const notification = createNotificationCenter();
  const queue = createQueue({ fanOut: notification.fanOut });
  const units: SubsystemDefinition[] = [
    queue.subsystem,
    notification.subsystem,
    createWindowTransport({
      origin: 'https://shop.test',
      channel: channel ?? `auth-${Math.random()}`,
    }) as SubsystemDefinition,
    createNetwork({
      fetch: server.fetch,
      retryBaseMs: 1,
      baseUrl: 'https://shop.test/',
    }) as SubsystemDefinition,
    createAuth<Credentials>({
      handlers: server.handlers,
      protectedOrigins: ['https://api.test'],
      persist: database ? 'encrypted' : false,
      ...authOptions,
    }) as SubsystemDefinition,
  ];
  if (database) {
    units.push(
      createStorage({
        domain: 'shop',
        database,
        hosts: ['virtual'],
        keys: { source: { kind: 'device' }, database: `${database}-keys` },
        quota: false,
      }) as SubsystemDefinition,
    );
  }
  const kernel = new Kernel(units, { router: queue.router });
  kernels.push(kernel);
  await kernel.start();
  const transport = kernel.unit<WindowTransportControl>(WINDOW_TRANSPORT_ID).control!;
  await expect.poll(() => transport.views.state.getSnapshot().connection).toBe('connected');
  return {
    kernel,
    auth: kernel.unit<AuthControl<Credentials>>(AUTH_ID).control!,
    network: kernel.unit<NetworkControl>(NETWORK_ID).control!,
  };
}

describe('Auth', () => {
  it('signs in, keeps tokens out of the state, and locks login after failures', async () => {
    const server = authServer();
    const { auth } = await tab(server, { lockout: { maxAttempts: 2, durationMs: 60_000 } });
    await expect(auth.commands.login({ user: 'ada', password: 'wrong' })).rejects.toThrow(
      'bad password',
    );
    expect(auth.views.state.getSnapshot()).toMatchObject({
      status: 'UNAUTHENTICATED',
      failedAttempts: 1,
    });

    expect(await auth.commands.login({ user: 'ada', password: 'right' })).toMatchObject({
      id: 'u1',
    });
    const state = auth.views.state.getSnapshot();
    expect(state).toMatchObject({ status: 'AUTHENTICATED', user: { id: 'u1' }, failedAttempts: 0 });
    expect(JSON.stringify(state)).not.toContain('access-');
    expect(auth.commands.accessToken()).toBe('access-1');

    await auth.commands.logout();
    await expect(auth.commands.login({ user: 'ada', password: 'x' })).rejects.toThrow();
    await expect(auth.commands.login({ user: 'ada', password: 'x' })).rejects.toThrow();
    await expect(auth.commands.login({ user: 'ada', password: 'right' })).rejects.toBeInstanceOf(
      AuthLockedError,
    );
    expect(server.log).toContain('logout');
  });

  it('sends the token only to protected origins, and refreshes once on a 401', async () => {
    const server = authServer();
    const { auth, network } = await tab(server);
    await auth.commands.login({ user: 'ada', password: 'right' });
    await network.commands.get('https://cdn.other/logo');
    expect(server.seen.at(-1)).toEqual({ url: 'https://cdn.other/logo', authorization: null });

    server.expire(); // the server no longer accepts the token
    expect((await network.commands.get('https://api.test/orders')).data).toBe('secret');
    expect(server.log.filter((l) => l.startsWith('refresh'))).toEqual(['refresh:refresh-1']);
    // The refresh request of the handler did not carry the access token, and did not loop.
    expect(server.seen.find((s) => s.url.endsWith('/auth/refresh'))?.authorization).toBeNull();
  });

  it('marks the session EXPIRED when the refresh is refused, without a loop', async () => {
    const server = authServer({ refreshFails: true });
    const { auth, network, kernel } = await tab(server);
    await auth.commands.login({ user: 'ada', password: 'right' });
    server.expire();
    await expect(network.commands.get('https://api.test/orders')).rejects.toThrow();
    expect(auth.views.state.getSnapshot().status).toBe('EXPIRED');
    expect(server.log.filter((l) => l.startsWith('refresh'))).toHaveLength(1);
    void kernel;
  });

  it('refreshes before the access token expires', async () => {
    const server = authServer({ accessTtlMs: 80 });
    const { auth } = await tab(server, { refreshBeforeMs: 50 });
    await auth.commands.login({ user: 'ada', password: 'right' });
    await expect.poll(() => auth.commands.accessToken(), { timeout: 2000 }).toBe('access-2');
  });

  it('checks permissions, roles and levels, and grants elevations that expire', async () => {
    const server = authServer();
    const { auth } = await tab(server);
    expect(auth.commands.check({ permissions: ['orders:read'] })).toBe(false);
    await auth.commands.login({ user: 'ada', password: 'right' });
    expect(auth.commands.hasPermission('orders:read')).toBe(true);
    expect(auth.commands.hasRole('USER')).toBe(true);
    expect(auth.commands.check({ roles: ['ADMIN'] })).toBe(false);
    expect(auth.commands.check({ permissions: ['orders:read'], level: 10 })).toBe(true);
    expect(auth.commands.hasPermission('orders:refund')).toBe(false);

    const elevation = await auth.commands.elevate(['orders:refund'], 40, 'Refund 42');
    expect(elevation).not.toHaveProperty('token');
    expect(auth.commands.hasPermission('orders:refund')).toBe(true);
    expect(auth.commands.elevationToken('orders:refund')).toBe('elev-1');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(auth.commands.hasPermission('orders:refund')).toBe(false);
    expect(meetsRequirement(user, { roles: ['USER'], level: 5 })).toBe(true);
  });

  it('keeps the session in encrypted Storage, so a reload stays signed in', async () => {
    const server = authServer();
    const database = `auth-${Date.now()}`;
    const first = await tab(server, { database });
    await expect.poll(() => first.auth.views.state.getSnapshot().persistent).toBe(true);
    await first.auth.commands.login({ user: 'ada', password: 'right' });
    await first.kernel.stop();
    kernels.splice(0);

    const second = await tab(server, { database });
    await expect.poll(() => second.auth.views.state.getSnapshot().status).toBe('AUTHENTICATED');
    expect(second.auth.commands.accessToken()).toBe('access-1');
  });

  it('shares sign-in and sign-out with the other tabs of the site, and refreshes once for both', async () => {
    const server = authServer();
    const database = `auth-tabs-${Date.now()}`;
    const channel = `auth-tabs-${Math.random()}`;
    const a = await tab(server, { database, channel });
    const b = await tab(server, { database, channel });
    await a.auth.commands.login({ user: 'ada', password: 'right' });
    await expect.poll(() => b.auth.views.state.getSnapshot().status).toBe('AUTHENTICATED');
    expect(b.auth.commands.accessToken()).toBe('access-1');

    await Promise.all([a.auth.commands.refresh(), b.auth.commands.refresh()]);
    expect(server.log.filter((l) => l.startsWith('refresh'))).toEqual(['refresh:refresh-1']);
    expect(a.auth.commands.accessToken()).toBe(b.auth.commands.accessToken());

    await a.auth.commands.logout();
    await expect.poll(() => b.auth.views.state.getSnapshot().status).toBe('UNAUTHENTICATED');
    expect(b.auth.commands.accessToken()).toBeNull();
  });
});
