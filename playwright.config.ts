import { defineConfig } from '@playwright/test';
import path from 'node:path';

const python=process.platform==='win32'?'.venv\\Scripts\\python.exe':'.venv/bin/python';
export default defineConfig({
  testDir: './tests/e2e',
  workers: 1,
  timeout: 30000,
  reporter: 'list',
  outputDir: '.runtime/e2e-results',
  use: { baseURL: 'http://127.0.0.1:5174', viewport: { width: 1440, height: 1000 }, screenshot: 'only-on-failure' },
  webServer: [
    { command: python+' -m uvicorn backend.app:app --host 127.0.0.1 --port 8766', url:'http://127.0.0.1:8766/api/health', env:{DEV_MODE:'1',DATABASE_PATH:path.resolve('.runtime/e2e/'+Date.now()+'/history.sqlite')},reuseExistingServer:false },
    { command:'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5174 --strictPort',url:'http://127.0.0.1:5174',env:{HISTORY_API_TARGET:'http://127.0.0.1:8766'},reuseExistingServer:false },
  ],
});
