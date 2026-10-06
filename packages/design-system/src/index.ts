/**
 * @fileoverview
 * @module @webkrnl/design-system
 * @summary The public API of `@webkrnl/design-system`.
 * @description
 * Re-exports the Design System subsystem ({@linkcode createDesignSystem}),
 * the tokens, the theme rules, the stylesheet export, and the types.
 *
 * ```text
 *   @webkrnl/design-system
 *   +-- createDesignSystem        the subsystem: id 'design-system', featurized, Page scope
 *   +-- DEFAULT_TOKENS, token, cssVar, checkTokens, contrastRatio   the tokens
 *   +-- APPEARANCE_SETTINGS, APPEARANCE_KEYS, DEFAULT_APPEARANCE    the preferences, for Settings
 *   +-- resolveTheme, themeValues, DEFAULT_THEME                    the theme rules
 *   +-- renderThemeCss, renderThemeScript                           no flash of the wrong theme
 *   ```
 *
 * @example
 * Registering it
 * ```ts
 * import { APPEARANCE_SETTINGS, createDesignSystem } from '@webkrnl/design-system';
 *
 * const kernel = new Kernel([...centralized, createConsent(), createSettings({ definitions: APPEARANCE_SETTINGS }), createDesignSystem()]);
 * ```
 *
 * @example
 * A token in a style
 * ```ts
 * import { token } from '@webkrnl/design-system';
 *
 * button.style.background = token('color.primary');
 * ```
 *
 * @author MathAid
 */

export * from './design-system';
export * from './theme';
export * from './tokens';
