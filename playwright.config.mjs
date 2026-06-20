import { defineConfig, devices } from '@playwright/test';

// E2E: chạy Chromium thật, mô phỏng dữ liệu YouTube để bắt lỗi UI/logic thực tế
// (regex \p{L}, deviceMemory, render DOM…) mà unit test Node không phát hiện được.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'list' : 'list',
  use: {
    headless: true,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
