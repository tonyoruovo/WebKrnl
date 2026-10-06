/**
 * @fileoverview
 * @summary Builds every package to `dist/`: ES modules (rolldown) and declarations (tsc), for publishing.
 * @description
 * Implements the build of docs/ARCHITECTURE.md §22.5. In the workspace,
 * packages export their TypeScript sources; on the registry, `publishConfig`
 * points at `dist/`.
 *
 * ```text
 *   packages/<name>/src/**\/*.ts  --rolldown, one module per file-->  dist/**\/*.js
 *     new URL('./x.worker.ts', import.meta.url)  -->  new URL('./x.worker.js', import.meta.url)
 *     bare imports (@webkrnl/*, zod, vue, node:*) stay external
 *   packages/<name>/src  --tsc --emitDeclarationOnly, in dependency order-->  dist/**\/*.d.ts
 *     @webkrnl/* resolve to the declarations already built (paths)
 *   ```
 *
 * @example
 * Build everything, or some packages
 * ```ts
 * // pnpm build
 * // node scripts/build.ts core settings
 * ```
 *
 * @author MathAid
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { rolldown } from 'rolldown';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const packagesDir = join(root, 'packages');

interface Manifest {
  readonly name: string;
  readonly exports?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
}

/** @summary Every `.ts` source file under a folder, without declarations. */
function sources(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.d.ts') ? [path] : [];
  });
}

/** @summary The packages, in dependency order: a package after the packages it imports. */
function packagesInOrder(): Array<{ dir: string; manifest: Manifest }> {
  const all = readdirSync(packagesDir)
    .filter((name) => existsSync(join(packagesDir, name, 'package.json')))
    .map((name) => ({
      dir: join(packagesDir, name),
      manifest: JSON.parse(
        readFileSync(join(packagesDir, name, 'package.json'), 'utf8'),
      ) as Manifest,
    }));
  const byName = new Map(all.map((p) => [p.manifest.name, p]));
  const ordered: typeof all = [];
  const visit = (p: (typeof all)[number], path: string[] = []) => {
    if (ordered.includes(p)) return;
    if (path.includes(p.manifest.name))
      throw new Error(`A dependency cycle: ${[...path, p.manifest.name].join(' -> ')}`);
    const deps = Object.keys({ ...p.manifest.dependencies, ...p.manifest.peerDependencies });
    for (const dep of deps) {
      const next = byName.get(dep);
      if (next) visit(next, [...path, p.manifest.name]);
    }
    ordered.push(p);
  };
  for (const p of all) visit(p);
  return ordered;
}

/** @summary The paths of every `@webkrnl/*` import, mapped to its built declarations. */
function declarationPaths(
  packages: Array<{ dir: string; manifest: Manifest }>,
): Record<string, string[]> {
  const paths: Record<string, string[]> = {};
  for (const { dir, manifest } of packages) {
    for (const [key, target] of Object.entries(manifest.exports ?? {})) {
      if (!target.endsWith('.ts')) continue;
      const specifier = key === '.' ? manifest.name : `${manifest.name}${key.slice(1)}`;
      paths[specifier] = [
        join(dir, target.replace(/^\.\/src\//, 'dist/').replace(/\.ts$/, '.d.ts')),
      ];
    }
  }
  return paths;
}

async function buildModules(dir: string): Promise<void> {
  const input = sources(join(dir, 'src'));
  const bundle = await rolldown({
    input,
    external: (id) => !id.startsWith('.') && !/^[A-Za-z]:[\\/]/.test(id) && !id.startsWith('/'),
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [
      {
        name: 'worker-urls',
        transform(code) {
          return code.includes('.worker.ts')
            ? code.replace(/new URL\((['"])(\.\/[^'"]+)\.worker\.ts\1/g, 'new URL($1$2.worker.js$1')
            : null;
        },
      },
    ],
  });
  await bundle.write({
    dir: join(dir, 'dist'),
    format: 'esm',
    preserveModules: true,
    preserveModulesRoot: join(dir, 'src'),
    entryFileNames: '[name].js',
  });
  await bundle.close();
}

function buildDeclarations(dir: string, paths: Record<string, string[]>): void {
  const config = join(dir, 'tsconfig.build.json');
  writeFileSync(
    config,
    JSON.stringify({
      extends: relative(dir, join(root, 'tsconfig.json')).replaceAll('\\', '/'),
      compilerOptions: {
        noEmit: false,
        emitDeclarationOnly: true,
        declaration: true,
        declarationMap: false,
        sourceMap: false,
        rewriteRelativeImportExtensions: true,
        rootDir: 'src',
        outDir: 'dist',
        paths,
        skipLibCheck: true,
      },
      include: ['src/**/*.ts'],
    }),
  );
  try {
    // The compiler of pnpm typecheck (TypeScript 7).
    const tsc = join(root, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
    const run = spawnSync(process.execPath, [tsc, '-p', config], { cwd: root, encoding: 'utf8' });
    if (run.status !== 0)
      throw new Error(`tsc failed for ${relative(root, dir)}:\n${run.stdout}${run.stderr}`);
  } finally {
    rmSync(config, { force: true });
  }
  // TypeScript keeps relative '.ts' specifiers in declarations: point them at the built files.
  for (const file of declarations(join(dir, 'dist'))) {
    const text = readFileSync(file, 'utf8');
    const fixed = text.replace(/(from\s+|import\()(['"])(\.{1,2}\/[^'"]+)\.ts\2/g, '$1$2$3.js$2');
    if (fixed !== text) writeFileSync(file, fixed);
  }
}

/** @summary Every declaration file under a folder. */
function declarations(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return declarations(path);
    return path.endsWith('.d.ts') ? [path] : [];
  });
}

const only = process.argv.slice(2);
const packages = packagesInOrder();
const paths = declarationPaths(packages);
let failed = false;
for (const { dir, manifest } of packages) {
  const name = relative(packagesDir, dir);
  if (only.length > 0 && !only.includes(name)) continue;
  rmSync(join(dir, 'dist'), { recursive: true, force: true });
  try {
    await buildModules(dir);
    buildDeclarations(dir, paths);
    console.log(`built ${manifest.name}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL ${manifest.name}: ${(error as Error).message}`);
  }
}
process.exitCode = failed ? 1 : 0;
