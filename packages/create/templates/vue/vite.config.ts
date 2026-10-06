import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig as defineTestConfig, mergeConfig } from 'vitest/config';

import { mockApi } from './mock-api.ts';

export default mergeConfig(
  defineConfig({
    plugins: [vue(), mockApi()],
    // Vite may serve files of a local WebKrnl checkout (--local).
    server: { fs: { allow: ['.' /* {{localAllow}} */] } },
    build: { target: 'es2022' },
    worker: { format: 'es' },
  }),
  defineTestConfig({ test: { include: ['tests/**/*.test.ts'] } }),
);
