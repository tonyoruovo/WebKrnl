> **Draft (M9, 2026-10-05), for review.** The user decided the scope: tokens and theme only, Page scope, no components. This draft is agreed before the package is built. See [ARCHITECTURE §21.4](../docs/ARCHITECTURE.md#214-design-system).

# Design System

**Type**: Featurized  
**Importance/Priority/Weight**: **LOW** - The page must render without it. A failure keeps the default tokens of the stylesheet.

The Design System gives the page its **design tokens** and its **theme**. Tokens are named values (colors, spaces, sizes, type, radii, shadows, motion, layers). The theme is the set of token values that applies now. It comes from the preferences of the user (Settings), the preferences of the device (the `prefers-*` media queries), and the locale (Translation). The Design System writes the result as CSS custom properties and attributes on the root element. Components of any framework read the custom properties, so the Design System has no components and no framework dependency.

---

## States

- **theme**: the resolved theme
  ```typescript
  interface ResolvedTheme {
    colorScheme: 'light' | 'dark';          // after 'system' is resolved
    contrast: 'normal' | 'more';            // after 'system' is resolved
    density: 'compact' | 'comfortable' | 'spacious';
    fontScale: number;                      // 0.875 to 1.5; multiplies the type tokens
    reducedMotion: boolean;                 // after 'system' is resolved
    direction: 'ltr' | 'rtl';               // from Translation; 'ltr' without it
    lang: string;                           // from Translation; the document language without it
  }
  ```
- **tokens**: the token set, registered at start
  ```typescript
  interface TokenSet {
    /** The base values: name -> CSS value, for example 'color.surface' -> '#ffffff'. */
    base: Record<string, string>;
    /** Values that replace base values for one condition. */
    modes?: {
      dark?: Record<string, string>;
      contrast?: Record<string, string>;        // contrast 'more'
      darkContrast?: Record<string, string>;    // dark and contrast 'more'
      density?: Partial<Record<'compact' | 'spacious', Record<string, string>>>;
    };
  }
  ```
- **appearance settings** (defined by this package, stored by Settings, §21.1):

  | Key | Values | Default |
  |---|---|---|
  | `appearance.colorScheme` | `system`, `light`, `dark` | `system` |
  | `appearance.contrast` | `system`, `normal`, `more` | `system` |
  | `appearance.density` | `compact`, `comfortable`, `spacious` | `comfortable` |
  | `appearance.fontScale` | a number from 0.875 to 1.5 | `1` |
  | `appearance.reducedMotion` | `system`, `reduce`, `no-preference` | `system` |

  All are `device` settings: they stay after sign-out.

---

## Features

### Token Registry
**Purpose**: Hold the token set.  
**Responsibilities**:
- Take the token set in the options (`createDesignSystem({ tokens })`). A default token set is exported, so an app can start with it and replace values.
- Check token names (`group.name`, lower case, dots and dashes). A bad name is a `RangeError` at start.
- `token(name)` returns the CSS reference `var(--ds-<name with dashes>)`, for use in inline styles and in CSS-in-JS.
- **Weight**: MEDIUM.

### Theme Resolver
**Purpose**: Make the resolved theme.  
**Responsibilities**:
- Read the appearance settings (Settings, optional; without it, every setting is its default).
- Resolve `system` values with `matchMedia` (`prefers-color-scheme`, `prefers-contrast`, `prefers-reduced-motion`), and follow changes of these media queries.
- Read the direction and the locale from Translation (optional).
- **Weight**: MEDIUM.

### Theme Writer
**Purpose**: Apply the theme to the page.  
**Responsibilities**:
- Write each token as a custom property `--ds-<name>` on the root (`document.documentElement` by default, or the `root` option). Mode values replace base values.
- Multiply the type tokens (`font.size.*`, `line.height.*`) by `fontScale`.
- Set `motion.*` durations to `0ms` when `reducedMotion` is `true`.
- Set the attributes `data-color-scheme`, `data-contrast`, `data-density` and `data-reduced-motion`, and `dir` and `lang`, on the root. Set the CSS property `color-scheme`, so that form controls and scrollbars follow.
- Write once for each change, in one animation frame, and only the properties that changed.
- **Weight**: MEDIUM.

### Stylesheet Export
**Purpose**: Avoid a flash of the wrong theme.  
**Responsibilities**:
- `renderThemeCss(tokens)` returns a stylesheet with the base values and the modes as media queries and attribute selectors. The app serves it in the `<head>`, so the first paint has the right theme before the platform starts.
- `renderThemeScript()` returns a small inline script that sets the root attributes from the stored settings before the first paint.
- **Weight**: LOW.

---

## Life Cycle Manager

### Initialization Sequence
1. Check the token set.
2. Read the appearance settings and the media queries, and resolve the theme.
3. Write the theme to the root.
4. Watch Settings and Translation (late binding), and the media queries.

### Destruction Sequence
1. Stop watching.
2. Leave the custom properties on the root, so the page does not change when the subsystem stops. (Page scope: a new page starts a new Design System.)

---

## Worker

**Type**: Virtual Worker (main thread). The work is small, and it writes to the DOM. No worker is needed.

---

## Dependencies

No required dependency. Optional, late-bound:

1. **Settings** (LOW) - the appearance settings.
2. **Translation** (LOW) - the direction and the language.

Without a DOM (in Node, or in a worker), the subsystem resolves the theme but writes nothing.

---

## Control Interface

### Views
- `theme`: the resolved theme.

### Commands
- `token(name): string` - the CSS reference of a token.
- `value(name): string` - the value of a token in the current theme.
- `setAppearance(changes)` - a shortcut that writes the appearance settings through Settings. Without Settings, it changes the theme of this page only.
- `preview(changes): () => void` - applies a theme without saving it (for a settings page). The returned function ends the preview.

---

## Message Packets

- `design-system:theme-changed` - broadcast (Page scope, LOW) with the resolved theme, after each change.

---

## Special Considerations

### No flash of the wrong theme
The custom properties come from the stylesheet export first, and the subsystem only updates them. A page that waits for the platform before it paints is not needed.

### Accessibility
The `contrast: 'more'` mode and `reducedMotion` are part of the token set, not of the components. The default token set meets WCAG 2.2 AA contrast for text in both color schemes, and AAA in the `more` contrast mode.

### Right to left
The direction comes from Translation, and the root gets `dir`. Components use logical CSS properties (`margin-inline-start`, not `margin-left`), so no token changes for right to left.

### Frameworks
The Vue adapter (M10) gives the theme as a reactive value and `token()` as a helper. Other frameworks use the custom properties directly.

### Out of scope
Components, icons, fonts (the app loads its own fonts; the type tokens name them), and design tools (a token export to or from Figma).

---

## Summary

The Design System turns tokens and preferences into CSS custom properties and root attributes. It is featurized, Page scope and LOW. It has no components and no framework dependency. Its reliability guarantee is that the page always has a theme: the stylesheet export gives one before the platform starts, and a failure keeps it.
