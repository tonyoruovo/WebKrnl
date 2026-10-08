<script setup lang="ts">
import { usePlatform, useT, useUnit, useView } from '@webkrnl/vue';
import { computed, onMounted, ref, watch } from 'vue';

import { notes } from '../platform';

const platform = usePlatform();
const t = useT();
const globalState = useUnit('global-state');
const sync = useUnit('sync');
const settings = useUnit('settings');
const translation = useUnit('translation');
const designSystem = useUnit('design-system');

await platform.ready;
const state = useView(globalState.value!.views.state);
const syncState = useView(sync.value!.views.state);
const pending = computed(() => syncState.value.pending ?? 0);
const saved = ref(0);

async function refreshSaved() {
  try {
    saved.value = ((await (await fetch('/api/notes')).json()) as string[]).length;
  } catch {
    // Offline: keep the last count.
  }
}
watch(pending, (n) => n === 0 && void refreshSaved());
onMounted(refreshSaved);

const list = notes(platform);
const addNote = () => void list.create(crypto.randomUUID(), { text: new Date().toISOString() });
const toggleTheme = () => {
  const dark = designSystem.value?.views.theme.getSnapshot().colorScheme === 'dark';
  void designSystem.value?.commands.setAppearance({ colorScheme: dark ? 'light' : 'dark' });
};
const toggleLanguage = () =>
  void settings.value?.commands.set(
    'locale',
    translation.value?.views.state.getSnapshot().locale === 'fr' ? 'en' : 'fr',
  );
</script>

<template>
  <h1 data-test="title">{{ t('title', { name: '{{name}}' }) }}</h1>
  <section class="panel">
    <p data-test="status" :data-value="state.status">{{ t('status', { status: state.status }) }}</p>
    <p data-test="online" :class="{ offline: !state.online }">
      {{ t('online', { online: String(state.online) }) }}
    </p>
    <p data-test="tabs">{{ t('tabs', { n: state.tabs }) }}</p>
    <p data-test="pending" :data-value="pending">{{ t('pending', { n: pending }) }}</p>
    <p data-test="saved" :data-value="saved">{{ t('saved', { n: saved }) }}</p>
  </section>
  <div class="actions">
    <button data-test="add-note" @click="addNote">{{ t('addNote') }}</button>
    <button data-test="theme" @click="toggleTheme">{{ t('theme') }}</button>
    <button data-test="language" @click="toggleLanguage">{{ t('language') }}</button>
  </div>
</template>
