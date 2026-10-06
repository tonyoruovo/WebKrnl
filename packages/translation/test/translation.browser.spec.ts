/**
 * Translation in real browsers: the processor `compile` parses catalogs in a
 * dedicated worker, and Intl gives the plural rules of the locale.
 */
import type { SubsystemDefinition } from '@webkrnl/core';
import { createTestPlatform } from '@webkrnl/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { TRANSLATION_ID, createTranslation, type TranslationControl } from '../src';

const platforms: ReturnType<typeof createTestPlatform>[] = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
});

describe('Translation in the browser', () => {
  it('compiles catalogs in a dedicated worker', async () => {
    const platform = createTestPlatform([
      createTranslation({
        supportedLocales: ['en', 'ru'],
        languages: () => ['ru'],
        catalogs: [
          {
            locale: 'ru',
            namespace: 'common',
            messages: {
              files: '{n, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}',
            },
          },
        ],
      }) as SubsystemDefinition,
    ]);
    platforms.push(platform);
    await platform.start();
    const i18n = platform.unit<TranslationControl>(TRANSLATION_ID).control!;
    await i18n.commands.ready();
    expect(i18n.views.state.getSnapshot().compiler).toBe('dedicated');
    expect([1, 3, 5, 21].map((n) => i18n.commands.t('files', { n }))).toEqual([
      '1 файл',
      '3 файла',
      '5 файлов',
      '21 файл',
    ]);
  });
});
