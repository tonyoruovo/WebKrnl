/**
 * The Global transport (docs/ARCHITECTURE.md §20): the Window relay, the
 * HTTP fallback, invalid and expired envelopes, and the sign-out wipe.
 */
import {
  Kernel,
  NO_CONTROL,
  createEnvelope,
  type PacketPort,
  type SubsystemDefinition,
} from '@webkrnl/core';
import { createTestAuth } from '@webkrnl/core/testing';
import {
  createGlobalState,
  createStaticEnvironment,
  type StaticEnvironment,
} from '@webkrnl/global-state';
import { createNetwork } from '@webkrnl/network';
import { createNotificationCenter } from '@webkrnl/notification';
import { createQueue } from '@webkrnl/queue';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REALTIME_ID,
  createRealtime,
  type GlobalControl,
  type GlobalOptions,
  type RealtimeControl,
} from '../src';

import { GlobalServer } from './global-server';

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop();
});

interface DeviceOptions {
  readonly environment?: StaticEnvironment;
  readonly global?: GlobalOptions;
  readonly network?: boolean;
  readonly extra?: SubsystemDefinition[];
  readonly socket?: (url: string) => ReturnType<GlobalServer['connect']>;
}

async function device(server: GlobalServer, options: DeviceOptions = {}) {
  let port: PacketPort | undefined;
  const received: unknown[] = [];
  const errors: unknown[] = [];
  const units: SubsystemDefinition[] = [
    createGlobalState({
      environment: options.environment ?? createStaticEnvironment(),
    }) as SubsystemDefinition,
    createRealtime({
      url: 'wss://rt.test/socket',
      hosts: ['virtual'],
      socket: options.socket ?? server.connect,
      retryBaseMs: 5,
      global: { ackTimeoutMs: 60, ...options.global },
    }) as SubsystemDefinition,
    {
      id: 'sender',
      scope: 'global',
      kind: 'featurized',
      state: { initial: {} },
      init: (ctx) => void (port = ctx.port),
      control: () => NO_CONTROL,
    },
    {
      id: 'inbox',
      scope: 'global',
      kind: 'featurized',
      state: { initial: {} },
      subscribes: ['news'],
      receive: (packet) => void received.push(packet.take()),
      control: () => NO_CONTROL,
    },
    ...(options.extra ?? []),
  ];
  if (options.network) {
    units.push(
      createNetwork({
        fetch: server.fetch,
        retryBaseMs: 1,
        baseUrl: 'https://rt.test/',
      }) as SubsystemDefinition,
    );
  }
  const notification = createNotificationCenter();
  const queue = createQueue({ fanOut: notification.fanOut });
  const kernel = new Kernel(
    [queue.subsystem, notification.subsystem, ...units] as SubsystemDefinition[],
    {
      router: queue.router,
      onError: (error) => void errors.push(error),
    },
  );
  kernels.push(kernel);
  await kernel.start();
  return {
    kernel,
    port: () => port!,
    received,
    errors,
    global: kernel.unit<GlobalControl>(`${REALTIME_ID}/global`).control!,
    realtime: kernel.unit<RealtimeControl>(REALTIME_ID).control!,
  };
}

const windowEnvelope = (payload: unknown) =>
  createEnvelope({ eventId: 'cart:changed', payload }, { source: 'cart', scope: 'window' });

describe('the Window relay', () => {
  it('reaches only the connections that subscribed to the same window id', async () => {
    const server = new GlobalServer();
    const a = await device(server);
    const b = await device(server);
    const c = await device(server);
    const gotB: unknown[] = [];
    const gotC: unknown[] = [];
    b.realtime.commands.windowRelay()!.subscribe('w1', (e) => void gotB.push(e.payload));
    c.realtime.commands.windowRelay()!.subscribe('w2', (e) => void gotC.push(e.payload));
    await expect.poll(() => a.realtime.commands.windowRelay()!.connected.getSnapshot()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20)); // the subscriptions reach the server

    a.realtime.commands.windowRelay()!.publish('w1', windowEnvelope({ items: 2 }));
    await expect.poll(() => gotB).toEqual([{ items: 2 }]);
    await expect.poll(() => a.global.views.state.getSnapshot().outbox).toBe(0);
    expect(gotC).toEqual([]);
  });
});

describe('the HTTP fallback', () => {
  it('publishes and polls through Network while the socket cannot open', async () => {
    const server = new GlobalServer();
    const viaSocket = await device(server);
    await expect.poll(() => viaSocket.global.views.state.getSnapshot().transport).toBe('socket');
    server.accept = false;
    const viaHttp = await device(server, {
      network: true,
      global: { http: 'https://rt.test/global' },
    });
    await expect.poll(() => viaHttp.global.views.state.getSnapshot().transport).toBe('http');
    await new Promise((resolve) => setTimeout(resolve, 30)); // the first poll gets the cursor

    await viaHttp.port().send({ eventId: 'news', payload: 'from http' });
    await expect.poll(() => viaSocket.received).toEqual(['from http']);
    expect(viaHttp.global.views.state.getSnapshot().outbox).toBe(0);

    await viaSocket.port().send({ eventId: 'news', payload: 'from the socket' });
    await expect.poll(() => viaHttp.received).toEqual(['from http', 'from the socket']);
  });
});

describe('envelopes that must not travel', () => {
  it('drops an invalid envelope from the server, and an expired one from the outbox', async () => {
    const server = new GlobalServer();
    const environment = createStaticEnvironment({ online: false });
    const a = await device(server, { environment });
    const b = await device(server);
    await expect.poll(() => b.global.views.state.getSnapshot().transport).toBe('socket');
    await new Promise((resolve) => setTimeout(resolve, 20));

    server.forward('platform:global', { v: 1, eventId: '' }, null);
    await expect.poll(() => b.global.views.state.getSnapshot().dropped).toBe(1);
    expect(b.received).toEqual([]);

    await a.port().send({ eventId: 'news', payload: 'stale', ttl: 20 });
    await a.port().send({ eventId: 'news', payload: 'fresh' });
    await expect.poll(() => a.global.views.state.getSnapshot().outbox).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 40));
    environment.set({ online: true });
    await expect.poll(() => b.received).toEqual(['fresh']);
    expect(a.global.views.state.getSnapshot().dropped).toBe(1);
  });
});

describe('sign-out (ARCHITECTURE §5.1)', () => {
  it('wipes the outbox of the user', async () => {
    const server = new GlobalServer();
    const auth = createTestAuth();
    const environment = createStaticEnvironment({ online: false });
    const a = await device(server, { environment, extra: [auth.unit] });
    auth.signIn('u1');
    await a.kernel.settled();
    await a.port().send({ eventId: 'news', payload: 'private' });
    await expect.poll(() => a.global.views.state.getSnapshot().outbox).toBe(1);

    auth.signOut();
    await a.kernel.settled();
    await expect.poll(() => a.global.views.state.getSnapshot().outbox).toBe(0);
    environment.set({ online: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.received.filter((f) => f.type === 'publish')).toEqual([]);
  });
});
