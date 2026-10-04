/**
 * An in-memory server for the Global transport (docs/ARCHITECTURE.md §20.3).
 * It is a test double for this repository only, never published.
 *
 * Socket: subscribe / unsubscribe / publish / ping. A publish on a reserved
 * topic is forwarded to the other subscribers of the topic and acknowledged
 * to the sender. HTTP: POST <base>/publish and GET <base>/poll (long poll).
 * Faults: drop the next acks, deliver each envelope twice.
 */
import { decodeWire } from '@platform/core';

import type { Frame, SocketLike } from '../src';

interface Connection {
  readonly socket: FakeSocket;
  readonly topics: Set<string>;
}

export class GlobalServer {
  readonly connections: Connection[] = [];
  /** Every frame that a client sent. */
  readonly received: Frame[] = [];
  /** Envelopes for HTTP polls, with their position. */
  readonly log: Array<{ channel: string; envelope: unknown }> = [];
  /** Acks to drop before the next ones go out. */
  dropAcks = 0;
  /** Delivers each forwarded envelope twice. */
  duplicate = false;
  /** Accepts new sockets. */
  accept = true;
  private readonly polls = new Set<() => void>();

  readonly connect = (url: string): SocketLike => {
    const socket = new FakeSocket(this, url);
    const connection = { socket, topics: new Set<string>() };
    this.connections.push(connection);
    setTimeout(() => (this.accept ? socket.serverOpen() : socket.serverClose(1006)), 1);
    return socket;
  };

  get open(): Connection[] {
    return this.connections.filter((c) => c.socket.readyState === 1);
  }

  /** Closes every socket, as a network drop does. */
  drop(): void {
    for (const c of this.open) c.socket.serverClose(1006);
  }

  handle(from: FakeSocket, frame: Frame): void {
    this.received.push(frame);
    const connection = this.connections.find((c) => c.socket === from)!;
    if (frame.type === 'ping') return from.deliver({ type: 'pong' });
    if (frame.type === 'subscribe' && frame.topic) return void connection.topics.add(frame.topic);
    if (frame.type === 'unsubscribe' && frame.topic)
      return void connection.topics.delete(frame.topic);
    if (frame.type !== 'publish' || !frame.topic) return;
    if (frame.topic.startsWith('platform:')) {
      try {
        decodeWire(frame.data); // A server refuses an envelope that is not valid.
      } catch {
        return;
      }
      this.forward(frame.topic, frame.data, from);
      const id = (frame.data as { metadata: { messageId: string } }).metadata.messageId;
      if (this.dropAcks > 0) this.dropAcks--;
      else from.deliver({ type: 'ack', data: id });
      return;
    }
    this.forward(frame.topic, frame.data, null);
  }

  /** Sends an envelope to the subscribers of a topic, except the sender. */
  forward(topic: string, data: unknown, except: FakeSocket | null): void {
    if (topic.startsWith('platform:')) {
      this.log.push({ channel: topic, envelope: data });
      for (const wake of [...this.polls]) wake();
    }
    for (const c of this.open) {
      if (c.socket === except || !c.topics.has(topic)) continue;
      c.socket.deliver({ type: 'message', topic, data });
      if (this.duplicate) c.socket.deliver({ type: 'message', topic, data });
    }
  }

  /** The HTTP side: POST <base>/publish and GET <base>/poll. */
  readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/publish')) {
      const { channel, envelope } = (await request.json()) as {
        channel: string;
        envelope: unknown;
      };
      try {
        decodeWire(envelope);
      } catch {
        return new Response('invalid envelope', { status: 400 });
      }
      this.forward(channel, envelope, null);
      const id = (envelope as { metadata: { messageId: string } }).metadata.messageId;
      return Response.json({ ack: id });
    }
    if (url.pathname.endsWith('/poll')) {
      const channels = new Set((url.searchParams.get('channels') ?? '').split(','));
      const cursor = url.searchParams.get('cursor');
      const take = (from: number) => ({
        envelopes: this.log.slice(from).filter((e) => channels.has(e.channel)),
        cursor: String(this.log.length),
      });
      // The first poll only gets the current position.
      if (cursor === null) return Response.json({ envelopes: [], cursor: String(this.log.length) });
      if (Number(cursor) < this.log.length) return Response.json(take(Number(cursor)));
      await new Promise<void>((resolve) => {
        const wake = () => {
          this.polls.delete(wake);
          resolve();
        };
        this.polls.add(wake);
        init?.signal?.addEventListener('abort', wake, { once: true });
        setTimeout(wake, 200);
      });
      return Response.json(take(Number(cursor)));
    }
    return new Response('not found', { status: 404 });
  }) as typeof globalThis.fetch;
}

export class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;
  constructor(
    private readonly server: GlobalServer,
    readonly url: string,
  ) {}
  send(data: string | ArrayBuffer): void {
    const frame = JSON.parse(String(data)) as Frame;
    setTimeout(() => this.readyState === 1 && this.server.handle(this, frame), 1);
  }
  deliver(frame: Frame): void {
    setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: JSON.stringify(frame) }), 1);
  }
  close(code = 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    setTimeout(() => this.onclose?.({ code }), 1);
  }
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverClose(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}
