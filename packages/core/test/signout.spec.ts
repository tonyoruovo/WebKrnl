import { describe, expect, it } from 'vitest';

import { LateBinding, NO_CONTROL, defineSubsystem, watchSignOut, type SignOutReason } from '../src';
import { createTestPlatform } from '../src/testing';

interface FakeAuthData {
  status: string;
  user: { id: string } | null;
}

/** A fake Auth unit whose state the test sets. */
function fakeAuth() {
  let set: ((next: FakeAuthData) => void) | null = null;
  const unit = defineSubsystem({
    id: 'auth',
    scope: 'tab',
    kind: 'featurized',
    state: {
      initial: { status: 'UNAUTHENTICATED', user: null } as FakeAuthData,
      policy: { status: { readable: true }, user: { readable: true } },
    },
    init(ctx) {
      set = (next) => ctx.state.update((s) => Object.assign(s, next));
    },
    control: (ctx) => ({ commands: {}, views: { state: ctx.state.readable } }),
  });
  return { unit, set: (next: FakeAuthData) => set!(next) };
}

describe('watchSignOut', () => {
  it('fires on sign-out and on a change of user, but not on sign-in, refresh or restore', async () => {
    const auth = fakeAuth();
    const reasons: SignOutReason[] = [];
    const consumer = defineSubsystem({
      id: 'cache',
      scope: 'tab',
      kind: 'featurized',
      requires: [{ target: 'auth', kind: 'optional' }],
      state: { initial: {} },
      init: (ctx) => watchSignOut(ctx, (reason) => void reasons.push(reason)),
      control: () => NO_CONTROL,
    });
    const platform = createTestPlatform([auth.unit, consumer]);
    await platform.start();
    // Views notify in batches: each step waits, as real sign-ins and sign-outs do.
    const step = async (next: FakeAuthData) => {
      auth.set(next);
      await platform.settle();
    };

    await step({ status: 'AUTHENTICATED', user: { id: 'u1' } }); // a sign-in or a restore
    await step({ status: 'AUTHENTICATED', user: { id: 'u1' } }); // a refresh
    expect(reasons).toEqual([]);
    await step({ status: 'EXPIRED', user: { id: 'u1' } });
    await step({ status: 'AUTHENTICATED', user: { id: 'u2' } }); // another user after an expiry
    await step({ status: 'UNAUTHENTICATED', user: null });
    await step({ status: 'UNAUTHENTICATED', user: null }); // nobody was signed in
    expect(reasons).toEqual(['user-changed', 'sign-out']);

    await step({ status: 'AUTHENTICATED', user: { id: 'u3' } });
    await platform.stop(); // Auth stopping is not a sign-out
    expect(reasons).toEqual(['user-changed', 'sign-out']);
  });

  it('needs Auth as a declared dependency, and reports a failing wipe', async () => {
    const auth = fakeAuth();
    const undeclared = defineSubsystem({
      id: 'bad',
      scope: 'tab',
      kind: 'featurized',
      state: { initial: {} },
      init: (ctx) => watchSignOut(ctx, () => {}),
      control: () => NO_CONTROL,
    });
    const failing = defineSubsystem({
      id: 'failing',
      scope: 'tab',
      kind: 'featurized',
      requires: [{ target: 'auth', kind: 'optional' }],
      state: { initial: {} },
      init: (ctx) => watchSignOut(ctx, () => Promise.reject(new Error('wipe failed'))),
      control: () => NO_CONTROL,
    });
    const platform = createTestPlatform([auth.unit, undeclared, failing]);
    await platform.start();
    expect(platform.status('bad')).toBe('FAILED');
    auth.set({ status: 'AUTHENTICATED', user: { id: 'u1' } });
    await platform.settle();
    auth.set({ status: 'UNAUTHENTICATED', user: null });
    await platform.settle();
    expect(platform.errors.some(({ error }) => String(error).includes('wipe failed'))).toBe(true);
    await platform.stop();
  });

  it('lets a late binding drop its buffer', () => {
    const binding = new LateBinding<string>({ capacity: 10 });
    void binding.write('a');
    void binding.write('b');
    expect(binding.clear()).toBe(2);
    expect(binding.buffered).toBe(0);
  });
});
