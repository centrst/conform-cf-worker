import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

/**
 * Two projects, because the suites need different things.
 *
 * Almost everything runs under plain node with the bindings faked — fast, and
 * the right level for request routing, the error contract, and email copy.
 *
 * The Durable Objects cannot be tested that way. Their behaviour *is* the SQL
 * they run, so a fake proves nothing: the enforcing clause in InboxQuota could
 * be deleted and a fake would happily keep reporting `allowed: false`. Those
 * specs run on workerd against real Durable Object storage instead.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts', 'mcp/src/**/*.test.ts'],
          exclude: ['src/**/*.workers.test.ts'],
          restoreMocks: true,
        },
      },
      {
        plugins: [
          cloudflareTest({
            miniflare: {
              compatibilityDate: '2026-07-21',
              durableObjects: {
                QUOTAS: { className: 'InboxQuota', useSQLite: true },
                ROUTES: { className: 'FormRoute', useSQLite: true },
              },
            },
            wrangler: { configPath: './wrangler.toml' },
          }),
        ],
        test: {
          name: 'workers',
          include: ['src/**/*.workers.test.ts'],
          restoreMocks: true,
        },
      },
    ],
  },
});
