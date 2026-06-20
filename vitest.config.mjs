import { defineConfig } from 'vitest/config';

// Vitest chỉ chạy unit test (*.test.mjs). E2E Playwright (tests/e2e/*.spec.mjs)
// chạy riêng bằng `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.mjs'],
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});
