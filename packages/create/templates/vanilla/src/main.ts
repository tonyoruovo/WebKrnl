/**
 * {{name}}: the page, without a framework. It reads WebKrnl views and
 * renders again when they change.
 */
import './style.css';

import { createAppPlatform, notes } from './platform';

const platform = createAppPlatform();
await platform.start();
const globalState = platform.unit('global-state')!;
const sync = platform.unit('sync')!;
const translation = platform.unit('translation')!;
const settings = platform.unit('settings')!;
const designSystem = platform.unit('design-system')!;
const list = notes(platform);

const app = document.querySelector<HTMLElement>('#app')!;
app.innerHTML = `
  <h1 data-test="title"></h1>
  <section class="panel">
    <p data-test="status"></p>
    <p data-test="online"></p>
    <p data-test="tabs"></p>
    <p data-test="pending"></p>
    <p data-test="saved"></p>
  </section>
  <div class="actions">
    <button data-test="add-note"></button>
    <button data-test="theme"></button>
    <button data-test="language"></button>
  </div>`;
const field = (name: string) => app.querySelector<HTMLElement>(`[data-test="${name}"]`)!;

let saved = 0;
const t = translation.commands.t;
function render() {
  const state = globalState.views.state.getSnapshot();
  field('title').textContent = t('title', { name: '{{name}}' });
  field('status').textContent = t('status', { status: state.status });
  field('status').dataset.value = state.status;
  field('online').textContent = t('online', { online: String(state.online) });
  field('online').className = state.online ? '' : 'offline';
  field('tabs').textContent = t('tabs', { n: state.tabs });
  const pending = sync.views.state.getSnapshot().pending ?? 0;
  field('pending').textContent = t('pending', { n: pending });
  field('pending').dataset.value = String(pending);
  field('saved').textContent = t('saved', { n: saved });
  field('saved').dataset.value = String(saved);
  field('add-note').textContent = t('addNote');
  field('theme').textContent = t('theme');
  field('language').textContent = t('language');
}

async function refreshSaved() {
  try {
    saved = ((await (await fetch('/api/notes')).json()) as string[]).length;
  } catch {
    // Offline: keep the last count.
  }
  render();
}

for (const view of [globalState.views.state, sync.views.state, translation.views.state]) {
  view.subscribe(render);
}
sync.views.state.subscribe(() => {
  if ((sync.views.state.getSnapshot().pending ?? 0) === 0) void refreshSaved();
});
field('add-note').onclick = () =>
  void list.create(crypto.randomUUID(), { text: new Date().toISOString() });
field('theme').onclick = () => {
  const dark = designSystem.views.theme.getSnapshot().colorScheme === 'dark';
  void designSystem.commands.setAppearance({ colorScheme: dark ? 'light' : 'dark' });
};
field('language').onclick = () =>
  void settings.commands.set(
    'locale',
    translation.views.state.getSnapshot().locale === 'fr' ? 'en' : 'fr',
  );

await translation.commands.ready();
await refreshSaved();
