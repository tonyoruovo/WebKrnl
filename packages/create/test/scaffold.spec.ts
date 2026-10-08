/**
 * The scaffolder (docs/ARCHITECTURE.md §22.4): the arguments, the files, the
 * placeholders, and the refusals.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { nextSteps, parseArguments, scaffold, TEMPLATES } from '../src/scaffold.ts';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});
const temp = () => {
  const folder = mkdtempSync(join(tmpdir(), 'webkrnl-create-'));
  folders.push(folder);
  return folder;
};

describe('parseArguments', () => {
  it('reads a folder and the options', () => {
    expect(parseArguments(['shop'])).toEqual({ directory: 'shop' });
    expect(
      parseArguments(['shop', '--template', 'vanilla', '--name=my-shop', '--local', '..']),
    ).toEqual({
      directory: 'shop',
      template: 'vanilla',
      name: 'my-shop',
      local: '..',
    });
    expect(parseArguments(['--help'])).toEqual({ help: true });
  });

  it('refuses unknown options, missing values and a missing folder', () => {
    expect(() => parseArguments(['shop', '--colour'])).toThrow('Unknown option --colour.');
    expect(() => parseArguments(['shop', '--template'])).toThrow('--template needs a value.');
    expect(() => parseArguments([])).toThrow('Give one folder');
    expect(() => parseArguments(['a', 'b'])).toThrow('Give one folder');
  });
});

describe('scaffold', () => {
  it('writes every template with its name and the registry version', async () => {
    for (const template of TEMPLATES) {
      const directory = join(temp(), `my-${template}`);
      const result = await scaffold({ directory, template, version: '1.2.3' });
      expect(result.name).toBe(`my-${template}`);
      expect(result.files).toContain('.gitignore');
      expect(result.files).toContain('src/platform.ts');
      expect(result.files).toContain('tests/offline.test.ts');
      expect(result.files).toContain('public/i18n/en/common.json');
      const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      expect(pkg.name).toBe(`my-${template}`);
      expect(pkg.dependencies['@webkrnl/platform']).toBe('^1.2.3');
      const config = readFileSync(join(directory, 'vite.config.ts'), 'utf8');
      expect(config).toContain("allow: ['.']");
      expect(readFileSync(join(directory, 'src/platform.ts'), 'utf8')).toContain(
        `appName: 'my-${template}'`,
      );
      const all = result.files.map((f) => readFileSync(join(directory, f), 'utf8')).join('\n');
      expect(all).not.toMatch(/\{\{(name|template|version|dep:|localAllow)/);
    }
    expect((await scaffold({ directory: join(temp(), 'v') })).template).toBe('vue');
  });

  it('links a local checkout', async () => {
    const directory = join(temp(), 'linked');
    await scaffold({ directory, template: 'vanilla', local: REPO });
    const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@webkrnl/platform']).toMatch(/^link:.*\/packages\/platform$/);
    expect(readFileSync(join(directory, 'vite.config.ts'), 'utf8')).toMatch(
      /allow: \['\.', ".*"\]/,
    );
    const result = { directory, name: 'linked', template: 'vanilla' as const, files: ['a'] };
    expect(nextSteps(result, join(directory, '..'), true)).toContain('pnpm install');
  });

  it('refuses a folder that is not empty, a bad name, an unknown template and a wrong checkout', async () => {
    const full = temp();
    writeFileSync(join(full, 'x.txt'), 'x');
    await expect(scaffold({ directory: full, name: 'full' })).rejects.toThrow('is not empty');
    await expect(scaffold({ directory: join(temp(), 'Bad Name') })).rejects.toThrow(
      'not a valid package name',
    );
    await expect(
      scaffold({ directory: join(temp(), 'a'), template: 'svelte' as never }),
    ).rejects.toThrow('Unknown template');
    const notRepo = temp();
    mkdirSync(join(notRepo, 'packages'));
    await expect(scaffold({ directory: join(temp(), 'b'), local: notRepo })).rejects.toThrow(
      'not a checkout of the WebKrnl monorepo',
    );
  });
});
