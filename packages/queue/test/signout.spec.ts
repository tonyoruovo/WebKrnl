import {
  Kernel,
  NO_CONTROL,
  type PacketPort,
  type Scheduler,
  type SubsystemDefinition,
} from '@webkrnl/core';
import { createTestAuth } from '@webkrnl/core/testing';
import { describe, expect, it } from 'vitest';

import { QUEUE_ID, createQueue, type QueueControl, type StoredCollection } from '../src';

const scheduler: Scheduler = {
  kind: 'timeout',
  postTask: (task) => Promise.resolve().then(task),
  yield: () => Promise.resolve(),
  idle: (task) => Promise.resolve().then(task),
};

describe('Queue sign-out (ARCHITECTURE §5.1)', () => {
  it('wipes the dead letters in memory and in Storage', async () => {
    const stored = new Map<string, unknown>();
    const collection: StoredCollection<unknown> = {
      set: async (key, value) => void stored.set(key, value),
      delete: async (key) => void stored.delete(key),
      entries: async () => [...stored].map(([key, value]) => ({ key, value })),
      clear: async () => stored.clear(),
    };
    const storage: SubsystemDefinition = {
      id: 'storage',
      scope: 'tab',
      kind: 'featurized',
      state: { initial: {} },
      control: () => ({ commands: { collection: () => collection }, views: {} }),
    };
    let port: PacketPort | undefined;
    const app: SubsystemDefinition = {
      id: 'app',
      scope: 'tab',
      kind: 'featurized',
      state: { initial: {} },
      init: (ctx) => void (port = ctx.port),
      control: () => NO_CONTROL,
    };
    const billing: SubsystemDefinition = {
      id: 'billing',
      scope: 'tab',
      kind: 'featurized',
      state: { initial: {} },
      receive: () => 'ok',
      control: () => NO_CONTROL,
    };
    const auth = createTestAuth();
    const queue = createQueue({ scheduler, maxRetries: 0 });
    const kernel = new Kernel(
      [queue.subsystem, auth.unit, storage, app, billing] as SubsystemDefinition[],
      { router: queue.router },
    );
    await kernel.start();
    const control = kernel.unit<QueueControl>(QUEUE_ID).control!;
    auth.signIn('u1');
    await kernel.settled();

    await kernel.unit('billing').suspend();
    await port!
      .send({ eventId: 'pay', payload: { card: 'ending 4242' }, target: 'billing' })
      .catch(() => undefined);
    await expect.poll(() => stored.size).toBe(1);
    expect(control.views.deadLetters.getSnapshot()).toHaveLength(1);

    auth.signOut();
    await kernel.settled();
    await expect.poll(() => stored.size).toBe(0);
    expect(control.views.deadLetters.getSnapshot()).toEqual([]);
    expect(control.views.state.getSnapshot().deadLetters).toBe(0);
    await kernel.stop();
  });
});
