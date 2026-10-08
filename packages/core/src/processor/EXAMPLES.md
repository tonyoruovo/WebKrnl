# Examples: `@webkrnl/core` — the processor module

Running work in a processor: on the main thread here, in a worker in a real app.

## Run heavy work in a processor

<!-- example id="core/processor" runtime="any" -->

A processor is one module that runs in a shared worker, a dedicated worker, or on the main thread. This example uses the main thread (`virtual`), which is always available, and yields between items so the page stays responsive.

```ts file=main.ts
import { Kernel, defineProcessor, defineSubsystem, type ProcessorDef } from '@webkrnl/core';

const thumbnailer = defineProcessor<{ sizes: number[] }, string[]>({
  async handle({ sizes }, scope) {
    const done: string[] = [];
    for (const size of sizes) {
      done.push(`${size}x${size}`);
      if (scope.shouldYield()) await scope.yield();
    }
    return done;
  },
});

const processor: ProcessorDef<{ sizes: number[] }, string[]> = {
  id: 'thumbnails',
  job: 'scheduler',
  hosts: ['virtual'], // add 'dedicated' or 'shared' before it to use a worker
  load: async () => thumbnailer,
};

const gallery = defineSubsystem({
  id: 'gallery',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  processors: [processor],
  control: (ctx) => ({
    commands: {
      makeThumbnails: (sizes: number[]) =>
        ctx.processor<{ sizes: number[] }, string[]>('thumbnails').call({ sizes }),
    },
    views: {},
  }),
});

const kernel = new Kernel([gallery]);
await kernel.start();
const control = kernel.unit<ReturnType<typeof gallery.control>>('gallery').control!;
console.log('thumbnails:', JSON.stringify(await control.commands.makeThumbnails([64, 128, 256])));
await kernel.stop();
```

```text output
thumbnails: ["64x64","128x128","256x256"]
```
