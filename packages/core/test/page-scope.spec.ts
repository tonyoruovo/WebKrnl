/**
 * Page scope ends on a route change (docs/ARCHITECTURE.md §11.2.1, §22.1):
 * Page-scope subsystems restart as a new page, or handle the path in
 * `pageChange`; other scopes do not notice.
 */
import { describe, expect, it } from 'vitest';

import { Kernel, defineSubsystem } from '../src';
import { createMemoryPersistence, createMemoryRouteSource } from '../src/testing';

function counter(
  id: string,
  scope: 'page' | 'tab',
  extra: { pageChange?: (path: string) => void } = {},
) {
  const log: string[] = [];
  const unit = defineSubsystem({
    id,
    scope,
    kind: 'featurized',
    state: {
      initial: { clicks: 0, theme: 'light' },
      policy: { clicks: { readable: true }, theme: { readable: true, persisted: true } },
    },
    init: () => {
      log.push('init');
      return () => void log.push('dispose');
    },
    control: (ctx) => ({
      commands: {
        click: () => ctx.state.update((s) => void s.clicks++),
        theme: (theme: string) => ctx.state.update((s) => void (s.theme = theme)),
      },
      views: { state: ctx.state.readable },
    }),
    ...extra,
  });
  return { unit, log };
}

type Control = ReturnType<ReturnType<typeof counter>['unit']['control']>;

describe('Page scope and route changes', () => {
  it('restarts Page-scope subsystems as a new page, and leaves the others', async () => {
    const routes = createMemoryRouteSource('/a');
    const page = counter('page-unit', 'page');
    const tab = counter('tab-unit', 'tab');
    const kernel = new Kernel([page.unit, tab.unit], {
      routes,
      persistence: createMemoryPersistence(),
    });
    await kernel.start();
    const pageControl = kernel.unit<Control>('page-unit').control!;
    pageControl.commands.click();
    pageControl.commands.theme('dark'); // persisted: it comes back
    kernel.unit<Control>('tab-unit').control!.commands.click();
    await kernel.settled();
    await new Promise((resolve) => setTimeout(resolve, 5)); // the automatic save

    routes.navigate('/b');
    await kernel.changePage('/b'); // waits for the change that the route source started
    expect(page.log).toEqual(['init', 'dispose', 'init']);
    expect(tab.log).toEqual(['init']);
    const renewed = kernel.unit<Control>('page-unit');
    expect(renewed.control!.views.state.getSnapshot()).toEqual({ clicks: 0, theme: 'dark' });
    expect(renewed.lifecycle.getSnapshot().status).toBe('READY');
    expect(kernel.unit<Control>('tab-unit').control!.views.state.getSnapshot()).toMatchObject({
      clicks: 1,
    });
    await kernel.stop();
  });

  it('calls pageChange instead, when the subsystem has it', async () => {
    const routes = createMemoryRouteSource('/');
    const paths: string[] = [];
    const page = counter('theme', 'page', {
      pageChange: (path) => void paths.push(path),
    });
    const kernel = new Kernel([page.unit], { routes });
    await kernel.start();
    routes.navigate('/settings');
    await kernel.changePage('/settings');
    expect(paths).toEqual(['/settings']); // the same path twice: one change
    expect(page.log).toEqual(['init']);
    await kernel.stop();
  });

  it('restarts when pageChange throws, and reports the error', async () => {
    const errors: unknown[] = [];
    const page = counter('fragile', 'page', {
      pageChange: () => {
        throw new Error('no');
      },
    });
    const kernel = new Kernel([page.unit], { routes: null, onError: (e) => void errors.push(e) });
    await kernel.start();
    await kernel.changePage('/next');
    expect(page.log).toEqual(['init', 'dispose', 'init']);
    expect(errors).toHaveLength(1);
    await kernel.stop();
  });

  it('stops following the route source when the kernel stops', async () => {
    const routes = createMemoryRouteSource('/');
    const page = counter('p', 'page');
    const kernel = new Kernel([page.unit, { ...counter('t', 'tab').unit }], { routes });
    await kernel.start();
    await kernel.stop();
    routes.navigate('/later');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(page.log).toEqual(['init', 'dispose']);
  });
});
