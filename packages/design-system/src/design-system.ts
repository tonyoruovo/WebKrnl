/**
 * @fileoverview
 * @summary The Design System subsystem: tokens and the theme, written as CSS custom properties on the page.
 * @description
 * Implements `proposals/design-system_PROPOSAL.md` and docs/ARCHITECTURE.md
 * §21.4. It has no components and no framework dependency: components of any
 * framework read the custom properties.
 *
 * ```text
 *   Settings 'appearance.*' (or setAppearance without Settings) --+
 *   matchMedia prefers-color-scheme / -contrast / -reduced-motion --+--> resolveTheme --> theme
 *   Translation { direction, locale } -------------------------------+
 *     theme --> themeValues --> root.style --ds-*   (only what changed, once in a frame)
 *           --> root attributes data-color-scheme, data-contrast, data-density, data-reduced-motion, dir, lang
 *           --> localStorage 'platform:theme' (for the head script), 'design-system:theme-changed' (Page scope)
 *   ```
 *
 * @example
 * Reading the theme
 * ```ts
 * const ds = kernel.unit<DesignSystemControl>('design-system').control!;
 * ds.views.theme.getSnapshot().colorScheme; // 'dark'
 * ```
 *
 * @author MathAid
 */

import {
  defineSubsystem,
  deriveView,
  type ControlInterface,
  type SubsystemDefinition,
  type View,
} from '@platform/core';

import {
  APPEARANCE_KEYS,
  DEFAULT_APPEARANCE,
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  isAppearanceValue,
  resolveTheme,
  themeValues,
  type AppearancePreferences,
  type DevicePreferences,
  type ResolvedTheme,
} from './theme';
import { DEFAULT_TOKENS, checkTokens, cssVar, token, type TokenSet } from './tokens';

/**
 * @summary The id the Design System registers under.
 * @constant {'design-system'}
 * @public
 */
export const DESIGN_SYSTEM_ID = 'design-system';

/**
 * @summary The event broadcast (Page scope, LOW) after each change of the theme, with the {@linkcode ResolvedTheme}.
 * @constant {'design-system:theme-changed'}
 * @public
 */
export const THEME_CHANGED = 'design-system:theme-changed';

/**
 * @summary The element that gets the custom properties and the attributes.
 * @public
 */
export interface ThemeRoot {
  /**
   * @summary The inline style of the element.
   */
  readonly style: {
    /**
     * @summary Sets a property.
     * @param {string} name The property.
     * @param {string} value The value.
     * @returns {void}
     */
    setProperty(name: string, value: string): void;
  };
  /**
   * @summary Sets an attribute.
   * @param {string} name The attribute.
   * @param {string} value The value.
   * @returns {void}
   */
  setAttribute(name: string, value: string): void;
  /**
   * @summary Removes an attribute.
   * @param {string} name The attribute.
   * @returns {void}
   */
  removeAttribute(name: string): void;
}

/**
 * @summary A media query list: its result, and its changes.
 * @public
 */
export interface MediaQueryLike {
  /**
   * @summary Tells if the query matches now.
   */
  readonly matches: boolean;
  /**
   * @summary Adds a listener for changes.
   * @param {'change'} type The event.
   * @param {() => void} listener The listener.
   * @returns {void}
   */
  addEventListener(type: 'change', listener: () => void): void;
  /**
   * @summary Removes a listener.
   * @param {'change'} type The event.
   * @param {() => void} listener The listener.
   * @returns {void}
   */
  removeEventListener(type: 'change', listener: () => void): void;
}

/**
 * @summary Options for {@linkcode createDesignSystem}. All are optional.
 *
 * @example
 * Example 1: The tokens of a brand
 * ```ts
 * createDesignSystem({ tokens: brandTokens });
 * ```
 *
 * @example
 * Example 2: A theme for one part of the page
 * ```ts
 * createDesignSystem({ root: document.querySelector('#widget')! });
 * ```
 *
 * @public
 */
export interface DesignSystemOptions {
  /**
   * @summary The token set. The default is {@linkcode DEFAULT_TOKENS}.
   */
  readonly tokens?: TokenSet;
  /**
   * @summary The element that gets the theme. The default is `document.documentElement`; `null` writes nothing.
   */
  readonly root?: ThemeRoot | null;
  /**
   * @summary Evaluates a media query. The default is `matchMedia`.
   * @param {string} query The query.
   * @returns {MediaQueryLike | null} The query list, or `null` when there is none.
   */
  matchMedia?(query: string): MediaQueryLike | null;
  /**
   * @summary Where the preferences are kept for the head script. The default is `localStorage`; `null` keeps nothing.
   */
  readonly storage?: Pick<Storage, 'setItem'> | null;
  /**
   * @summary Runs a write later, once. The default is `requestAnimationFrame`, or a task.
   * @param {() => void} write The write.
   * @returns {void}
   */
  schedule?(write: () => void): void;
}

/**
 * @summary The state of the Design System.
 *
 * @example
 * Example 1: A dark theme, previewing a large font
 * ```ts
 * // { theme: { colorScheme: 'dark', fontScale: 1.25, ... }, preferences: { ... }, previewing: true }
 * ```
 *
 * @example
 * Example 2: A settings page
 * ```ts
 * picker.value = views.state.getSnapshot().preferences!.colorScheme;
 * ```
 *
 * @public
 */
export interface DesignSystemData {
  /**
   * @summary The theme that applies now.
   */
  theme: ResolvedTheme;
  /**
   * @summary The appearance preferences that the theme comes from (a preview included).
   */
  preferences: AppearancePreferences;
  /**
   * @summary Tells if a preview applies.
   */
  previewing: boolean;
}

/**
 * @summary The control interface of the Design System.
 *
 * @example
 * Example 1: An appearance menu
 * ```ts
 * const { commands } = kernel.unit<DesignSystemControl>('design-system').control!;
 * dark.onclick = () => commands.setAppearance({ colorScheme: 'dark' });
 * ```
 *
 * @example
 * Example 2: Following the theme
 * ```ts
 * views.theme.subscribe(() => chart.setDark(views.theme.getSnapshot().colorScheme === 'dark'));
 * ```
 *
 * @public
 */
export interface DesignSystemControl {
  /**
   * @summary The commands of the Design System.
   */
  readonly commands: {
    /**
     * @summary Returns the CSS reference of a token.
     * @example
     * An inline style
     * ```ts
     * el.style.color = commands.token('color.text'); // 'var(--ds-color-text)'
     * ```
     * @param {string} name The token.
     * @returns {string} The `var()` reference.
     * @throws {RangeError} For a token that is not in the set.
     */
    token(name: string): string;
    /**
     * @summary Returns the value of a token in the current theme.
     * @example
     * A canvas color
     * ```ts
     * context.fillStyle = commands.value('color.primary');
     * ```
     * @param {string} name The token.
     * @returns {string} The value.
     * @throws {RangeError} For a token that is not in the set.
     */
    value(name: string): string;
    /**
     * @summary Changes appearance preferences.
     * @description With Settings (and the appearance settings defined), the
     * change goes to Settings, so every tab of the site follows. Without it,
     * the change applies to this page only.
     * @example
     * The dark switch
     * ```ts
     * await commands.setAppearance({ colorScheme: 'dark' });
     * ```
     * @param {Partial<AppearancePreferences>} changes The new preferences.
     * @returns {Promise<boolean>} `true`, or `false` when Settings rolled the change back.
     * @throws {RangeError} For a value that is not allowed.
     */
    setAppearance(changes: Partial<AppearancePreferences>): Promise<boolean>;
    /**
     * @summary Applies preferences without saving them, for a settings page.
     * @description A new preview replaces the last one.
     * @example
     * Trying a font size
     * ```ts
     * const end = commands.preview({ fontScale: 1.25 });
     * cancel.onclick = end;
     * ```
     * @param {Partial<AppearancePreferences>} changes The preferences to try.
     * @returns {() => void} Ends the preview.
     * @throws {RangeError} For a value that is not allowed.
     */
    preview(changes: Partial<AppearancePreferences>): () => void;
  };
  /**
   * @summary The views of the Design System.
   */
  readonly views: {
    /**
     * @summary The state: the theme, the preferences, and the preview.
     */
    readonly state: View<Partial<DesignSystemData>>;
    /**
     * @summary The theme that applies now.
     */
    readonly theme: View<ResolvedTheme>;
  };
}

/** The parts of other subsystems that the Design System reads. */
interface SettingsLike extends ControlInterface {
  readonly commands: {
    keys(): readonly string[];
    get(key: string): unknown;
    update(changes: Readonly<Record<string, unknown>>): Promise<boolean>;
  };
  readonly views: { readonly values: View<Readonly<Record<string, unknown>>> };
}
interface TranslationLike extends ControlInterface {
  readonly views: {
    readonly state: View<{ readonly locale?: string; readonly direction?: 'ltr' | 'rtl' }>;
  };
}

/** Throws for a preference value that is not allowed. */
function check(changes: Partial<AppearancePreferences>): void {
  for (const [key, value] of Object.entries(changes)) {
    if (
      !(key in APPEARANCE_KEYS) ||
      !isAppearanceValue(key as keyof AppearancePreferences, value)
    ) {
      throw new RangeError(
        `"${String(value)}" is not allowed for the appearance preference "${key}".`,
      );
    }
  }
}

/**
 * @summary Creates the Design System subsystem.
 *
 * @description
 * Returns the subsystem definition (id {@linkcode DESIGN_SYSTEM_ID},
 * featurized, Page scope, no required dependency). Settings and Translation
 * are optional and late-bound. Register {@linkcode APPEARANCE_SETTINGS} in
 * Settings, so the preferences are kept and shared by every tab. Without a
 * DOM (in Node), it resolves the theme and writes nothing.
 *
 * @example
 * Example 1: Registering
 * ```ts
 * new Kernel([...centralized, createConsent(), createSettings({ definitions: APPEARANCE_SETTINGS }), createTranslation(), createDesignSystem()]);
 * ```
 *
 * @example
 * Example 2: Brand tokens
 * ```ts
 * createDesignSystem({ tokens: { ...DEFAULT_TOKENS, base: { ...DEFAULT_TOKENS.base, 'color.primary': '#7c3aed' } } });
 * ```
 *
 * @param {DesignSystemOptions} [options] The tokens, the root, and replacements of the browser APIs.
 * @returns {SubsystemDefinition<DesignSystemData, DesignSystemControl>} The subsystem.
 * @throws {RangeError} For a token set with a bad name.
 *
 * @public
 */
export function createDesignSystem(
  options: DesignSystemOptions = {},
): SubsystemDefinition<DesignSystemData, DesignSystemControl> {
  const tokens = options.tokens ?? DEFAULT_TOKENS;
  checkTokens(tokens);
  const root =
    options.root !== undefined
      ? options.root
      : typeof document !== 'undefined'
        ? (document.documentElement as unknown as ThemeRoot)
        : null;
  const matchMedia =
    options.matchMedia ??
    ((query: string) =>
      typeof globalThis.matchMedia === 'function'
        ? (globalThis.matchMedia(query) as unknown as MediaQueryLike)
        : null);
  const storage =
    options.storage !== undefined
      ? options.storage
      : (() => {
          try {
            return typeof localStorage === 'undefined' ? null : localStorage;
          } catch {
            return null; // Storage blocked by the browser.
          }
        })();
  const schedule =
    options.schedule ??
    ((write: () => void) =>
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(write)
        : setTimeout(write, 0));

  let api: {
    setAppearance(changes: Partial<AppearancePreferences>): Promise<boolean>;
    preview(changes: Partial<AppearancePreferences>): () => void;
  } | null = null;

  return defineSubsystem({
    id: DESIGN_SYSTEM_ID,
    scope: 'page',
    kind: 'featurized',
    requires: [
      { target: 'settings', kind: 'optional' },
      { target: 'translation', kind: 'optional' },
    ],
    state: {
      initial: {
        theme: DEFAULT_THEME,
        preferences: DEFAULT_APPEARANCE,
        previewing: false,
      } as DesignSystemData,
      policy: {
        theme: { readable: true },
        preferences: { readable: true },
        previewing: { readable: true },
      },
    },
    init(ctx) {
      const queries = {
        dark: matchMedia('(prefers-color-scheme: dark)'),
        moreContrast: matchMedia('(prefers-contrast: more)'),
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)'),
      };
      const device = (): DevicePreferences => ({
        dark: queries.dark?.matches ?? false,
        moreContrast: queries.moreContrast?.matches ?? false,
        reducedMotion: queries.reducedMotion?.matches ?? false,
      });

      let local: AppearancePreferences = DEFAULT_APPEARANCE; // without Settings
      let previewed: Partial<AppearancePreferences> | null = null;
      const written = new Map<string, string>();
      let pending = false;
      let stopped = false;

      const settings = () => {
        const found = ctx.dependency<SettingsLike>('settings');
        return found?.commands.keys().includes(APPEARANCE_KEYS.colorScheme) ? found : null;
      };
      const saved = (): AppearancePreferences => {
        const source = settings();
        if (!source) return local;
        const out = { ...DEFAULT_APPEARANCE } as Record<string, unknown>;
        for (const [key, settingKey] of Object.entries(APPEARANCE_KEYS))
          out[key] = source.commands.get(settingKey);
        return out as unknown as AppearancePreferences;
      };

      const write = () => {
        pending = false;
        if (stopped || !root) return;
        const { theme } = ctx.state.get();
        for (const [name, value] of Object.entries(themeValues(tokens, theme))) {
          if (written.get(name) === value) continue;
          root.style.setProperty(name, value);
          written.set(name, value);
        }
        root.style.setProperty('color-scheme', theme.colorScheme);
        root.setAttribute('data-color-scheme', theme.colorScheme);
        root.setAttribute('data-contrast', theme.contrast);
        root.setAttribute('data-density', theme.density);
        root.setAttribute('data-reduced-motion', String(theme.reducedMotion));
        root.setAttribute('dir', theme.direction);
        if (theme.lang) root.setAttribute('lang', theme.lang);
      };

      const update = () => {
        if (stopped) return;
        const keep = saved();
        const preferences = { ...keep, ...previewed };
        const translation = ctx
          .dependency<TranslationLike>('translation')
          ?.views.state.getSnapshot();
        const theme = resolveTheme(preferences, device(), {
          direction: translation?.direction,
          lang: translation?.locale,
        });
        const before = ctx.state.get();
        const changed = JSON.stringify(before.theme) !== JSON.stringify(theme);
        if (
          changed ||
          JSON.stringify(before.preferences) !== JSON.stringify(preferences) ||
          before.previewing !== (previewed !== null)
        ) {
          ctx.state.update((s) => {
            s.theme = theme;
            s.preferences = preferences;
            s.previewing = previewed !== null;
          });
        }
        try {
          storage?.setItem(THEME_STORAGE_KEY, JSON.stringify(keep));
        } catch {
          // A full or blocked storage: the head script uses the media queries.
        }
        if (changed) {
          ctx.port
            .send({ eventId: THEME_CHANGED, payload: theme, importance: 'LOW' })
            .catch((error: unknown) => ctx.report(error));
        }
        if (!pending) {
          pending = true;
          schedule(write);
        }
      };

      const media = Object.values(queries).filter((q): q is MediaQueryLike => q !== null);
      for (const query of media) query.addEventListener('change', update);

      let stopValues: (() => void) | undefined;
      const stopSettings = ctx.watch<SettingsLike>('settings', (next) => {
        stopValues?.();
        stopValues = next?.views?.values?.subscribe(update);
        update();
      });
      let stopLocale: (() => void) | undefined;
      const stopTranslation = ctx.watch<TranslationLike>('translation', (next) => {
        stopLocale?.();
        stopLocale = next?.views?.state?.subscribe(update);
        update();
      });

      api = {
        setAppearance(changes) {
          check(changes);
          const source = settings();
          if (source) {
            return source.commands.update(
              Object.fromEntries(
                Object.entries(changes).map(([key, value]) => [
                  APPEARANCE_KEYS[key as keyof AppearancePreferences],
                  value,
                ]),
              ),
            );
          }
          local = { ...local, ...changes };
          update();
          return Promise.resolve(true);
        },
        preview(changes) {
          check(changes);
          const mine = { ...changes };
          previewed = mine;
          update();
          return () => {
            if (previewed !== mine) return;
            previewed = null;
            update();
          };
        },
      };
      write(); // the first theme at once: a page that waits a frame flashes

      return () => {
        // The custom properties stay on the root: the page does not change when the subsystem stops.
        stopped = true;
        for (const query of media) query.removeEventListener('change', update);
        stopSettings();
        stopValues?.();
        stopTranslation();
        stopLocale?.();
        api = null;
      };
    },
    control: (ctx) => {
      const running = () => {
        if (!api) throw new Error('The Design System does not run.');
        return api;
      };
      const known = (name: string) => {
        if (!(name in tokens.base)) throw new RangeError(`Unknown token "${name}".`);
      };
      return {
        commands: {
          token: (name: string) => {
            known(name);
            return token(name);
          },
          value: (name: string) => {
            known(name);
            return themeValues(tokens, ctx.state.get().theme)[cssVar(name)]!;
          },
          setAppearance: (changes: Partial<AppearancePreferences>) =>
            running().setAppearance(changes),
          preview: (changes: Partial<AppearancePreferences>) => running().preview(changes),
        },
        views: {
          state: ctx.state.readable,
          theme: deriveView(
            ctx.state.view,
            (state) => state.theme,
            (a, b) => JSON.stringify(a) === JSON.stringify(b),
          ),
        },
      };
    },
  });
}
