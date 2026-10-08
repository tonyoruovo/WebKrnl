import type { SubsystemDefinition } from '@webkrnl/core';
import { createTestAuth, createTestPlatform } from '@webkrnl/core/testing';
import { describe, expect, it } from 'vitest';

import {
  REALTIME_ID,
  createRealtime,
  type Frame,
  type RealtimeControl,
  type SocketLike,
} from '../src';

describe('Realtime sign-out (ARCHITECTURE §5.1)', () => {
  it('drops the buffered publishes and the presence of the user, and keeps the listeners', async () => {
    const sent: Frame[] = [];
    let accept = false;
    const sockets: SocketLike[] = [];
    const factory = (): SocketLike => {
      const socket: SocketLike = {
        readyState: 0,
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: (data) => void sent.push(JSON.parse(String(data)) as Frame),
        close() {
          (socket as { readyState: number }).readyState = 3;
        },
      };
      sockets.push(socket);
      setTimeout(() => {
        if (!accept) {
          (socket as { readyState: number }).readyState = 3;
          return socket.onclose?.({ code: 1006 });
        }
        (socket as { readyState: number }).readyState = 1;
        socket.onopen?.({});
      }, 1);
      return socket;
    };
    const auth = createTestAuth();
    const platform = createTestPlatform([
      auth.unit,
      createRealtime({
        url: 'ws://rt.test',
        hosts: ['virtual'],
        socket: factory,
        retryBaseMs: 2,
      }) as SubsystemDefinition,
    ]);
    await platform.start();
    const realtime = platform.unit<RealtimeControl>(REALTIME_ID).control!;
    auth.signIn('u1');
    await platform.settle();
    realtime.commands.subscribe('chat', () => {});
    await realtime.commands.publish('chat', { text: 'private, not sent yet' });

    auth.signOut();
    await platform.settle();
    await new Promise((resolve) => setTimeout(resolve, 10));
    accept = true;
    await expect.poll(() => realtime.views.state.getSnapshot().status).toBe('open');
    expect(sent.filter((f) => f.type === 'publish')).toEqual([]);
    expect(sent.filter((f) => f.type === 'subscribe').map((f) => f.topic)).toEqual(['chat']);
    expect(realtime.views.state.getSnapshot().presence).toEqual({});
    await platform.stop();
  });
});
