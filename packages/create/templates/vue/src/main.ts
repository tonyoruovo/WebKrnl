import './style.css';

import { createWebKrnl } from '@webkrnl/vue';
import { createApp } from 'vue';

import App from './App.vue';
import { createAppPlatform } from './platform';
import { router } from './router';

const platform = createAppPlatform();
createApp(App).use(router).use(createWebKrnl(platform, { router })).mount('#app');
