/// <reference types="node" />
/**
 * The M10 gate (docs/ARCHITECTURE.md §22.6): a freshly scaffolded Vue app and
 * a plain TypeScript app install, pass their generated tests, build, and in
 * real browsers boot, go offline, keep a change, and recover.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium, firefox, webkit, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  contextOptionsFor,
  launchOptionsFor,
  selectInstallations,
} from '../../../playwright.config';
import { scaffold, type Template } from '../src/scaffold.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const ROOT = join(tmpdir(), `webkrnl-gate-${Date.now()}`);
const TEMPLATES: readonly Template[] = ['vue', 'vanilla'];
const PORTS: Record<Template, number> = { vue: 41730, vanilla: 41731 };

interface PreviewServer {
  close(): Promise<void>;
}
const servers: PreviewServer[] = [];
const results = new Map<Template, { test: number; build: number; output: string }>();

/** Runs pnpm in a folder; returns the exit code and the output. */
function pnpm(cwd: string, args: string[]) {
  const run = spawnSync('pnpm', args, { cwd, shell: true, encoding: 'utf8', timeout: 600_000 });
  return { code: run.status ?? 1, output: `${run.stdout}\n${run.stderr}` };
}

/** Unlinks the links into this repository before a folder is deleted, so nothing in the repository goes. */
function removeApp(folder: string) {
  const scope = join(folder, 'node_modules', '@webkrnl');
  if (existsSync(scope)) {
    for (const name of readdirSync(scope)) {
      const link = join(scope, name);
      if (lstatSync(link).isSymbolicLink()) {
        try {
          unlinkSync(link);
        } catch {
          rmdirSync(link); // a junction on Windows
        }
      }
    }
  }
  rmSync(folder, { recursive: true, force: true });
}

beforeAll(async () => {
  mkdirSync(ROOT, { recursive: true });
  for (const template of TEMPLATES) {
    const directory = join(ROOT, `gate-${template}`);
    await scaffold({ directory, template, local: REPO });
    const install = pnpm(directory, ['install']);
    if (install.code !== 0)
      throw new Error(`pnpm install failed for ${template}:\n${install.output}`);
    const test = pnpm(directory, ['test']);
    const build = pnpm(directory, ['build']);
    results.set(template, {
      test: test.code,
      build: build.code,
      output: test.output + build.output,
    });
    if (build.code !== 0) continue;
    // Vite of the app, so its config and plugins resolve from the app.
    const vitePath = createRequire(join(directory, 'package.json')).resolve('vite');
    const vite = (await import(pathToFileURL(vitePath).href)) as {
      preview(config: object): Promise<PreviewServer>;
    };
    servers.push(
      await vite.preview({
        root: directory,
        logLevel: 'silent',
        preview: { port: PORTS[template], strictPort: true },
      }),
    );
  }
}, 900_000);

afterAll(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const template of TEMPLATES) removeApp(join(ROOT, `gate-${template}`));
  rmSync(ROOT, { recursive: true, force: true });
}, 120_000);

describe('M10 gate: the scaffolded apps', () => {
  for (const template of TEMPLATES) {
    it(`${template}: the generated tests pass, and the app builds`, () => {
      const result = results.get(template)!;
      expect(result.test, result.output).toBe(0);
      expect(result.build, result.output).toBe(0);
    });
  }
});

const value = (page: Page, field: string) =>
  page.locator(`[data-test="${field}"]`).getAttribute('data-value');

for (const installation of selectInstallations()) {
  describe(`M10 gate on ${installation.id}`, () => {
    let browser: Browser;
    const engine = { chromium, firefox, webkit }[installation.engine];
    beforeAll(async () => {
      browser = await engine.launch(launchOptionsFor(installation));
    });
    afterAll(async () => {
      await browser?.close();
    });

    for (const template of TEMPLATES) {
      it(`${template}: boots, goes offline, keeps a change, and recovers`, async () => {
        const context = await browser.newContext(contextOptionsFor(installation));
        const page = await context.newPage();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`http://localhost:${PORTS[template]}/`);
        await expect.poll(() => value(page, 'status'), { timeout: 30_000 }).toBe('IDLE');
        await expect
          .poll(() => page.locator('[data-test="title"]').textContent())
          .toContain('gate-');
        const before = Number(await value(page, 'saved'));

        await context.setOffline(true);
        await expect
          .poll(() => page.locator('[data-test="online"]').getAttribute('class'))
          .toBe('offline');
        await page.click('[data-test="add-note"]');
        await expect.poll(() => value(page, 'pending')).toBe('1');

        await context.setOffline(false);
        await expect.poll(() => value(page, 'pending'), { timeout: 30_000 }).toBe('0');
        await expect.poll(() => value(page, 'saved'), { timeout: 30_000 }).toBe(String(before + 1));
        expect(errors).toEqual([]);
        await context.close();
      });
    }
  });
}
