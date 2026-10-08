# Examples: `@webkrnl/core` — the unit module

Defining subsystems and features, starting a kernel, dependencies between units, and binding to one that starts later.

## Boot two subsystems that depend on each other

<!-- example id="core/boot-with-a-dependency" runtime="any" -->

A settings subsystem needs storage before it can load the saved theme. The kernel starts `storage` first, then `settings`, and the application changes the theme through a command.

```ts file=main.ts
import { Kernel, defineSubsystem } from '@webkrnl/core';

const storage = defineSubsystem({
  id: 'storage',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: { items: { theme: 'dark' } as Record<string, string> } },
  control: (ctx) => ({
    commands: {
      get: (key: string) => ctx.state.get().items[key],
      put: (key: string, value: string) => ctx.state.update((s) => void (s.items[key] = value)),
    },
    views: {},
  }),
});
type StorageControl = ReturnType<typeof storage.control>;

const settings = defineSubsystem({
  id: 'settings',
  scope: 'tab',
  kind: 'featurized',
  requires: [{ target: 'storage' }],
  state: { initial: { theme: 'light' }, policy: { theme: { readable: true } } },
  init: (ctx) => {
    const saved = ctx.dependency<StorageControl>('storage')?.commands.get('theme');
    if (saved) ctx.state.update((s) => void (s.theme = saved));
  },
  control: (ctx) => ({
    commands: {
      setTheme(theme: string) {
        ctx.state.update((s) => void (s.theme = theme));
        ctx.dependency<StorageControl>('storage')?.commands.put('theme', theme);
      },
    },
    views: { state: ctx.state.readable },
  }),
});

const kernel = new Kernel([settings, storage]); // the order does not matter
await kernel.start();

const control = kernel.unit<ReturnType<typeof settings.control>>('settings').control!;
console.log('loaded theme:', control.views.state.getSnapshot().theme);
control.commands.setTheme('light');
console.log('new theme:', control.views.state.getSnapshot().theme);
console.log('storage status:', kernel.unit('storage').lifecycle.getSnapshot().status);
await kernel.stop();
```

```text output
loaded theme: dark
new theme: light
storage status: READY
```

## Keep a subsystem running when one feature fails

<!-- example id="core/degraded-feature" runtime="any" -->

Storage has two backends as features. When IndexedDB is blocked, only that feature fails: the subsystem is `DEGRADED` and still works. A restart brings the feature back.

```ts file=main.ts
import { Kernel, NO_CONTROL, defineSubsystem, defineUnit } from '@webkrnl/core';

let indexedDbBlocked = true;

const memory = defineUnit({ id: 'memory', state: { initial: {} }, control: () => NO_CONTROL });
const idb = defineUnit({
  id: 'idb',
  state: { initial: {} },
  init: () => {
    if (indexedDbBlocked) throw new Error('IndexedDB is blocked in private mode.');
  },
  control: () => NO_CONTROL,
});

const storage = defineSubsystem({
  id: 'storage',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  features: [memory, idb],
  control: () => NO_CONTROL,
});

const kernel = new Kernel([storage], { onError: () => {} });
await kernel.start();

const show = () => {
  const { status, offFeatures } = kernel.unit('storage').lifecycle.getSnapshot();
  console.log(`storage: ${status}, off: [${offFeatures.join(', ')}]`);
};
show();
console.log('idb reason:', kernel.unit('storage/idb').lifecycle.getSnapshot().reason);

indexedDbBlocked = false;
await kernel.unit('storage/idb').restart();
show();
await kernel.stop();
```

```text output
storage: DEGRADED, off: [idb]
idb reason: IndexedDB is blocked in private mode.
storage: READY, off: []
```

## Bind to a subsystem that starts later

<!-- example id="core/late-binding" runtime="any" -->

An audit log starts before the storage it writes to. It buffers entries in a `LateBinding`, and `ctx.watch` binds the buffer when storage starts.

```ts file=main.ts
import { Kernel, LateBinding, defineSubsystem } from '@webkrnl/core';

const written: string[] = [];
const buffer = new LateBinding<string>({ capacity: 100 });

const storage = defineSubsystem({
  id: 'storage',
  scope: 'tab',
  kind: 'featurized',
  state: { initial: {} },
  control: () => ({ commands: { append: (line: string) => void written.push(line) }, views: {} }),
});
type StorageControl = ReturnType<typeof storage.control>;

const audit = defineSubsystem({
  id: 'audit',
  scope: 'tab',
  kind: 'featurized',
  requires: [{ target: 'storage', kind: 'optional' }],
  state: { initial: {} },
  init: (ctx) => {
    ctx.watch<StorageControl>('storage', (storage) => {
      if (storage) void buffer.bind((line) => storage.commands.append(line));
      else buffer.unbind();
    });
  },
  control: () => ({ commands: { record: (line: string) => void buffer.write(line) }, views: {} }),
});
type AuditControl = ReturnType<typeof audit.control>;

const kernel = new Kernel([audit, storage]);
await kernel.start();
await kernel.unit('storage').suspend(); // storage stops for a moment

const log = kernel.unit<AuditControl>('audit').control!;
log.commands.record('user signed in');
console.log('written while storage is suspended:', written.length);

await kernel.unit('storage').resume();
await new Promise((resolve) => setTimeout(resolve, 0));
console.log('written after it resumed:', JSON.stringify(written));
await kernel.stop();
```

```text output
written while storage is suspended: 0
written after it resumed: ["user signed in"]
```
