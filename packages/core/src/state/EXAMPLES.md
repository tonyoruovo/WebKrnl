# Examples: `@webkrnl/core` — the state module

Keeping a unit's state across reloads with the kernel's persistence.

## Keep state across reloads

<!-- example id="core/persisted-state" runtime="any" -->

The kernel saves the persisted keys of each unit at teardown and loads them at the next start. This example uses a `Map` in place of `localStorage`. Only the `draft` key is persisted. The `typing` key stays private.

```ts file=main.ts
import { Kernel, defineSubsystem, type PersistedState, type StatePersistence } from '@webkrnl/core';

const disk = new Map<string, PersistedState<object>>();
const persistence: StatePersistence = {
  load: (unitId) => disk.get(unitId),
  save: (unitId, state) => void disk.set(unitId, state),
};

const editor = defineSubsystem({
  id: 'editor',
  scope: 'tab',
  kind: 'featurized',
  state: {
    initial: { draft: '', typing: false },
    policy: { draft: { readable: true, persisted: true } },
  },
  control: (ctx) => ({
    commands: { type: (text: string) => ctx.state.update((s) => void (s.draft = text)) },
    views: { state: ctx.state.readable },
  }),
});
type EditorControl = ReturnType<typeof editor.control>;

const first = new Kernel([editor], { persistence });
await first.start();
first.unit<EditorControl>('editor').control!.commands.type('Hello');
await first.stop(); // the page unloads
console.log('saved:', JSON.stringify(disk.get('editor')));

const second = new Kernel([editor], { persistence });
await second.start(); // the page loads again
console.log(
  'restored:',
  second.unit<EditorControl>('editor').control!.views.state.getSnapshot().draft,
);
await second.stop();
```

```text output
saved: {"version":1,"data":{"draft":"Hello"}}
restored: Hello
```
