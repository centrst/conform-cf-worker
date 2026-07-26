import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'mcp/src/**/*.test.ts'],
    restoreMocks: true,
  },
});
