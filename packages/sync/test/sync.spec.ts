import 'fake-indexeddb/auto';

import { NO_CONTROL, type SubsystemDefinition } from '@platform/core';
import { createTestPlatform } from '@platform/core/testing';
import {
  createGlobalState,
  createStaticEnvironment,
  type StaticEnvironment,
} from '@platform/global-state';
import { createNetwork } from '@platform/network';
import { createStorage } from '@platform/storage';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SYNC_FAILED,
  SYNC_ID,
  createSync,
  isPermanent,
  mergeOps,
  type RemoteChange,
  type SyncControl,
  type SyncFailed,
} from '../src';

import { fakeServer, restPush, type FakeServer } from './server';

const platforms: ReturnType<typeof createTestPlatform>[] = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
});

interface Todo {
  readonly title: string;
}

async function tab(
  server: FakeServer,
  options: { environment?: StaticEnvironment; database?: string } = {},
) {
  const events: SyncFailed[] = [];
  const listener: SubsystemDefinition = {
    id: 'listener',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    subscribes: [SYNC_FAILED],
    receive: (packet) => void events.push(packet.take() as SyncFailed),
    control: () => NO_CONTROL,
  };
  const units: SubsystemDefinition[] = [
    createGlobalState({
      environment: options.environment ?? createStaticEnvironment(),
    }) as SubsystemDefinition,
    createNetwork({ fetch: server.fetch, retryBaseMs: 1, retries: 0 }) as SubsystemDefinition,
    createSync({ intervalMs: false, retryBaseMs: 1 }) as SubsystemDefinition,
    listener,
  ];
  if (options.database) {
    units.push(
      createStorage({
        domain: 'app',
        database: options.database,
        hosts: ['virtual'],
        keys: null,
        quota: false,
      }) as SubsystemDefinition,
    );
  }
  const platform = createTestPlatform(units);
  platforms.push(platform);
  await platform.start();
  await platform.settle();
  return { platform, sync: platform.unit<SyncControl>(SYNC_ID).control!, events };
}

describe('the outbox', () => {
  it('merges waiting changes of one entity', () => {
    expect(mergeOps('create', 'update')).toBe('create');
    expect(mergeOps('create', 'delete')).toBeNull();
    expect(mergeOps('update', 'update')).toBe('update');
    expect(mergeOps('update', 'delete')).toBe('delete');
    expect(mergeOps('delete', 'create')).toBe('update');
    expect(isPermanent({ status: 422 })).toBe(true);
    expect(isPermanent({ status: 429 })).toBe(false);
    expect(isPermanent(new TypeError('down'))).toBe(false);
  });

  it('sends a change at once when online', async () => {
    const server = fakeServer();
    const { sync } = await tab(server);
    const todos = sync.commands.entity<Todo>({ name: 'todos', push: restPush<Todo>('todos') });
    await todos.update('t1', { title: 'Tea' });
    await expect.poll(() => server.data.get('todos/t1')).toEqual({ title: 'Tea' });
    expect(sync.commands.outbox()).toEqual([]);
  });

  it('keeps the outbox in Storage, so offline work survives a reload', async () => {
    const server = fakeServer();
    const database = `sync-reload-${Date.now()}`;
    const offline = createStaticEnvironment({ online: false });
    const first = await tab(server, { environment: offline, database });
    await expect.poll(() => first.sync.views.state.getSnapshot().persistent).toBe(true);
    const todos = first.sync.commands.entity<Todo>({
      name: 'todos',
      push: restPush<Todo>('todos'),
    });
    await todos.create('t1', { title: 'Tea' });
    await todos.create('t2', { title: 'Cups' });
    await first.platform.stop();
    platforms.splice(0);

    const online = createStaticEnvironment({ online: false });
    const second = await tab(server, { environment: online, database });
    second.sync.commands.entity<Todo>({ name: 'todos', push: restPush<Todo>('todos') });
    await expect.poll(() => second.sync.views.state.getSnapshot().pending).toBe(2);
    online.set({ online: true });
    await expect.poll(() => server.data.size).toBe(2);
    expect([...server.applied.values()]).toEqual([1, 1]);
  });

  it('lets one tab replay a shared outbox: two tabs send each change once', async () => {
    const server = fakeServer();
    const database = `sync-tabs-${Date.now()}`;
    const envA = createStaticEnvironment({ online: false });
    const envB = createStaticEnvironment({ online: false });
    const a = await tab(server, { environment: envA, database });
    const b = await tab(server, { environment: envB, database });
    const todosA = a.sync.commands.entity<Todo>({ name: 'todos', push: restPush<Todo>('todos') });
    b.sync.commands.entity<Todo>({ name: 'todos', push: restPush<Todo>('todos') });
    for (let i = 0; i < 5; i++) await todosA.create(`t${i}`, { title: `Item ${i}` });
    await expect.poll(() => b.sync.views.state.getSnapshot().pending).toBe(5);

    envA.set({ online: true });
    envB.set({ online: true });
    await expect.poll(() => server.data.size).toBe(5);
    await expect
      .poll(() => a.sync.commands.outbox().length + b.sync.commands.outbox().length)
      .toBe(0);
    expect([...server.applied.values()].every((n) => n === 1)).toBe(true);
    expect(server.requests.filter((r) => r.startsWith('PUT'))).toHaveLength(5);
  });
});

describe('failures and conflicts', () => {
  it('moves a change to failed on a permanent error, broadcasts it, and retries on request', async () => {
    const server = fakeServer();
    const { sync, events, platform } = await tab(server);
    const todos = sync.commands.entity<Todo>({ name: 'todos', push: restPush<Todo>('todos') });
    server.faults.set('/todos/bad', [422]);
    await todos.update('bad', { title: 'x' });
    await expect.poll(() => sync.views.state.getSnapshot().failed).toBe(1);
    await platform.settle();
    expect(events).toMatchObject([{ entity: 'todos', entityId: 'bad', error: 'status 422' }]);
    expect(sync.views.state.getSnapshot()).toMatchObject({ status: 'ERROR', pending: 0 });

    expect(await sync.commands.retryFailed()).toBe(1);
    await expect.poll(() => server.data.get('todos/bad')).toEqual({ title: 'x' });
    await expect.poll(() => sync.views.state.getSnapshot().status).toBe('IDLE');
  });

  it('solves conflicts with each strategy', async () => {
    const server = fakeServer();
    const { sync } = await tab(server);
    const applied: RemoteChange<Todo>[] = [];
    const define = (name: string, conflict: 'server-wins' | 'client-wins' | 'merge' | 'manual') =>
      sync.commands.entity<Todo>({
        name,
        push: restPush<Todo>(name),
        apply: (change) => void applied.push(change),
        merge: (local, remote) => ({ title: `${local.title}+${remote.title}` }),
        conflict,
      });
    for (const name of ['sw', 'cw', 'mg', 'mn']) server.faults.set(`/${name}/x`, ['conflict']);

    await define('sw', 'server-wins').update('x', { title: 'local' });
    await define('cw', 'client-wins').update('x', { title: 'local' });
    await define('mg', 'merge').update('x', { title: 'local' });
    const manual = define('mn', 'manual');
    await manual.update('x', { title: 'local' });
    await expect.poll(() => sync.views.state.getSnapshot().conflicts).toBe(1);
    await expect.poll(() => sync.views.state.getSnapshot().pending).toBe(0);

    expect(applied).toEqual([
      { entityId: 'x', op: 'upsert', data: { remote: true, title: 'server' } },
    ]);
    expect(server.data.get('sw/x')).toBeUndefined();
    expect(server.data.get('cw/x')).toEqual({ title: 'local' });
    expect(server.data.get('mg/x')).toEqual({ title: 'local+server' });

    const [conflict] = manual.pending();
    expect(conflict).toMatchObject({ state: 'conflict', remote: { title: 'server' } });
    expect(await sync.commands.resolve(conflict!.id, 'local')).toBe(true);
    await expect.poll(() => server.data.get('mn/x')).toEqual({ title: 'local' });
  });

  it('pulls changes with a cursor, and a waiting local change wins over the server', async () => {
    const server = fakeServer();
    const env = createStaticEnvironment({ online: false });
    const { sync } = await tab(server, { environment: env });
    const local = new Map<string, Todo>();
    const todos = sync.commands.entity<Todo>({
      name: 'todos',
      push: restPush<Todo>('todos'),
      pull: async (cursor, { network }) =>
        (
          await network.commands.request<{ changes: RemoteChange<Todo>[]; cursor: string }>({
            url: 'https://api.test/todos/changes',
            query: { since: cursor ?? '' },
          })
        ).data,
      apply: (change) =>
        void (change.op === 'delete'
          ? local.delete(change.entityId)
          : local.set(change.entityId, change.data!)),
    });
    server.feed.push({ entityId: 'a', op: 'upsert', data: { title: 'From phone' } });
    server.feed.push({ entityId: 'b', op: 'upsert', data: { title: 'Server b' } });
    server.faults.set('/todos/b', [503]); // the push of b fails once, so b still waits during the pull
    await todos.update('b', { title: 'Local b' }); // a waiting change wins over the server's b

    env.set({ online: true });
    await expect.poll(() => local.get('a')).toEqual({ title: 'From phone' });
    expect(local.has('b')).toBe(false);
    await expect.poll(() => server.data.get('todos/b')).toEqual({ title: 'Local b' });
    server.feed.push({ entityId: 'a', op: 'delete' });
    const report = await sync.commands.syncNow();
    expect(report.pulled).toBe(1); // only the new change after the cursor
    expect(local.has('a')).toBe(false);
  });

  it('pauses and resumes', async () => {
    const server = fakeServer();
    const { sync } = await tab(server);
    const todos = sync.commands.entity<Todo>({ name: 'todos', push: restPush<Todo>('todos') });
    sync.commands.pause();
    await todos.update('t1', { title: 'Wait' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.requests).toEqual([]);
    expect(sync.views.state.getSnapshot().status).toBe('PAUSED');
    sync.commands.resume();
    await expect.poll(() => server.data.get('todos/t1')).toEqual({ title: 'Wait' });
  });
});
