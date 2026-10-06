# Examples: `@webkrnl/create`

The scaffolder writes a new WebKrnl app. Most people run it as `npm init @webkrnl`; scripts and tests call `scaffold` directly. It writes files to disk, so these examples are shown but not run.

## Create an app from the terminal

<!-- example id="create/terminal" runtime="none" -->

A Vue app (the default template), then a plain TypeScript app. `npm init @webkrnl` runs the package `@webkrnl/create`.

```ts file=main.ts
// npm init @webkrnl shop
// cd shop && npm install && npm run dev
//
// npm init @webkrnl notes -- --template vanilla
// cd notes && npm install && npm test
export {};
```

## Create an app from a script

<!-- example id="create/script" runtime="none" -->

A script of a monorepo makes an app that links the local WebKrnl packages (`--local`), as the M10 gate does, and prints the next steps.

```ts file=main.ts
import { nextSteps, scaffold } from '@webkrnl/create';

const result = await scaffold({ directory: 'apps/try-webkrnl', template: 'vanilla', local: '.' });
console.log(result.files.join('\n'));
console.log(nextSteps(result, process.cwd(), true));
```
