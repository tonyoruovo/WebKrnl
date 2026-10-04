/**
 * Realtime in real browsers: the socket processor runs in a dedicated worker
 * and talks to a real WebSocket server (scripts/test-ws-server.ts).
 */
import type { SubsystemDefinition } from '@platform/core';
import { createTestPlatform } from '@platform/core/testing';
import { afterEach, describe, expect, inject, it } from 'vitest';

import { REALTIME_ID, createRealtime, type RealtimeControl } from '../src';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The port of the WebSocket test server (scripts/test-ws-server.ts). */
    wsPort: number;
  }
}

const platforms: ReturnType<typeof createTestPlatform>[] = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
});

async function start() {
  const platform = createTestPlatform([
    createRealtime({
      url: `ws://127.0.0.1:${inject('wsPort')}/`,
      heartbeatMs: 200,
    }) as SubsystemDefinition,
  ]);
  platforms.push(platform);
  await platform.start();
  return platform.unit<RealtimeControl>(REALTIME_ID).control!;
}

describe('Realtime in the browser', () => {
  it('runs the socket in a dedicated worker, and two tabs exchange messages on a topic', async () => {
    const a = await start();
    const b = await start();
    await expect.poll(() => a.views.state.getSnapshot().status).toBe('open');
    await expect.poll(() => b.views.state.getSnapshot().status).toBe('open');
    expect(a.views.state.getSnapshot().host).toBe('dedicated');

    const got: unknown[] = [];
    b.commands.subscribe('room', (data) => got.push(data));
    // a and b use different sockets, so give b's subscribe time to reach the server first.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await a.commands.publish('room', { text: 'hello from a' });
    await expect.poll(() => got).toEqual([{ text: 'hello from a' }]);
    // Heartbeats go out and pongs come back: the socket stays open.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(a.views.state.getSnapshot()).toMatchObject({
      status: 'open',
      attempts: 0,
      lastError: null,
    });
  });
});
