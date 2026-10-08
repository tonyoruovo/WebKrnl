/**
 * The Design System (docs/proposals/design-system_PROPOSAL.md, ARCHITECTURE §21.4):
 * tokens, the theme rules, the stylesheet export, and the subsystem with a
 * fake root, fake media queries, Settings and Translation.
 */
import { createConsent } from '@webkrnl/consent';
import { Kernel, type Scheduler, type SubsystemDefinition } from '@webkrnl/core';
import { createNotificationCenter } from '@webkrnl/notification';
import { createQueue } from '@webkrnl/queue';
import { SETTINGS_ID, createSettings, type SettingsControl } from '@webkrnl/settings';
import { createTranslation } from '@webkrnl/translation';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  APPEARANCE_SETTINGS,
  DEFAULT_APPEARANCE,
  DEFAULT_THEME,
  DEFAULT_TOKENS,
  DESIGN_SYSTEM_ID,
  THEME_CHANGED,
  THEME_STORAGE_KEY,
  checkTokens,
  contrastRatio,
  createDesignSystem,
  cssVar,
  renderThemeCss,
  renderThemeScript,
  resolveTheme,
  themeValues,
  token,
  type DesignSystemControl,
  type DesignSystemOptions,
  type MediaQueryLike,
  type ThemeRoot,
} from '../src';

const scheduler: Scheduler = {
  kind: 'timeout',
  postTask: (task) => Promise.resolve().then(task),
  yield: () => Promise.resolve(),
  idle: (task) => Promise.resolve().then(task),
};

const kernels: Kernel[] = [];
afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.stop();
});

/** A root element that records what it gets. */
function fakeRoot() {
  const properties = new Map<string, string>();
  const attributes = new Map<string, string>();
  const root: ThemeRoot & {
    properties: typeof properties;
    attributes: typeof attributes;
    writes: number;
  } = {
    properties,
    attributes,
    writes: 0,
    style: {
      setProperty: (name, value) => {
        root.writes++;
        properties.set(name, value);
      },
    },
    setAttribute: (name, value) => void attributes.set(name, value),
    removeAttribute: (name) => void attributes.delete(name),
  };
  return root;
}

/** Media queries that the test changes. */
function fakeMedia(initial: Record<string, boolean> = {}) {
  const lists = new Map<string, MediaQueryLike & { matches: boolean; fire(): void }>();
  const matchMedia = (query: string) => {
    let list = lists.get(query);
    if (!list) {
      const listeners = new Set<() => void>();
      list = {
        matches: initial[query] ?? false,
        addEventListener: (_type, listener) => void listeners.add(listener),
        removeEventListener: (_type, listener) => void listeners.delete(listener),
        fire: () => listeners.forEach((l) => l()),
      };
      lists.set(query, list);
    }
    return list;
  };
  const set = (query: string, matches: boolean) => {
    const list = matchMedia(query);
    list.matches = matches;
    list.fire();
  };
  return { matchMedia, set };
}

async function boot(options: DesignSystemOptions = {}, units: SubsystemDefinition[] = []) {
  const heard: unknown[] = [];
  const notification = createNotificationCenter();
  const queue = createQueue({ scheduler, fanOut: notification.fanOut });
  const root = fakeRoot();
  const media = fakeMedia();
  const stored = new Map<string, string>();
  const kernel = new Kernel(
    [
      queue.subsystem,
      notification.subsystem,
      ...units,
      createDesignSystem({
        root,
        matchMedia: media.matchMedia,
        storage: { setItem: (key, value) => void stored.set(key, value) },
        schedule: (write) => queueMicrotask(write),
        ...options,
      }),
      {
        id: 'listener',
        scope: 'page',
        kind: 'featurized',
        state: { initial: {} },
        subscribes: [THEME_CHANGED],
        receive: (packet) => void heard.push(packet.take()),
        control: () => ({ commands: {}, views: {} }),
      },
    ] as SubsystemDefinition[],
    { router: queue.router },
  );
  kernels.push(kernel);
  await kernel.start();
  return {
    kernel,
    root,
    media,
    stored,
    heard,
    ds: kernel.unit<DesignSystemControl>(DESIGN_SYSTEM_ID).control!,
  };
}

describe('tokens', () => {
  it('names custom properties and references', () => {
    expect(cssVar('color.surface')).toBe('--ds-color-surface');
    expect(token('space.4')).toBe('var(--ds-space-4)');
    expect(token('color.brand', '#7c3aed')).toBe('var(--ds-color-brand, #7c3aed)');
  });

  it('checks names and modes', () => {
    expect(() => checkTokens(DEFAULT_TOKENS)).not.toThrow();
    expect(() => checkTokens({ base: { Primary: 'red' } })).toThrow(RangeError);
    expect(() =>
      checkTokens({ base: { 'color.a': 'red' }, modes: { dark: { 'color.b': 'x' } } }),
    ).toThrow(RangeError);
    expect(() => createDesignSystem({ tokens: { base: { nodot: '1' } } })).toThrow(RangeError);
  });

  it('meets WCAG contrast: AA for text in every scheme, AAA with more contrast', () => {
    const m = DEFAULT_TOKENS.modes!;
    const sets = [
      [{ ...DEFAULT_TOKENS.base }, 4.5],
      [{ ...DEFAULT_TOKENS.base, ...m.dark }, 4.5],
      [{ ...DEFAULT_TOKENS.base, ...m.contrast }, 7],
      [{ ...DEFAULT_TOKENS.base, ...m.dark, ...m.darkContrast }, 7],
    ] as const;
    const pairs = [
      ['color.text', 'color.surface'],
      ['color.text', 'color.surface-raised'],
      ['color.text-muted', 'color.surface'],
      ['color.text-muted', 'color.surface-raised'],
      ['color.on-primary', 'color.primary'],
      ['color.on-danger', 'color.danger'],
      ['color.on-success', 'color.success'],
      ['color.primary', 'color.surface'],
    ];
    for (const [values, minimum] of sets) {
      for (const [text, surface] of pairs) {
        expect(
          contrastRatio(values[text!]!, values[surface!]!),
          `${text} on ${surface}`,
        ).toBeGreaterThanOrEqual(minimum);
      }
      expect(
        contrastRatio(values['color.border']!, values['color.surface']!),
      ).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio('#000', '#fff')).toBeCloseTo(21);
    expect(() => contrastRatio('red', '#fff')).toThrow(RangeError);
  });
});

describe('the theme rules', () => {
  const device = { dark: true, moreContrast: true, reducedMotion: true };

  it('resolves system values with the device, and explicit ones without it', () => {
    expect(resolveTheme(DEFAULT_APPEARANCE, device, { direction: 'rtl', lang: 'ar' })).toEqual({
      colorScheme: 'dark',
      contrast: 'more',
      density: 'comfortable',
      fontScale: 1,
      reducedMotion: true,
      direction: 'rtl',
      lang: 'ar',
    });
    expect(
      resolveTheme(
        {
          ...DEFAULT_APPEARANCE,
          colorScheme: 'light',
          contrast: 'normal',
          reducedMotion: 'no-preference',
        },
        device,
      ),
    ).toMatchObject({
      colorScheme: 'light',
      contrast: 'normal',
      reducedMotion: false,
      direction: 'ltr',
    });
  });

  it('picks the modes, scales the font sizes, and stops motion', () => {
    const values = themeValues(DEFAULT_TOKENS, {
      ...DEFAULT_THEME,
      colorScheme: 'dark',
      contrast: 'more',
      density: 'compact',
      fontScale: 1.25,
      reducedMotion: true,
    });
    expect(values['--ds-color-surface']).toBe('#000000'); // darkContrast
    expect(values['--ds-color-on-primary']).toBe('#0b1d3a'); // dark
    expect(values['--ds-space-4']).toBe('0.75rem'); // compact
    expect(values['--ds-font-size-md']).toBe('1.25rem');
    expect(values['--ds-line-height-normal']).toBe('1.5'); // ratios do not scale
    expect(values['--ds-motion-duration-normal']).toBe('0ms');
    expect(themeValues(DEFAULT_TOKENS, DEFAULT_THEME)['--ds-color-text']).toBe('#1b1d21');
  });

  it('defines the appearance preferences for Settings, as device settings', () => {
    expect(APPEARANCE_SETTINGS['appearance.colorScheme']).toMatchObject({
      default: 'system',
      kind: 'device',
    });
    expect(APPEARANCE_SETTINGS['appearance.fontScale']!.validate!(2)).toBe(false);
  });
});

describe('the stylesheet and the head script', () => {
  it('has the base values, each mode, and the media queries', () => {
    const css = renderThemeCss(DEFAULT_TOKENS);
    expect(css).toContain(':root{color-scheme:light dark;--ds-color-surface:#ffffff;');
    expect(css).toContain(
      '@media (prefers-color-scheme:dark){:root:not([data-color-scheme="light"]){--ds-color-surface:#121316;',
    );
    expect(css).toContain(':root[data-density="compact"]{--ds-space-1:0.125rem;');
    expect(css).toContain(':root[data-reduced-motion="true"]{--ds-motion-duration-fast:0ms;');
    expect(css).not.toContain('{}');
  });

  it('applies stored explicit preferences before the first paint', () => {
    const script = renderThemeScript(DEFAULT_TOKENS, { nonce: 'abc' });
    expect(script.startsWith('<script nonce="abc">')).toBe(true);
    const attributes = new Map<string, string>();
    const properties = new Map<string, string>();
    const body = script.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, '');
    const stored = JSON.stringify({ ...DEFAULT_APPEARANCE, colorScheme: 'dark', fontScale: 1.5 });
    new Function('localStorage', 'document', body)(
      { getItem: (key: string) => (key === THEME_STORAGE_KEY ? stored : null) },
      {
        documentElement: {
          setAttribute: (n: string, v: string) => attributes.set(n, v),
          style: { setProperty: (n: string, v: string) => properties.set(n, v) },
        },
      },
    );
    expect(attributes.get('data-color-scheme')).toBe('dark');
    expect(attributes.has('data-contrast')).toBe(false); // 'system' stays with the media query
    expect(properties.get('--ds-font-size-md')).toBe('1.5rem');
  });
});

describe('the subsystem', () => {
  it('writes the theme to the root at start, and only what changes after', async () => {
    const { root, ds } = await boot();
    expect(root.properties.get('--ds-color-surface')).toBe('#ffffff');
    expect(Object.fromEntries(root.attributes)).toEqual({
      'data-color-scheme': 'light',
      'data-contrast': 'normal',
      'data-density': 'comfortable',
      'data-reduced-motion': 'false',
      dir: 'ltr',
    });
    const before = root.writes;
    await ds.commands.setAppearance({ density: 'compact' });
    await vi.waitFor(() => expect(root.attributes.get('data-density')).toBe('compact'));
    expect(root.properties.get('--ds-space-4')).toBe('0.75rem');
    expect(root.writes - before).toBeLessThan(12); // the space tokens and color-scheme, not all tokens
  });

  it('follows the media queries of the device', async () => {
    const { root, media, ds, heard, kernel } = await boot();
    media.set('(prefers-color-scheme: dark)', true);
    await vi.waitFor(() => expect(root.attributes.get('data-color-scheme')).toBe('dark'));
    expect(ds.commands.value('color.surface')).toBe('#121316');
    await kernel.settled();
    await vi.waitFor(() =>
      expect(heard).toContainEqual(expect.objectContaining({ colorScheme: 'dark' })),
    );
    media.set('(prefers-reduced-motion: reduce)', true);
    await vi.waitFor(() => expect(root.properties.get('--ds-motion-duration-fast')).toBe('0ms'));
  });

  it('previews preferences without keeping them', async () => {
    const { root, ds, stored } = await boot();
    const end = ds.commands.preview({ fontScale: 1.5 });
    await vi.waitFor(() => expect(root.properties.get('--ds-font-size-md')).toBe('1.5rem'));
    expect(ds.views.state.getSnapshot().previewing).toBe(true);
    expect(JSON.parse(stored.get(THEME_STORAGE_KEY)!).fontScale).toBe(1);
    end();
    await vi.waitFor(() => expect(root.properties.get('--ds-font-size-md')).toBe('1rem'));
    expect(() => ds.commands.preview({ fontScale: 9 })).toThrow(RangeError);
  });

  it('keeps the preferences in Settings, and follows Settings and Translation', async () => {
    const units = [
      createConsent(),
      createSettings({ definitions: APPEARANCE_SETTINGS }),
      createTranslation({
        hosts: ['virtual'],
        supportedLocales: ['en', 'he'],
        languages: () => ['en'],
      }),
    ] as SubsystemDefinition[];
    const { kernel, root, ds, stored } = await boot({}, units);
    const settings = kernel.unit<SettingsControl>(SETTINGS_ID).control!;

    await ds.commands.setAppearance({ colorScheme: 'dark' });
    expect(settings.commands.get('appearance.colorScheme')).toBe('dark');
    await vi.waitFor(() => expect(root.attributes.get('data-color-scheme')).toBe('dark'));
    expect(JSON.parse(stored.get(THEME_STORAGE_KEY)!).colorScheme).toBe('dark');

    await settings.commands.set('appearance.contrast', 'more');
    await vi.waitFor(() => expect(root.properties.get('--ds-color-surface')).toBe('#000000'));

    await settings.commands.set('locale', 'he');
    await vi.waitFor(() => expect(root.attributes.get('dir')).toBe('rtl'));
    expect(root.attributes.get('lang')).toBe('he');
    expect(ds.views.theme.getSnapshot()).toMatchObject({ direction: 'rtl', lang: 'he' });
  });

  it('refuses unknown tokens and values', async () => {
    const { ds } = await boot();
    expect(ds.commands.token('color.text')).toBe('var(--ds-color-text)');
    expect(() => ds.commands.token('color.nope')).toThrow(RangeError);
    await expect(async () =>
      ds.commands.setAppearance({ colorScheme: 'blue' as never }),
    ).rejects.toThrow(RangeError);
  });

  it('resolves the theme and writes nothing without a root', async () => {
    const { ds } = await boot({ root: null });
    expect(ds.views.theme.getSnapshot().colorScheme).toBe('light');
  });
});
