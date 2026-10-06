/**
 * The Design System in real browsers: the custom properties reach the
 * computed style, the stylesheet export paints the right theme without the
 * subsystem, and the font scale changes rendered sizes.
 */
import type { SubsystemDefinition } from '@platform/core';
import { createTestPlatform } from '@platform/core/testing';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_TOKENS,
  DESIGN_SYSTEM_ID,
  createDesignSystem,
  renderThemeCss,
  type DesignSystemControl,
} from '../src';

const platforms: ReturnType<typeof createTestPlatform>[] = [];
const cleanups: Array<() => void> = [];
afterEach(async () => {
  for (const p of platforms.splice(0)) await p.stop();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function element() {
  const el = document.createElement('div');
  el.textContent = 'text';
  document.body.append(el);
  cleanups.push(() => el.remove());
  return el;
}

describe('the Design System in the browser', () => {
  it('writes the theme that the computed style reads', async () => {
    const root = element();
    const platform = createTestPlatform([
      createDesignSystem({ root, storage: null }) as SubsystemDefinition,
    ]);
    platforms.push(platform);
    await platform.start();
    const ds = platform.unit<DesignSystemControl>(DESIGN_SYSTEM_ID).control!;
    root.style.color = ds.commands.token('color.text');
    root.style.fontSize = ds.commands.token('font.size.md');

    await ds.commands.setAppearance({ colorScheme: 'dark', fontScale: 1.5 });
    await expect.poll(() => root.getAttribute('data-color-scheme')).toBe('dark');
    expect(getComputedStyle(root).color).toBe('rgb(232, 234, 237)'); // #e8eaed
    expect(getComputedStyle(root).fontSize).toBe(
      `${1.5 * parseFloat(getComputedStyle(document.documentElement).fontSize)}px`,
    );
  });

  it('paints the theme from the stylesheet export alone', () => {
    const style = document.createElement('style');
    style.textContent = renderThemeCss(DEFAULT_TOKENS);
    document.head.append(style);
    const html = document.documentElement;
    cleanups.push(() => {
      style.remove();
      html.removeAttribute('data-color-scheme');
      html.removeAttribute('data-density');
    });
    html.setAttribute('data-color-scheme', 'dark');
    html.setAttribute('data-density', 'compact');
    const computed = getComputedStyle(html);
    expect(computed.getPropertyValue('--ds-color-surface').trim()).toBe('#121316');
    expect(computed.getPropertyValue('--ds-space-4').trim()).toBe('0.75rem');
  });
});
