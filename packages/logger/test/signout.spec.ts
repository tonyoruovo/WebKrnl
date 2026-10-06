import type { SubsystemDefinition } from '@webkrnl/core';
import { createTestAuth, createTestPlatform } from '@webkrnl/core/testing';
import { describe, expect, it } from 'vitest';

import { LOGGER_ID, createLogger, type LogEntry, type LoggerControl, type StoredLog } from '../src';

describe('Logger sign-out (ARCHITECTURE §5.1)', () => {
  it('wipes the entries in memory and in Storage', async () => {
    const stored = new Map<string, LogEntry>();
    const collection: StoredLog = {
      set: async (key, value) => void stored.set(key, value),
      entries: async () => [...stored].map(([key, value]) => ({ key, value })),
      clear: async () => stored.clear(),
    };
    const storage: SubsystemDefinition = {
      id: 'storage',
      scope: 'tab',
      kind: 'featurized',
      state: { initial: {} },
      control: () => ({ commands: { collection: () => collection }, views: {} }),
    };
    const auth = createTestAuth();
    const platform = createTestPlatform([
      auth.unit,
      storage,
      createLogger() as SubsystemDefinition,
    ]);
    await platform.start();
    const logger = platform.unit<LoggerControl>(LOGGER_ID).control!;
    auth.signIn('u1');
    await platform.settle();
    logger.commands.log('INFO', 'Opened order 42', { context: { email: 'ada@example.com' } });
    await expect.poll(() => stored.size).toBe(1);

    auth.signOut();
    await platform.settle();
    await expect.poll(() => stored.size).toBe(0);
    expect(logger.views.entries.getSnapshot()).toEqual([]);
    expect(await logger.commands.history()).toEqual([]);
    await platform.stop();
  });
});
