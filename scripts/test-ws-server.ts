/**
 * @fileoverview
 * @summary A small WebSocket server for the browser tests of Realtime (vitest `globalSetup`).
 * @description
 * It speaks the default JSON frames of `@webkrnl/realtime`, with the reserved
 * topics of the Global transport (docs/WIRE-PROTOCOL.md): it answers
 * `ping` with `pong`, remembers `subscribe` and `unsubscribe`, and sends each
 * `publish` as a `message` to every subscriber of the topic. It is not a
 * general server: text frames only, no fragmentation, no extensions.
 *
 * @example
 * In vitest.config.ts
 * ```ts
 * test: { globalSetup: ['./scripts/test-ws-server.ts'] }
 * ```
 *
 * @author MathAid
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

import type { TestProject } from 'vitest/node';

import { decodeWire } from '../packages/core/src/scope/wire';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The port of the WebSocket test server. */
    wsPort: number;
  }
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encode(text: string): Buffer {
  const payload = Buffer.from(text);
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : payload.length < 65_536
        ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x81;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(payload.length), 2);
            return h;
          })();
  return Buffer.concat([header, payload]);
}

/** Reads the complete client frames from a buffer; returns them and the rest. */
function decode(buffer: Buffer): { frames: Array<{ opcode: number; text: string }>; rest: Buffer } {
  const frames: Array<{ opcode: number; text: string }> = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const opcode = buffer[offset]! & 0x0f;
    let length = buffer[offset + 1]! & 0x7f;
    let at = offset + 2;
    if (length === 126) {
      if (buffer.length < at + 2) break;
      length = buffer.readUInt16BE(at);
      at += 2;
    } else if (length === 127) {
      if (buffer.length < at + 8) break;
      length = Number(buffer.readBigUInt64BE(at));
      at += 8;
    }
    if (buffer.length < at + 4 + length) break;
    const mask = buffer.subarray(at, at + 4);
    const data = Buffer.from(buffer.subarray(at + 4, at + 4 + length));
    for (let i = 0; i < data.length; i++) data[i]! ^= mask[i % 4]!;
    frames.push({ opcode, text: data.toString() });
    offset = at + 4 + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export default function setup(project: TestProject) {
  const topics = new Map<string, Set<Duplex>>();
  const server: Server = createServer((_request, response) => response.writeHead(426).end());
  server.on('upgrade', (request, socket) => {
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') return socket.destroy();
    const accept = createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending = Buffer.alloc(0);
    const send = (frame: unknown) => socket.write(encode(JSON.stringify(frame)));
    socket.on('data', (chunk: Buffer) => {
      const { frames, rest } = decode(Buffer.concat([pending, chunk]));
      pending = rest;
      for (const { opcode, text } of frames) {
        if (opcode === 8) return socket.end(Buffer.from([0x88, 0]));
        if (opcode !== 1) continue;
        const frame = JSON.parse(text) as { type: string; topic?: string; data?: unknown };
        if (frame.type === 'ping') send({ type: 'pong' });
        else if (frame.type === 'subscribe' && frame.topic) {
          let set = topics.get(frame.topic);
          if (!set) topics.set(frame.topic, (set = new Set()));
          set.add(socket);
        } else if (frame.type === 'unsubscribe' && frame.topic)
          topics.get(frame.topic)?.delete(socket);
        else if (frame.type === 'publish' && frame.topic) {
          // Reserved topics follow docs/WIRE-PROTOCOL.md: a valid envelope only, no echo to
          // the sender, and an ack. Other topics reach every subscriber.
          const reserved = frame.topic.startsWith('platform:');
          if (reserved) {
            try {
              decodeWire(frame.data);
            } catch {
              continue;
            }
          }
          for (const peer of topics.get(frame.topic) ?? []) {
            if (reserved && peer === socket) continue;
            peer.write(
              encode(JSON.stringify({ type: 'message', topic: frame.topic, data: frame.data })),
            );
          }
          if (reserved) {
            const id = (frame.data as { metadata: { messageId: string } }).metadata.messageId;
            send({ type: 'ack', data: id });
          }
        }
      }
    });
    socket.on('close', () => {
      for (const set of topics.values()) set.delete(socket);
    });
    socket.on('error', () => socket.destroy());
  });
  return new Promise<() => Promise<void>>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      project.provide('wsPort', typeof address === 'object' && address ? address.port : 0);
      resolve(() => new Promise((done) => server.close(() => done())));
    });
  });
}
