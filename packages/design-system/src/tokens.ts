/**
 * @fileoverview
 * @summary Design tokens: named CSS values, with modes for dark, more contrast and density.
 * @description
 * Implements the Token Registry of `docs/proposals/design-system_PROPOSAL.md`. A
 * token has a dotted name (`color.surface`) and a CSS value. On the page it is
 * the custom property `--ds-color-surface`. Modes replace base values for one
 * condition.
 *
 * ```text
 *   'color.surface'  -->  --ds-color-surface  -->  var(--ds-color-surface)
 *   base  <--  modes.dark | modes.contrast | modes.darkContrast  <--  modes.density.compact | spacious
 *   ```
 *
 * @example
 * Using a token in an inline style
 * ```ts
 * button.style.background = token('color.primary'); // 'var(--ds-color-primary)'
 * ```
 *
 * @author MathAid
 */

/**
 * @summary A set of tokens: base values, and the values that replace them in each mode.
 *
 * @example
 * Example 1: A small set
 * ```ts
 * const tokens: TokenSet = { base: { 'color.surface': '#fff' }, modes: { dark: { 'color.surface': '#121316' } } };
 * ```
 *
 * @example
 * Example 2: Changing one value of the default set
 * ```ts
 * const tokens: TokenSet = { ...DEFAULT_TOKENS, base: { ...DEFAULT_TOKENS.base, 'color.primary': '#7c3aed' } };
 * ```
 *
 * @public
 */
export interface TokenSet {
  /**
   * @summary The base values: name to CSS value.
   */
  readonly base: Readonly<Record<string, string>>;
  /**
   * @summary The values that replace base values for one condition.
   */
  readonly modes?: TokenModes;
}

/**
 * @summary The modes of a {@linkcode TokenSet}.
 * @public
 */
export interface TokenModes {
  /**
   * @summary The values of the dark color scheme.
   */
  readonly dark?: Readonly<Record<string, string>>;
  /**
   * @summary The values of the light color scheme with more contrast.
   */
  readonly contrast?: Readonly<Record<string, string>>;
  /**
   * @summary The values of the dark color scheme with more contrast. They apply after `dark`.
   */
  readonly darkContrast?: Readonly<Record<string, string>>;
  /**
   * @summary The values of the densities other than `comfortable`.
   */
  readonly density?: Readonly<
    Partial<Record<'compact' | 'spacious', Readonly<Record<string, string>>>>
  >;
}

const NAME = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

/**
 * @summary Returns the custom property of a token: `color.surface` gives `--ds-color-surface`.
 *
 * @example
 * Example 1: A color
 * ```ts
 * cssVar('color.surface'); // '--ds-color-surface'
 * ```
 *
 * @example
 * Example 2: Reading the value on the page
 * ```ts
 * getComputedStyle(document.documentElement).getPropertyValue(cssVar('space.4'));
 * ```
 *
 * @param {string} name The token.
 * @returns {string} The custom property.
 *
 * @public
 */
export function cssVar(name: string): string {
  return `--ds-${name.replaceAll('.', '-')}`;
}

/**
 * @summary Returns the CSS reference of a token, for inline styles and CSS-in-JS.
 *
 * @example
 * Example 1: An inline style
 * ```ts
 * card.style.padding = token('space.4'); // 'var(--ds-space-4)'
 * ```
 *
 * @example
 * Example 2: A fallback
 * ```ts
 * token('color.brand', '#7c3aed'); // 'var(--ds-color-brand, #7c3aed)'
 * ```
 *
 * @param {string} name The token.
 * @param {string} [fallback] The value when the property is not set.
 * @returns {string} The `var()` reference.
 *
 * @public
 */
export function token(name: string, fallback?: string): string {
  return fallback === undefined ? `var(${cssVar(name)})` : `var(${cssVar(name)}, ${fallback})`;
}

/**
 * @summary Checks the names of a token set.
 *
 * @description
 * A name is lower case, with at least one dot: `group.name`, `font.size.md`.
 * Dashes and digits are allowed after the first character. A mode may only
 * replace a token that the base has.
 *
 * @example
 * Example 1: A good set
 * ```ts
 * checkTokens(DEFAULT_TOKENS); // no error
 * ```
 *
 * @example
 * Example 2: A bad name
 * ```ts
 * checkTokens({ base: { Primary: 'red' } }); // RangeError
 * ```
 *
 * @param {TokenSet} tokens The set.
 * @returns {void}
 * @throws {RangeError} For a bad name, or a mode value without a base value.
 *
 * @public
 */
export function checkTokens(tokens: TokenSet): void {
  for (const name of Object.keys(tokens.base)) {
    if (!NAME.test(name))
      throw new RangeError(`"${name}" is not a token name (group.name, lower case).`);
  }
  const modes = tokens.modes ?? {};
  const lists = [
    modes.dark,
    modes.contrast,
    modes.darkContrast,
    modes.density?.compact,
    modes.density?.spacious,
  ];
  for (const list of lists) {
    for (const name of Object.keys(list ?? {})) {
      if (!(name in tokens.base))
        throw new RangeError(`The mode value "${name}" has no base value.`);
    }
  }
}

/**
 * @summary The default token set.
 *
 * @description
 * Colors, space, radii, type, shadows, motion and layers. Text meets WCAG 2.2
 * AA contrast (4.5:1) on its surfaces in both color schemes, and AAA (7:1) in
 * the modes with more contrast. Start with it, and replace the values of your
 * brand.
 *
 * @example
 * Reading a value
 * ```ts
 * DEFAULT_TOKENS.base['color.primary']; // '#0b57d0'
 * ```
 *
 * @public
 */
export const DEFAULT_TOKENS: TokenSet = {
  base: {
    'color.surface': '#ffffff',
    'color.surface-raised': '#f4f5f7',
    'color.text': '#1b1d21',
    'color.text-muted': '#4f5560',
    'color.border': '#8a919c',
    'color.primary': '#0b57d0',
    'color.on-primary': '#ffffff',
    'color.danger': '#b3261e',
    'color.on-danger': '#ffffff',
    'color.success': '#1e6b34',
    'color.on-success': '#ffffff',
    'color.focus': '#0b57d0',
    'space.0': '0',
    'space.1': '0.25rem',
    'space.2': '0.5rem',
    'space.3': '0.75rem',
    'space.4': '1rem',
    'space.5': '1.5rem',
    'space.6': '2rem',
    'space.7': '3rem',
    'space.8': '4rem',
    'radius.sm': '4px',
    'radius.md': '8px',
    'radius.lg': '16px',
    'radius.full': '9999px',
    'font.family.sans': 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    'font.family.mono': 'ui-monospace, "SF Mono", Consolas, monospace',
    'font.size.xs': '0.75rem',
    'font.size.sm': '0.875rem',
    'font.size.md': '1rem',
    'font.size.lg': '1.25rem',
    'font.size.xl': '1.5rem',
    'font.size.xxl': '2rem',
    'font.weight.regular': '400',
    'font.weight.medium': '500',
    'font.weight.bold': '700',
    'line.height.tight': '1.25',
    'line.height.normal': '1.5',
    'shadow.sm': '0 1px 2px rgb(0 0 0 / 0.12)',
    'shadow.md': '0 4px 12px rgb(0 0 0 / 0.16)',
    'motion.duration.fast': '120ms',
    'motion.duration.normal': '200ms',
    'motion.duration.slow': '320ms',
    'motion.easing.standard': 'cubic-bezier(0.2, 0, 0, 1)',
    'z.dropdown': '1000',
    'z.overlay': '1100',
    'z.modal': '1200',
    'z.toast': '1300',
  },
  modes: {
    dark: {
      'color.surface': '#121316',
      'color.surface-raised': '#1d1f24',
      'color.text': '#e8eaed',
      'color.text-muted': '#b4b9c1',
      'color.border': '#6b717b',
      'color.primary': '#8ab4f8',
      'color.on-primary': '#0b1d3a',
      'color.danger': '#f2b8b5',
      'color.on-danger': '#3c0b08',
      'color.success': '#8fd19e',
      'color.on-success': '#0a2912',
      'color.focus': '#8ab4f8',
      'shadow.sm': '0 1px 2px rgb(0 0 0 / 0.5)',
      'shadow.md': '0 4px 12px rgb(0 0 0 / 0.6)',
    },
    contrast: {
      'color.text': '#000000',
      'color.text-muted': '#2b2f36',
      'color.border': '#3d434c',
      'color.primary': '#0842a0',
      'color.danger': '#8c1d18',
      'color.success': '#14532a',
      'color.focus': '#0842a0',
    },
    darkContrast: {
      'color.surface': '#000000',
      'color.surface-raised': '#121316',
      'color.text': '#ffffff',
      'color.text-muted': '#dfe2e7',
      'color.border': '#b4b9c1',
      'color.primary': '#b9d3fc',
      'color.danger': '#f9dedc',
      'color.success': '#b7e4c1',
      'color.focus': '#b9d3fc',
    },
    density: {
      compact: {
        'space.1': '0.125rem',
        'space.2': '0.375rem',
        'space.3': '0.5rem',
        'space.4': '0.75rem',
        'space.5': '1rem',
        'space.6': '1.5rem',
        'space.7': '2rem',
        'space.8': '3rem',
      },
      spacious: {
        'space.1': '0.375rem',
        'space.2': '0.75rem',
        'space.3': '1rem',
        'space.4': '1.25rem',
        'space.5': '2rem',
        'space.6': '2.5rem',
        'space.7': '4rem',
        'space.8': '5rem',
      },
    },
  },
};

/**
 * @summary Returns the WCAG contrast ratio of two colors (`#rgb` or `#rrggbb`), from 1 to 21.
 *
 * @example
 * Example 1: Black on white
 * ```ts
 * contrastRatio('#000', '#fff'); // 21
 * ```
 *
 * @example
 * Example 2: Checking a brand color
 * ```ts
 * if (contrastRatio(brand, '#ffffff') < 4.5) console.warn('Text on the brand color is hard to read.');
 * ```
 *
 * @param {string} a One color.
 * @param {string} b The other.
 * @returns {number} The ratio.
 * @throws {RangeError} For a color that is not a hex color.
 *
 * @public
 */
export function contrastRatio(a: string, b: string): number {
  const luminance = (hex: string) => {
    const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
    if (!match) throw new RangeError(`"${hex}" is not a hex color.`);
    const digits = match[1]!.length === 3 ? [...match[1]!].map((d) => d + d).join('') : match[1]!;
    const [r, g, bl] = [0, 2, 4].map((i) => {
      const c = parseInt(digits.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
