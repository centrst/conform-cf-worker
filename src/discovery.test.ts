import { describe, expect, it } from 'vitest';
import spec from '../openapi.json';
import worker from './index';
import { baseEnv, executionContext } from './test-support';

async function getBody(path: string): Promise<Record<string, any>> {
  const response = await worker.fetch(
    new Request(`https://api.conform.test${path}`),
    baseEnv(),
    executionContext().ctx,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, any>;
}

describe('discovery document', () => {
  it('serves the identical document at /, /health, and /.well-known/conform.json', async () => {
    const root = await getBody('/');
    const health = await getBody('/health');
    const wellKnown = await getBody('/.well-known/conform.json');
    expect(health).toEqual(root);
    expect(wellKnown).toEqual(root);
  });

  it('describes the workflow an agent needs', async () => {
    const doc = await getBody('/');
    expect(doc.api_version).toBe(spec.info.version);
    expect(doc.base_url).toBe('https://api.conform.test');
    expect(doc.openapi_url).toBe('https://api.conform.test/openapi.json');
    expect(doc.llms_txt).toBe('https://api.conform.test/llms.txt');
    expect(doc.auth).toBe('none');
    expect(doc.verification.human_step_required).toBe(true);
    expect(doc.verification.poll_interval_seconds).toBe(15);
    expect(doc.test_submissions).toEqual({ field: '_test', value: 'true' });
    expect(doc.limits.monthly_submissions_per_inbox).toBe(250);
    expect(doc.persistence.submission_fields).toBe(false);
  });

  it('lists only endpoints that exist in the OpenAPI paths', async () => {
    const doc = await getBody('/');
    const specPaths = Object.keys(spec.paths);
    for (const entry of Object.values(
      doc.endpoints as Record<string, { path: string }>,
    )) {
      const normalized = entry.path
        .split('?')[0]
        .replaceAll('{form_id}', '{formId}');
      expect(specPaths, `${entry.path} missing from openapi.json`).toContain(normalized);
    }
  });

  it('serves an llms.txt that names the endpoints, the human step, and the test field', async () => {
    const response = await worker.fetch(
      new Request('https://api.conform.test/llms.txt'),
      baseEnv(),
      executionContext().ctx,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    const text = await response.text();
    expect(text).toContain('POST /v1/routes');
    expect(text).toContain('/install?framework=');
    expect(text).toContain('_test=true');
    expect(text).toContain('Idempotency-Key');
    expect(text).toContain('https://api.conform.test');
    expect(text).toContain('one monthly allowance');
  });
});
