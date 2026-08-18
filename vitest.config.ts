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
          // Every assertion here is a real round trip to a real Durable Object
          // on workerd, and CI is far slower than a laptop: a 40-reservation
          // concurrency spec that takes 30ms locally has taken 2.6s there. The
          // 5s default left specs that loop tens of reservations sitting on the
          // edge, failing on timing rather than on behaviour.
          testTimeout: 30_000,
        },
      },
    ],
  },
});
