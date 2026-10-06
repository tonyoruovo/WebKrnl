import 'fake-indexeddb/auto';

import type { SubsystemDefinition } from '@webkrnl/core';
import { createTestAuth, createTestPlatform } from '@webkrnl/core/testing';
import { createGlobalState, createStaticEnvironment } from '@webkrnl/global-state';
import { createNetwork } from '@webkrnl/network';
import { STORAGE_ID, createStorage, type StorageControl } from '@webkrnl/storage';
import { describe, expect, it } from 'vitest';

import { SYNC_ID, createSync, type SyncControl } from '../src';

import { fakeServer, restPush } from './server';

describe('Sync sign-out (ARCHITECTURE §5.1)', () => {
  it('wipes the outbox in memory and in Storage, so the next user never sends the changes of the last one', async () => {
    const server = fakeServer();
    const auth = createTestAuth();
    const environment = createStaticEnvironment({ online: false });
    const platform = createTestPlatform([
      auth.unit,
      createGlobalState({ environment }) as SubsystemDefinition,
      createNetwork({ fetch: server.fetch, retryBaseMs: 1 }) as SubsystemDefinition,
      createStorage({
        domain: 'app',
        database: `sync-out-${Date.now()}`,
        hosts: ['virtual'],
        keys: null,
        quota: false,
      }) as SubsystemDefinition,
      createSync({ intervalMs: false, retryBaseMs: 1 }) as SubsystemDefinition,
    ]);
    await platform.start();
    await platform.settle();
    const sync = platform.unit<SyncControl>(SYNC_ID).control!;
    await expect.poll(() => sync.views.state.getSnapshot().persistent).toBe(true);
    auth.signIn('u1');
    await platform.settle();
    const todos = sync.commands.entity<{ title: string }>({
      name: 'todos',
      push: restPush('todos'),
    });
    await todos.update('t1', { title: 'Private' });
    await todos.update('t2', { title: 'Also private' });
    expect(sync.views.state.getSnapshot().pending).toBe(2);

    auth.signOut();
    await platform.settle();
    await expect.poll(() => sync.commands.outbox().length).toBe(0);
    expect(sync.views.state.getSnapshot().pending).toBe(0);
    const stored = platform
      .unit<StorageControl>(STORAGE_ID)
      .control!.commands.collection({ name: 'sync.outbox.default' });
    expect(await stored.count()).toBe(0);

    auth.signIn('u2');
    environment.set({ online: true });
    await platform.settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.requests).toEqual([]);
    await platform.stop();
  });
});
