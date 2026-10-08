/**
 * The M7 gate (docs/ARCHITECTURE.md §19.5): an offline-to-online scenario
 * completes all queued work with no duplicates, and the pending work that the
 * user sees matches the real state throughout.
 */
import 'fake-indexeddb/auto';

import { Kernel, type SubsystemDefinition } from '@webkrnl/core';
import {
  GLOBAL_STATE_ID,
  createGlobalState,
  createStaticEnvironment,
  type GlobalStateControl,
} from '@webkrnl/global-state';
import { createNetwork } from '@webkrnl/network';
import { createNotificationCenter } from '@webkrnl/notification';
import { createQueue } from '@webkrnl/queue';
import { createStorage } from '@webkrnl/storage';
import { afterEach, describe, expect, it } from 'vitest';

import { SYNC_ID, createSync, type SyncControl } from '../src';

import { fakeServer, pendingCount, restPush } from './server';

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const k of kernels.splice(0)) await k.stop();
});

interface Todo {
  readonly title: string;
}

describe('M7 gate: offline to online', () => {
  it('sends every queued change exactly once, and the pending work matches the outbox at every step', async () => {
    const server = fakeServer();
    const environment = createStaticEnvironment({ online: false });
    const notification = createNotificationCenter();
    const queue = createQueue({ fanOut: notification.fanOut });
    const kernel = new Kernel(
      [
        createGlobalState({ environment }),
        queue.subsystem,
        notification.subsystem,
        createStorage({
          domain: 'app',
          database: `gate-${Date.now()}`,
          hosts: ['virtual'],
          keys: null,
          quota: false,
        }),
        createNetwork({ fetch: server.fetch, retryBaseMs: 1, retries: 3 }),
        createSync({ intervalMs: false, retryBaseMs: 1 }),
      ] as SubsystemDefinition[],
      { router: queue.router },
    );
    kernels.push(kernel);
    await kernel.start();
    const globalState = kernel.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!;
    const sync = kernel.unit<SyncControl>(SYNC_ID).control!;

    // The invariant: what the user sees as pending is what really waits in the outbox.
    const mismatches: string[] = [];
    const check = (when: string) => {
      const shown = pendingCount(globalState.views.state.getSnapshot().pending);
      const real = sync.commands.outbox().filter((c) => c.state === 'waiting').length;
      if (shown !== real) mismatches.push(`${when}: shown ${shown}, outbox ${real}`);
    };
    const stopWatching = globalState.views.state.subscribe(() => check('global state changed'));
    const sampler = setInterval(() => check('sample'), 1);

    const todos = sync.commands.entity<Todo>({ name: 'todos', push: restPush<Todo>('todos') });
    const notes = sync.commands.entity<Todo>({ name: 'notes', push: restPush<Todo>('notes') });

    // 1. Offline: the user works. Nothing is sent.
    await todos.create('t1', { title: 'Tea' });
    check('after t1 create');
    await todos.update('t1', { title: 'Green tea' }); // merges into the create
    check('after t1 update');
    await todos.create('t2', { title: 'Cups' });
    await todos.update('t3', { title: 'Saucers' });
    await todos.remove('t4');
    await todos.create('t5', { title: 'Typo' });
    await todos.remove('t5'); // cancels the create: the server never sees t5
    await notes.update('n1', { title: 'Call the shop' });
    check('offline work done');

    expect(server.requests).toEqual([]);
    expect(sync.commands.outbox().map((c) => `${c.entity}/${c.entityId}:${c.op}`)).toEqual([
      'todos/t1:create',
      'todos/t2:create',
      'todos/t3:update',
      'todos/t4:delete',
      'notes/n1:update',
    ]);
    const syncWork = () =>
      globalState.views.state.getSnapshot().pending?.filter((w) => w.subsystemId === SYNC_ID);
    expect(syncWork()?.map((w) => w.label)).toEqual([
      '4 changes to todos waiting',
      '1 change to notes waiting',
    ]);
    expect(sync.views.state.getSnapshot()).toMatchObject({
      status: 'OFFLINE',
      pending: 5,
      persistent: true,
    });

    // 2. The server fails some requests: a 503, and a response dropped after the change was applied.
    server.faults.set('/todos/t2', [503]);
    server.faults.set('/todos/t3', ['drop']);
    server.faults.set('/notes/n1', ['drop', 503]);

    // 3. Online: Sync replays the outbox by itself.
    environment.set({ online: true });
    await expect.poll(() => sync.commands.outbox().length, { timeout: 5000 }).toBe(0);
    await expect.poll(() => syncWork()?.length).toBe(0);
    clearInterval(sampler);
    stopWatching();
    check('end');

    // Every change reached the server exactly once.
    const keys = [...server.applied.keys()];
    expect(keys).toHaveLength(5);
    expect(server.data).toEqual(
      new Map<string, unknown>([
        ['todos/t1', { title: 'Green tea' }],
        ['todos/t2', { title: 'Cups' }],
        ['todos/t3', { title: 'Saucers' }],
        ['notes/n1', { title: 'Call the shop' }],
      ]),
    );
    // Retries happened (the faults), and none of them applied a change twice.
    expect(server.requests.length).toBeGreaterThan(5);
    expect(server.requests.some((r) => r.includes('t5'))).toBe(false);
    expect(mismatches).toEqual([]);
    await expect.poll(() => sync.views.state.getSnapshot().status).toBe('IDLE');
    expect(sync.views.state.getSnapshot()).toMatchObject({ pending: 0, failed: 0 });
  });
});
