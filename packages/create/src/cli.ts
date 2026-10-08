#!/usr/bin/env node
/// <reference types="node" />
/**
 * @fileoverview
 * @summary The command of `npm init @webkrnl`: writes a new WebKrnl app.
 * @description
 * `npm init @webkrnl <folder>` runs the package `@webkrnl/create`, which runs
 * this file (docs/ARCHITECTURE.md §22.4). In this monorepo, run it with Node
 * directly: `node packages/create/src/cli.ts my-app --local .`.
 *
 * @example
 * From a terminal
 * ```ts
 * // npm init @webkrnl shop -- --template vanilla
 * ```
 *
 * @author MathAid
 */

import { HELP, nextSteps, parseArguments, scaffold } from './scaffold.ts';

try {
  const options = parseArguments(process.argv.slice(2));
  if ('help' in options) {
    console.log(HELP);
  } else {
    const result = await scaffold(options);
    console.log(nextSteps(result, process.cwd(), options.local !== undefined));
  }
} catch (error) {
  console.error(`${(error as Error).message}\n\n${HELP}`);
  process.exitCode = 1;
}
