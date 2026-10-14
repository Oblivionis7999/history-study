import { defineConfig } from '@playwright/test';
import path from 'node:path';
const python = process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python';
const port = Number(process.env.PWA_TEST_PORT ?? 4174);
export default defineConfig({
  testDir: './tests/production', workers: 1, timeout: 45000,
  outputDir: '.runtime/pwa-results', reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, browserName: 'chromium' },
  webServer: [
    { command: python + ' scripts/test_server.py', url: 'http://127.0.0.1:8766/api/health', env: { DEV_MODE: '1', AUTH_DATABASE_PATH: path.resolve('.runtime/pwa/' + Date.now() + '/accounts.sqlite') }, reuseExistingServer: false },
    { command: `node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, env: { HISTORY_API_TARGET: 'http://127.0.0.1:8766' }, reuseExistingServer: false },
  ],
});
