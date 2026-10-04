/**
 * The M8 gate (docs/ARCHITECTURE.md §20.5): a Global broadcast survives an
 * offline period and a reload, and each receiver gets it exactly once, while
 * the server drops an ack and delivers twice.
 */
import 'fake-indexeddb/auto';

import { Kernel, NO_CONTROL, type PacketPort, type SubsystemDefinition } from '@platform/core';
import {
  createGlobalState,
  createStaticEnvironment,
  type StaticEnvironment,
} from '@platform/global-state';
import { createNotificationCenter } from '@platform/notification';
import { createQueue } from '@platform/queue';
import { createStorage } from '@platform/storage';
import { afterEach, describe, expect, it } from 'vitest';

import { REALTIME_ID, createRealtime, type GlobalControl } from '../src';

import { GlobalServer } from './global-server';

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop();
});

/** One device: the centralized subsystems, Storage, Realtime with Global, a sender and a receiver. */
async function device(server: GlobalServer, database: string, environment: StaticEnvironment) {
  let port: PacketPort | undefined;
  const received: unknown[] = [];
  const notes: SubsystemDefinition = {
    id: 'notes',
    scope: 'global',
    kind: 'featurized',
    state: { initial: {} },
    init: (ctx) => void (port = ctx.port),
    control: () => NO_CONTROL,
  };
  const inbox: SubsystemDefinition = {
    id: 'inbox',
    scope: 'global',
    kind: 'featurized',
    state: { initial: {} },
    subscribes: ['note:saved'],
    receive: (packet) => void received.push(packet.take()),
    control: () => NO_CONTROL,
  };
  const notification = createNotificationCenter();
  const queue = createQueue({ fanOut: notification.fanOut });
  const kernel = new Kernel(
    [
      createGlobalState({ environment }),
      queue.subsystem,
      notification.subsystem,
      createStorage({ domain: 'app', database, hosts: ['virtual'], keys: null, quota: false }),
      createRealtime({
        url: 'wss://rt.test/socket',
        hosts: ['virtual'],
        socket: server.connect,
        retryBaseMs: 5,
        global: { ackTimeoutMs: 60 },
      }),
      notes,
      inbox,
    ] as SubsystemDefinition[],
    { router: queue.router },
  );
  kernels.push(kernel);
  await kernel.start();
  const global = kernel.unit<GlobalControl>(`${REALTIME_ID}/global`).control!;
  return { kernel, port: () => port!, received, global };
}

describe('M8 gate: a Global broadcast through an offline period', () => {
  it(
    'survives offline and a reload, and reaches each receiver exactly once',
    { timeout: 30_000 },
    async () => {
      const server = new GlobalServer();
      const stamp = Date.now();
      const offline = createStaticEnvironment({ online: false });
      let a = await device(server, `gate-a-${stamp}`, offline);
      const b = await device(server, `gate-b-${stamp}`, createStaticEnvironment());
      const c = await device(server, `gate-c-${stamp}`, createStaticEnvironment());
      await expect.poll(() => server.open.length).toBe(2); // b and c

      // 1. Offline: the broadcast waits in the outbox, and a reload keeps it.
      await a.port().send({ eventId: 'note:saved', payload: { id: 'n1', title: 'Offline note' } });
      await expect.poll(() => a.global.views.state.getSnapshot().outbox).toBe(1);
      await a.kernel.stop();
      kernels.splice(kernels.indexOf(a.kernel), 1);
      const online = createStaticEnvironment({ online: false });
      a = await device(server, `gate-a-${stamp}`, online);
      await expect.poll(() => a.global.views.state.getSnapshot().outbox, { timeout: 5000 }).toBe(1);
      expect(b.received).toEqual([]);

      // 2. Online: the server drops the first ack (a sends again) and delivers twice.
      server.dropAcks = 1;
      server.duplicate = true;
      online.set({ online: true });
      await expect.poll(() => a.global.views.state.getSnapshot().outbox, { timeout: 5000 }).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 3. Exactly once for each receiver.
      const sends = server.received.filter(
        (f) => f.type === 'publish' && f.topic === 'platform:global',
      );
      expect(sends.length).toBeGreaterThanOrEqual(2); // sent again after the dropped ack
      expect(b.received).toEqual([{ id: 'n1', title: 'Offline note' }]);
      expect(c.received).toEqual([{ id: 'n1', title: 'Offline note' }]);
      expect(a.global.views.state.getSnapshot()).toMatchObject({ transport: 'socket', outbox: 0 });
    },
  );
});
