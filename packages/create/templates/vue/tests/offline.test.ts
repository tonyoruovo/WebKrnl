/**
 * The generated test: the app keeps a change while offline, and sends it
 * when the platform is online again.
 */
import { createStaticEnvironment } from '@webkrnl/global-state';
import { describe, expect, it, vi } from 'vitest';

import { createAppPlatform, notes } from '../src/platform';

describe('{{name}} offline', () => {
  it('keeps a change while offline, and sends it when online', async () => {
    const environment = createStaticEnvironment({ online: false });
    const server = new Map<string, unknown>();
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      if (!path.startsWith('/api/notes/')) return new Response(null, { status: 404 });
      server.set(path, await request.json());
      return Response.json({ ok: true });
    };
    const platform = createAppPlatform({
      globalState: { environment },
      network: { fetch, baseUrl: 'http://localhost/' },
      persistence: false,
      routes: null,
      onError: () => {},
    });
    await platform.start();
    const sync = platform.unit('sync')!;

    await notes(platform).create('n1', { text: 'Buy tea' });
    expect(sync.views.state.getSnapshot().pending).toBe(1);
    expect(server.size).toBe(0);

    environment.set({ online: true });
    await vi.waitFor(() => expect(server.get('/api/notes/n1')).toEqual({ text: 'Buy tea' }));
    await vi.waitFor(() => expect(sync.views.state.getSnapshot().pending).toBe(0));
    await platform.stop();
  });
});
