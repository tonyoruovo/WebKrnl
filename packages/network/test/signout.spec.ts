import 'fake-indexeddb/auto';

import type { SubsystemDefinition } from '@platform/core';
import { createTestAuth, createTestPlatform } from '@platform/core/testing';
import { createStorage } from '@platform/storage';
import { describe, expect, it } from 'vitest';

import {
  NETWORK_ID,
  OfflineError,
  RequestAbortedError,
  createNetwork,
  type NetworkControl,
} from '../src';

describe('Network sign-out (ARCHITECTURE §5.1)', () => {
  it('wipes cached responses in memory and in Storage, and aborts the requests of the user', async () => {
    const database = `net-signout-${Date.now()}`;
    let hold = false;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (hold) {
        return new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), {
            once: true,
          }),
        );
      }
      return Response.json({ url: String(input) });
    }) as typeof globalThis.fetch;
    const auth = createTestAuth();
    const platform = createTestPlatform([
      auth.unit,
      createNetwork({
        fetch,
        baseUrl: 'https://api.test/',
        persistCache: { encrypt: false },
      }) as SubsystemDefinition,
      createStorage({
        domain: 'shop',
        database,
        hosts: ['virtual'],
        keys: null,
        quota: false,
      }) as SubsystemDefinition,
    ]);
    await platform.start();
    await platform.settle();
    const network = platform.unit<NetworkControl>(NETWORK_ID).control!;
    auth.signIn('u1');
    await platform.settle();

    await network.commands.get('/me', { cache: 'cache-first' });
    hold = true;
    const pending = network.commands.get('/orders');
    await new Promise((resolve) => setTimeout(resolve, 5));

    auth.signOut();
    await platform.settle();
    await expect(pending).rejects.toBeInstanceOf(RequestAbortedError);
    await expect
      .poll(async () =>
        network.commands.get('/me', { cache: 'cache-only' }).then(
          () => 'cached',
          (e: unknown) => e instanceof OfflineError,
        ),
      )
      .toBe(true);
    await platform.stop();
  });
});
