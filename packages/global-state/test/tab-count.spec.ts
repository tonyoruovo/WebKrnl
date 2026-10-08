/**
 * The tab count (docs/ARCHITECTURE.md §21.5), with the Web Locks and the
 * BroadcastChannel of Node, which several counters in one process share.
 */
import { Kernel } from '@webkrnl/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GLOBAL_STATE_ID,
  createGlobalState,
  createStaticEnvironment,
  createTabCounter,
  type GlobalStateControl,
  type TabCounter,
  type TabPage,
} from '../src';

const counters: TabCounter[] = [];
const kernels: Kernel[] = [];
afterEach(async () => {
  for (const counter of counters.splice(0)) counter.close();
  for (const kernel of kernels.splice(0)) await kernel.stop();
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the last messages and releases settle
});

/** A page whose events the test fires. */
function fakePage() {
  const target = new EventTarget();
  const page: TabPage & { fire(type: 'pagehide' | 'pageshow'): void } = {
    addEventListener: (type, listener) => target.addEventListener(type, listener),
    removeEventListener: (type, listener) => target.removeEventListener(type, listener),
    fire: (type) => void target.dispatchEvent(new Event(type)),
  };
  return page;
}

let next = 0;
const counter = (options: Parameters<typeof createTabCounter>[1] = {}) => {
  const created = createTabCounter(`tab_${++next}_${Date.now()}`, { page: null, ...options });
  counters.push(created);
  return created;
};
const counts = (list: TabCounter[]) => list.map((c) => c.count.getSnapshot());

describe('with Web Locks', () => {
  it('counts the open tabs, and follows a tab that closes', async () => {
    const tabs = [counter(), counter(), counter()];
    await vi.waitFor(() => expect(counts(tabs)).toEqual([3, 3, 3]));
    tabs[2]!.close();
    await vi.waitFor(() => expect(counts(tabs.slice(0, 2))).toEqual([2, 2]));
  });

  it('does not count a hidden page (the back-forward cache), and counts it again when shown', async () => {
    const page = fakePage();
    const a = counter();
    const b = counter({ page });
    await vi.waitFor(() => expect(counts([a, b])).toEqual([2, 2]));
    page.fire('pagehide');
    await vi.waitFor(() => expect(a.count.getSnapshot()).toBe(1));
    page.fire('pageshow');
    await vi.waitFor(() => expect(counts([a, b])).toEqual([2, 2]));
  });

  it('finds a tab that went away without a message, at the next count', async () => {
    const a = counter({ intervalMs: 20 });
    const silent = counter({ channel: () => null }); // it can tell nobody
    await vi.waitFor(() => expect(a.count.getSnapshot()).toBe(2));
    silent.close(); // its lock goes, as when a tab crashes
    await vi.waitFor(() => expect(a.count.getSnapshot()).toBe(1));
  });
});

describe('without Web Locks', () => {
  it('counts with hello, here and bye on the channel', async () => {
    const page = fakePage();
    const a = counter({ locks: null });
    const b = counter({ locks: null, page });
    const c = counter({ locks: null });
    await vi.waitFor(() => expect(counts([a, b, c])).toEqual([3, 3, 3]));
    page.fire('pagehide');
    await vi.waitFor(() => expect(counts([a, c])).toEqual([2, 2]));
    c.close();
    await vi.waitFor(() => expect(a.count.getSnapshot()).toBe(1));
  });

  it('is 1 without a channel too', () => {
    expect(counter({ locks: null, channel: () => null }).count.getSnapshot()).toBe(1);
  });
});

describe('in Global State', () => {
  it('shows the number of tabs in its state', async () => {
    const boot = async () => {
      const kernel = new Kernel([
        createGlobalState({ environment: createStaticEnvironment(), tabCount: { page: null } }),
      ]);
      kernels.push(kernel);
      await kernel.start();
      return kernel.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!.views.state;
    };
    const a = await boot();
    const b = await boot();
    await vi.waitFor(() => expect([a.getSnapshot().tabs, b.getSnapshot().tabs]).toEqual([2, 2]));
    await kernels.pop()!.stop();
    await vi.waitFor(() => expect(a.getSnapshot().tabs).toBe(1));

    const off = new Kernel([
      createGlobalState({ environment: createStaticEnvironment(), tabCount: false }),
    ]);
    kernels.push(off);
    await off.start();
    expect(
      off.unit<GlobalStateControl>(GLOBAL_STATE_ID).control!.views.state.getSnapshot().tabs,
    ).toBe(1);
  });
});
