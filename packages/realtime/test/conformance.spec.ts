import { describe, expect, it } from 'vitest';

import { runConformance } from '../src/conformance';

import { GlobalServer } from './global-server';

describe('the conformance runner', () => {
  it('passes the in-memory test server on every rule', async () => {
    const server = new GlobalServer();
    const results = await runConformance({
      url: 'wss://rt.test/socket',
      http: 'https://rt.test/global',
      socket: server.connect,
      fetch: server.fetch,
      timeoutMs: 500,
    });
    expect(results.map((r) => r.rule)).toEqual([
      'ping',
      'ack',
      'forward',
      'window',
      'refuse',
      'http-publish',
      'http-poll',
    ]);
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });

  it('finds a server that echoes to the sender and does not acknowledge', async () => {
    const server = new GlobalServer();
    server.dropAcks = 100;
    const forward = server.forward.bind(server);
    server.forward = (topic, data) => forward(topic, data, null); // echoes to the sender too
    const results = await runConformance({
      url: 'wss://rt.test/socket',
      socket: server.connect,
      timeoutMs: 300,
    });
    const failed = results.filter((r) => !r.passed).map((r) => r.rule);
    expect(failed).toEqual(['ack', 'forward']);
  });
});
