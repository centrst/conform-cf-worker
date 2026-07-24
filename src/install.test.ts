import { describe, expect, it } from 'vitest';
import worker from './index';
import { FRAMEWORKS, installFiles, testCommand } from './templates';
import {
  TEST_FORM_ID,
  baseEnv,
  executionContext,
  installRoute,
} from './test-support';
import type { StoredRouteRecord } from './types';

const ENDPOINT = 'https://api.conform.test/f/cfm_ABCDEFGHJKLMNPQR';

describe('install artifacts', () => {
  for (const framework of FRAMEWORKS) {
    it(`generates an accessible, complete ${framework} artifact`, () => {
      const [file] = installFiles(framework, ENDPOINT);
      expect(file.path.length).toBeGreaterThan(0);
      expect(file.content).not.toContain('{{FORM_ENDPOINT}}');
      expect(file.content.split(ENDPOINT).length - 1).toBe(1);

      expect(file.content).toContain('name="_gotcha"');
      expect(file.content).toContain('aria-hidden="true"');
      expect(file.content).toMatch(/tabindex="-1"|tabIndex=\{-1\}/u);
      expect(file.content).toMatch(/autocomplete="off"|autoComplete="off"/u);

      const ids = [...file.content.matchAll(/<(?:input|textarea)[^>]*\bid="([^"]+)"/gu)].map(
        (match) => match[1],
      );
      expect(ids.length).toBeGreaterThanOrEqual(3);
      for (const id of ids) {
        expect(
          file.content.includes(`for="${id}"`) || file.content.includes(`htmlFor="${id}"`),
          `${framework}: control #${id} has no label`,
        ).toBe(true);
      }

      expect(file.content).toMatch(/autocomplete="name"|autoComplete="name"/u);
      expect(file.content).toMatch(/autocomplete="email"|autoComplete="email"/u);

      if (framework !== 'html') {
        expect(file.content).toContain('role="status"');
        expect(file.content).toContain('aria-live="polite"');
      }
    });
  }

  it('builds a test command that sends a marked test submission', () => {
    expect(testCommand(ENDPOINT)).toContain('_test=true');
    expect(testCommand(ENDPOINT)).toContain(ENDPOINT);
  });
});

describe('install endpoints', () => {
  it('serves the generic artifact with a placeholder endpoint', async () => {
    const response = await worker.fetch(
      new Request('https://api.conform.test/v1/install?framework=react'),
      baseEnv(),
      executionContext().ctx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.framework).toBe('react');
    expect(body.files[0].content).toContain('{{FORM_ENDPOINT}}');
    expect(body.test_command).toContain('{{FORM_ENDPOINT}}');
    expect(body.next_action).toBeUndefined();
  });

  it('personalizes the artifact and reports next_action for a pending route', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes, { status: 'pending', destinationId: 'destination-id' });
    const response = await worker.fetch(
      new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}/install?framework=html`),
      env,
      executionContext().ctx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, any>;
    expect(body.form_id).toBe(TEST_FORM_ID);
    expect(body.status).toBe('pending_verification');
    expect(body.next_action.type).toBe('human_verification');
    expect(body.files[0].content).toContain(`https://api.conform.test/f/${TEST_FORM_ID}`);
    expect(body.test_command).toContain(`/f/${TEST_FORM_ID}`);
  });

  it('returns raw file content with raw=1', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);
    const response = await worker.fetch(
      new Request(
        `https://api.conform.test/v1/routes/${TEST_FORM_ID}/install?framework=react&raw=1`,
      ),
      env,
      executionContext().ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('ContactForm');
  });

  it('404s for an unknown route', async () => {
    const response = await worker.fetch(
      new Request('https://api.conform.test/v1/routes/cfm_QQQQQQQQQQQQQQQQ/install'),
      baseEnv(),
      executionContext().ctx,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'route_not_found' });
  });
});
