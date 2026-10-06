import { AUTH_ID, createAuth, type AuthControl } from '@webkrnl/auth';
import { NO_CONTROL, type SubsystemDefinition } from '@webkrnl/core';
import { createTestPlatform } from '@webkrnl/core/testing';
import { createGlobalState, createStaticEnvironment } from '@webkrnl/global-state';
import { afterEach, describe, expect, it } from 'vitest';

import {
  REALTIME_CONNECTION_CHANGED,
  REALTIME_ID,
  REALTIME_MESSAGE,
  createRealtime,
  type ConnectionChanged,
  type Frame,
  type RealtimeControl,
  type RealtimeMessage,
  type RealtimeOptions,
  type SocketLike,
} from '../src';

const platforms: ReturnType<typeof createTestPlatform>[] = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
});

/** A fake socket server in the same process. */
class FakeServer {
  readonly sockets: FakeSocket[] = [];
  readonly received: Array<{ url: string; frame: Frame }> = [];
  accept = true;
  pong = true;
  readonly connect = (url: string): SocketLike => {
    const socket = new FakeSocket(this, url);
    this.sockets.push(socket);
    setTimeout(() => (this.accept ? socket.serverOpen() : socket.serverClose(1006)), 1);
    return socket;
  };
  get open() {
    return this.sockets.filter((s) => s.readyState === 1);
  }
  frames(type: Frame['type']) {
    return this.received.filter((r) => r.frame.type === type).map((r) => r.frame);
  }
  push(frame: Frame) {
    for (const socket of this.open) socket.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop() {
    for (const socket of this.open) socket.serverClose(1006);
  }
}

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(
    private readonly server: FakeServer,
    readonly url: string,
  ) {}
  send(data: string | ArrayBuffer) {
    const frame = JSON.parse(String(data)) as Frame;
    this.server.received.push({ url: this.url, frame });
    if (frame.type === 'ping' && this.server.pong) {
      setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: '{"type":"pong"}' }), 1);
    }
  }
  close(code = 1000) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code }), 1);
  }
  serverOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverClose(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

async function start(
  server: FakeServer,
  options: Partial<RealtimeOptions> = {},
  extra: SubsystemDefinition[] = [],
) {
  const events: Array<{ eventId: string; payload: unknown }> = [];
  const listener: SubsystemDefinition = {
    id: 'listener',
    scope: 'tab',
    kind: 'featurized',
    state: { initial: {} },
    subscribes: [REALTIME_CONNECTION_CHANGED, REALTIME_MESSAGE],
    receive: (packet) =>
      void events.push({ eventId: packet.header.eventId, payload: packet.take() }),
    control: () => NO_CONTROL,
  };
  const platform = createTestPlatform([
    createRealtime({
      url: 'ws://rt.test/socket',
      hosts: ['virtual'],
      socket: server.connect,
      retryBaseMs: 1,
      ...options,
    }) as SubsystemDefinition,
    listener,
    ...extra,
  ]);
  platforms.push(platform);
  await platform.start();
  const realtime = platform.unit<RealtimeControl>(REALTIME_ID).control!;
  return { platform, realtime, events };
}

describe('Realtime', () => {
  it('connects, subscribes, delivers messages to listeners, and announces status changes', async () => {
    const server = new FakeServer();
    const { realtime, events, platform } = await start(server);
    await expect.poll(() => realtime.views.state.getSnapshot().status).toBe('open');
    expect(realtime.views.state.getSnapshot().host).toBe('virtual');

    const got: unknown[] = [];
    const stop = realtime.commands.subscribe('chat', (data) => got.push(data));
    await expect
      .poll(() => server.frames('subscribe'))
      .toEqual([{ type: 'subscribe', topic: 'chat' }]);
    server.push({ type: 'message', topic: 'chat', data: { text: 'hi' } });
    server.push({ type: 'message', topic: 'other', data: 'ignored' });
    await expect.poll(() => got).toEqual([{ text: 'hi' }]);
    expect(realtime.views.state.getSnapshot().topics).toEqual(['chat']);

    await realtime.commands.publish('chat', { text: 'yo' });
    expect(server.frames('publish')).toEqual([
      { type: 'publish', topic: 'chat', data: { text: 'yo' } },
    ]);
    stop();
    await expect
      .poll(() => server.frames('unsubscribe'))
      .toEqual([{ type: 'unsubscribe', topic: 'chat' }]);
    await platform.settle();
    const changes = events
      .filter((e) => e.eventId === REALTIME_CONNECTION_CHANGED)
      .map((e) => (e.payload as ConnectionChanged).to);
    expect(changes).toEqual(['connecting', 'open']);
  });

  it('reconnects after a drop and subscribes every topic again', async () => {
    const server = new FakeServer();
    const { realtime } = await start(server);
    realtime.commands.subscribe('a', () => {});
    realtime.commands.subscribe('b', () => {});
    await expect.poll(() => server.frames('subscribe').length).toBe(2);
    server.drop();
    await expect.poll(() => server.sockets.length).toBe(2);
    await expect.poll(() => realtime.views.state.getSnapshot().status).toBe('open');
    await expect
      .poll(() => server.frames('subscribe').map((f) => f.topic))
      .toEqual(['a', 'b', 'a', 'b']);
    expect(realtime.views.state.getSnapshot().attempts).toBe(0);
  });

  it('buffers publishes while disconnected, sends them after the open, and counts what overflows', async () => {
    const server = new FakeServer();
    server.accept = false;
    const { realtime } = await start(server, { publishBuffer: 2, maxAttempts: 50 });
    await realtime.commands.publish('t', 1);
    await realtime.commands.publish('t', 2);
    await realtime.commands.publish('t', 3);
    await expect.poll(() => realtime.views.state.getSnapshot().dropped).toBe(1);
    server.accept = true;
    await expect.poll(() => server.frames('publish').map((f) => f.data)).toEqual([2, 3]);
  });

  it('closes a socket that does not answer pings, and reconnects', async () => {
    const server = new FakeServer();
    const { realtime } = await start(server, { heartbeatMs: 10, heartbeatTimeoutMs: 20 });
    await expect.poll(() => realtime.views.state.getSnapshot().status).toBe('open');
    server.pong = false;
    await expect.poll(() => server.sockets.length, { timeout: 2000 }).toBeGreaterThan(1);
    server.pong = true;
    await expect.poll(() => realtime.views.state.getSnapshot().status).toBe('open');
  });

  it('closes when offline, does not retry, and reconnects at once when online', async () => {
    const server = new FakeServer();
    const environment = createStaticEnvironment();
    const { realtime, platform } = await start(server, {}, [
      createGlobalState({ environment }) as SubsystemDefinition,
    ]);
    await expect.poll(() => realtime.views.state.getSnapshot().status).toBe('open');
    environment.set({ online: false });
    await platform.settle();
    await expect.poll(() => realtime.views.state.getSnapshot().status).toBe('closed');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.sockets).toHaveLength(1);
    environment.set({ online: true });
    await expect.poll(() => realtime.views.state.getSnapshot().status).toBe('open');
    expect(server.sockets).toHaveLength(2);
  });

  it('gives up after maxAttempts', async () => {
    const server = new FakeServer();
    server.accept = false;
    const { realtime } = await start(server, { maxAttempts: 2 });
    await expect
      .poll(() => realtime.views.state.getSnapshot().lastError)
      .toBe('Gave up after 2 attempts.');
    expect(realtime.views.state.getSnapshot().status).toBe('closed');
    expect(server.sockets).toHaveLength(3);
  });

  it('sends the Auth token in the URL, and reconnects when it changes', async () => {
    const server = new FakeServer();
    let n = 0;
    const auth = createAuth<null>({
      persist: false,
      handlers: {
        login: async () => ({
          user: { id: 'u1', roles: [], permissions: [], level: 1 },
          accessToken: `tok-${++n}`,
          refreshToken: 'r',
          accessExpiresAt: null,
        }),
        refresh: async (s) => ({ ...s, accessToken: `tok-${++n}` }),
      },
    }) as SubsystemDefinition;
    const { realtime, platform } = await start(server, { auth: 'query', autoConnect: false }, [
      auth,
    ]);
    const authControl = platform.unit<AuthControl<null>>(AUTH_ID).control!;
    await authControl.commands.login(null);
    await realtime.commands.connect();
    await expect
      .poll(() => server.sockets.at(-1)?.url)
      .toBe('ws://rt.test/socket?access_token=tok-1');
    await authControl.commands.refresh();
    await expect
      .poll(() => server.sockets.at(-1)?.url)
      .toBe('ws://rt.test/socket?access_token=tok-2');
    await expect.poll(() => realtime.views.state.getSnapshot().status).toBe('open');
  });

  it('uses a custom protocol, tracks presence, and broadcasts messages of broadcast topics', async () => {
    const received: unknown[] = [];
    const sockets: FakeSocket[] = [];
    const custom = new FakeServer();
    const connect = (url: string) => {
      const socket = custom.connect(url) as FakeSocket;
      socket.send = (data) => void received.push(JSON.parse(String(data)));
      sockets.push(socket);
      return socket;
    };
    const { realtime, events, platform } = await start(custom, {
      socket: connect,
      protocol: {
        encode: (frame) => JSON.stringify({ op: frame.type, ch: frame.topic, d: frame.data }),
        decode: (raw) => {
          const m = JSON.parse(String(raw)) as { op: Frame['type']; ch?: string; d?: unknown };
          return { type: m.op, topic: m.ch, data: m.d };
        },
      },
      presenceTimeoutMs: 30,
    });
    realtime.commands.subscribe('news', () => {}, { broadcast: true });
    await expect.poll(() => received).toContainEqual({ op: 'subscribe', ch: 'news' });
    const socket = sockets.at(-1)!;
    socket.onmessage?.({ data: JSON.stringify({ op: 'message', ch: 'news', d: 'extra!' }) });
    socket.onmessage?.({
      data: JSON.stringify({ op: 'presence', d: { peer: 'u2', status: 'away' } }),
    });
    await platform.settle();
    expect(
      (events.find((e) => e.eventId === REALTIME_MESSAGE)?.payload as RealtimeMessage).data,
    ).toBe('extra!');
    expect(realtime.commands.presence('u2')?.status).toBe('away');
    await expect
      .poll(() => realtime.commands.presence('u2')?.status, { timeout: 2000 })
      .toBe('offline');
  });
});
