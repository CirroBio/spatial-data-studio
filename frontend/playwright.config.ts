import { defineConfig, devices } from '@playwright/test';

const FRONTEND_PORT = 5173;
const BACKEND_PORT = 8000;

// Picks whichever backend venv is actually present (this repo's docs use `.venv`;
// `.venv-introspect` is the one already provisioned with squidpy in this environment).
const BACKEND_CMD =
  'PY=../.venv-introspect/bin/python; [ -x "$PY" ] || PY=../.venv/bin/python; [ -x "$PY" ] || PY=python3; ' +
  `cd ../backend && SDS_DATA_DIR=../test-data SDS_CONTAINER_MEM_MB=16384 "$PY" -m uvicorn app.main:app --port ${BACKEND_PORT}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: BACKEND_CMD,
      url: `http://127.0.0.1:${BACKEND_PORT}/api/readyz`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npm run dev',
      url: `http://localhost:${FRONTEND_PORT}`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
    },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
