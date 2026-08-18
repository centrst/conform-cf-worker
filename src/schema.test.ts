import { describe, expect, it, vi } from 'vitest';
import worker from './index';
import { sealToken } from './crypto';
import { parseFormSchema, validateSubmission, type FormSchema } from './schema';
import { TEST_FORM_ID, baseEnv, executionContext, installRoute } from './test-support';
import type { EmailMessageBuilder, Env, StoredRouteRecord } from './types';

const OWNER = 'opaque-owner';

function fetchWorker(request: Request, env: Env) {
  return worker.fetch(request, env, executionContext().ctx);
}

function submit(env: Env, body: Record<string, unknown>) {
  return fetchWorker(
    new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  );
}

async function manageToken(env: Env) {
  return sealToken(
    { kind: 'manage', version: 1, routeId: TEST_FORM_ID, ownerId: OWNER, issuedAt: Date.now() },
    env.ROUTE_TOKEN_SECRET,
  );
}

function codes(errors: Array<{ field: string; code: string }>) {
  return errors.map((error) => `${error.field}:${error.code}`).sort();
}

/** The reservation form the 18 Aug 2026 spam was sent to. */
const OAK_AND_ORCHARD: FormSchema = parseFormSchema({
  fields: {
    check_in: { type: 'date', required: true },
    check_out: { type: 'date', required: true },
    nights: { type: 'integer', min: 1, max: 60 },
    adults: { type: 'integer', required: true, min: 1, max: 6 },
    children: { type: 'integer', min: 0, max: 5 },
    infants: { type: 'integer', min: 0, max: 4 },
    name: { type: 'text', required: true, max_length: 120 },
    email: { type: 'email', required: true },
    phone: { type: 'tel' },
    note: { type: 'text', max_length: 2000 },
  },
});

describe('the submission that started this', () => {
  // Exactly as delivered at 07:58 on 18 Aug 2026.
  const SPAM = {
    check_in: '',
    check_out: '',
    nights: '',
    adults: '5',
    children: '1',
    infants: '4',
    name: 'RobertDycle',
    email: 'henrydixon487@gmail.com',
    phone: '86473836421',
    note: 'Sveiki, aš norėjau sužinoti jūsų kainą.',
    submit: '',
  };

  it('is refused on its merits, not its fingerprints', () => {
    const errors = validateSubmission(OAK_AND_ORCHARD, SPAM);

    // Two required dates arriving empty, and a field the form does not have.
    expect(codes(errors)).toEqual([
      'check_in:required',
      'check_out:required',
      'submit:unknown_field',
    ]);
  });

  it('does not judge the note, which is a real language', () => {
    // The note was Lithuanian. So is a real Lithuanian guest's.
    const errors = validateSubmission(OAK_AND_ORCHARD, SPAM);
    expect(errors.some((error) => error.field === 'note')).toBe(false);
    expect(errors.some((error) => error.field === 'name')).toBe(false);
    expect(errors.some((error) => error.field === 'email')).toBe(false);
  });

  it('accepts the same shape from a real guest', () => {
    expect(
      validateSubmission(OAK_AND_ORCHARD, {
        check_in: '2026-09-04',
        check_out: '2026-09-07',
        nights: '3',
        adults: '2',
        children: '1',
        infants: '0',
        name: 'A Real Guest',
        email: 'guest@example.com',
        phone: '+1 303 555 0101',
        note: 'Arriving late on the Friday.',
      }),
    ).toEqual([]);
  });

  it('still takes a booking for ten people — that needs a cross-field rule', () => {
    // adults + children within the occupancy cap is not a property of any one
    // field, so it is deliberately out of reach here. Documented, not forgotten.
    expect(
      validateSubmission(OAK_AND_ORCHARD, {
        check_in: '2026-09-04',
        check_out: '2026-09-07',
        adults: '6',
        children: '5',
        name: 'A Real Guest',
        email: 'guest@example.com',
      }),
    ).toEqual([]);
  });
});

describe('validation rules', () => {
  const schema = parseFormSchema({
    fields: {
      count: { type: 'integer', min: 1, max: 10 },
      amount: { type: 'number' },
      when: { type: 'date' },
      at: { type: 'time' },
      site: { type: 'url' },
      subscribe: { type: 'boolean' },
      plan: { type: 'choice', options: ['basic', 'pro'] },
      code: { type: 'text', pattern: '^[A-Z]{3}-\\d{4}$' },
      note: { type: 'text', min_length: 5, max_length: 10 },
      tags: { type: 'text', multiple: true },
    },
  });

  const cases: Array<[string, Record<string, string | string[]>, string[]]> = [
    ['a whole number', { count: '5' }, []],
    ['a fraction where an integer is declared', { count: '1.5' }, ['count:invalid_integer']],
    ['below the minimum', { count: '0' }, ['count:below_minimum']],
    ['above the maximum', { count: '11' }, ['count:above_maximum']],
    ['a decimal number', { amount: '12.5' }, []],
    ['a real date', { when: '2026-02-28' }, []],
    ['a date that does not exist', { when: '2026-02-31' }, ['when:invalid_date']],
    ['a made-up month', { when: '2026-13-01' }, ['when:invalid_date']],
    ['a valid time', { at: '23:59' }, []],
    ['an impossible hour', { at: '25:00' }, ['at:invalid_time']],
    ['an https url', { site: 'https://example.com' }, []],
    ['a javascript: url', { site: 'javascript:alert(1)' }, ['site:invalid_url']],
    ['a checked checkbox', { subscribe: 'on' }, []],
    ['an explicit false', { subscribe: 'false' }, []],
    ['a word that is not a boolean', { subscribe: 'maybe' }, ['subscribe:invalid_boolean']],
    ['a declared option', { plan: 'pro' }, []],
    ['an option not on the list', { plan: 'enterprise' }, ['plan:not_an_option']],
    ['a value matching the pattern', { code: 'ABC-1234' }, []],
    ['a value that does not match', { code: 'abc-1234' }, ['code:pattern_mismatch']],
    ['a value inside the length bounds', { note: 'hello' }, []],
    ['a value below min_length', { note: 'hi' }, ['note:too_short']],
    ['a value above max_length', { note: 'far too long here' }, ['note:too_long']],
    ['repeats on a multiple field', { tags: ['a', 'b'] }, []],
    ['repeats on a single-value field', { note: ['hello', 'there'] }, ['note:too_many_values']],
  ];

  for (const [name, fields, expected] of cases) {
    it(`accepts or refuses ${name}`, () => {
      expect(codes(validateSubmission({ ...schema, strict: false }, fields))).toEqual(expected);
    });
  }

  it('reports one error per field rather than restating a bad type', () => {
    // A value that is not an integer cannot also be meaningfully out of range.
    const errors = validateSubmission({ ...schema, strict: false }, { count: 'many' });
    expect(codes(errors)).toEqual(['count:invalid_integer']);
  });

  it('treats an empty optional field as absent, not as a bad value', () => {
    expect(validateSubmission({ ...schema, strict: false }, { when: '', count: '' })).toEqual([]);
  });

  it('exempts conForm’s own fields from strict mode', () => {
    // parseSubmission strips these before validation, so they can never be
    // reported as unknown even on a strict form.
    const strict = parseFormSchema({ fields: { name: { type: 'text' } } });
    expect(validateSubmission(strict, { name: 'ok' })).toEqual([]);
  });
});

describe('schema declarations', () => {
  const bad: Array<[string, unknown]> = [
    ['a non-object', 'nope'],
    ['no fields', { fields: {} }],
    ['an unknown type', { fields: { a: { type: 'colour' } } }],
    ['a leading underscore', { fields: { _test: { type: 'text' } } }],
    ['a name starting with a digit', { fields: { '1a': { type: 'text' } } }],
    ['min above max', { fields: { a: { type: 'integer', min: 5, max: 1 } } }],
    ['an uncompilable pattern', { fields: { a: { type: 'text', pattern: '([' } } }],
    ['a choice with no options', { fields: { a: { type: 'choice' } } }],
    ['options that are not strings', { fields: { a: { type: 'choice', options: [1] } } }],
    ['a non-boolean required', { fields: { a: { type: 'text', required: 'yes' } } }],
  ];

  for (const [name, value] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => parseFormSchema(value)).toThrow();
    });
  }

  it('defaults to text and to strict', () => {
    const schema = parseFormSchema({ fields: { a: {} } });
    expect(schema.fields.a.type).toBe('text');
    expect(schema.strict).toBe(true);
  });

  it('allows strict to be turned off explicitly', () => {
    expect(parseFormSchema({ strict: false, fields: { a: {} } }).strict).toBe(false);
  });

  it('caps a pattern rather than accepting an arbitrary one', () => {
    expect(() =>
      parseFormSchema({ fields: { a: { type: 'text', pattern: 'a'.repeat(500) } } }),
    ).toThrow();
  });
});

describe('schema over the wire', () => {
  it('refuses a bad declaration at creation instead of at submission', async () => {
    const response = await fetchWorker(
      new Request('https://api.conform.test/v1/routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'owner@example.com',
          alias: 'Contact',
          schema: { fields: { name: { type: 'nope' } } },
        }),
      }),
      baseEnv(),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toBe('invalid_schema');
  });

  it('refuses a submission that does not match, with per-field detail', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const requests: string[] = [];
    const env = baseEnv({ routes, send, requests });
    await installRoute(env, routes, { schema: OAK_AND_ORCHARD });

    const response = await submit(env, {
      adults: '5',
      name: 'RobertDycle',
      email: 'henrydixon487@gmail.com',
      submit: '',
    });
    const body = (await response.json()) as any;

    expect(response.status).toBe(422);
    expect(body.error).toBe('submission_invalid');
    expect(codes(body.errors)).toEqual([
      'check_in:required',
      'check_out:required',
      'submit:unknown_field',
    ]);
    expect(send).not.toHaveBeenCalled();
    // The refusal costs the owner nothing: validation precedes the reservation.
    expect(requests.some((url) => url.endsWith('/reserve'))).toBe(false);
  });

  it('delivers a submission that matches', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, send });
    await installRoute(env, routes, { schema: OAK_AND_ORCHARD });

    const response = await submit(env, {
      check_in: '2026-09-04',
      check_out: '2026-09-07',
      adults: '2',
      name: 'A Real Guest',
      email: 'guest@example.com',
    });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it('leaves a route with no schema behaving exactly as before', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes, send });
    await installRoute(env, routes);

    const response = await submit(env, { anything: 'at all', submit: '' });

    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledOnce();
  });

  it('publishes the declared shape on the route, so an agent can read it', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes, { schema: OAK_AND_ORCHARD });

    const response = await fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}`),
      env,
    );
    const body = (await response.json()) as any;

    expect(body.schema.fields.check_in).toEqual({ type: 'date', required: true });
    expect(body.schema.strict).toBe(true);
  });
});

describe('schema entitlement', () => {
  async function setSchema(env: Env, schema: unknown) {
    return fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}/settings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await manageToken(env)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ schema }),
      }),
      env,
    );
  }

  it('refuses to attach a schema on a free inbox', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = { ...baseEnv({ routes }), PLAN_ENFORCEMENT: 'true' };
    await installRoute(env, routes);

    const response = await setSchema(env, { fields: { name: { type: 'text' } } });

    expect(response.status).toBe(403);
    expect(((await response.json()) as any).error).toBe('schema_unavailable');
  });

  it('attaches and then enforces a schema on a plus inbox', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = {
      ...baseEnv({ routes, send, plan: { plan: 'plus', monthly_limit: 250 } }),
      PLAN_ENFORCEMENT: 'true',
    };
    await installRoute(env, routes);

    expect((await setSchema(env, { fields: { name: { type: 'text', required: true } } })).status)
      .toBe(200);

    const refused = await submit(env, { name: '' });
    expect(refused.status).toBe(422);

    const delivered = await submit(env, { name: 'ok' });
    expect(delivered.status).toBe(200);
  });

  it('clears a schema with null and stops enforcing', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = {
      ...baseEnv({ routes, plan: { plan: 'plus', monthly_limit: 250 } }),
      PLAN_ENFORCEMENT: 'true',
    };
    await installRoute(env, routes);

    await setSchema(env, { fields: { name: { type: 'text', required: true } } });
    expect((await submit(env, { other: 'x' })).status).toBe(422);

    expect((await setSchema(env, null)).status).toBe(200);
    expect((await submit(env, { other: 'x' })).status).toBe(200);
  });

  it('does not gate a deployment that bills nobody', async () => {
    // This Worker is MIT and meant to be run by other people. Gating by default
    // would refuse the feature permanently to anyone running it themselves,
    // with no way to grant themselves the plan that unlocks it.
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);

    const response = await setSchema(env, { fields: { name: { type: 'text' } } });

    expect(response.status).toBe(200);
  });

  it('does not gate on a dashboard alone', async () => {
    // ACCOUNT_LOOKUP_SECRET says a dashboard exists, not that anyone is being
    // charged. Someone can want route listings without selling anything.
    const routes = new Map<string, StoredRouteRecord>();
    const env: Env = { ...baseEnv({ routes }), ACCOUNT_LOOKUP_SECRET: 'broker' };
    await installRoute(env, routes);

    expect((await setSchema(env, { fields: { name: { type: 'text' } } })).status).toBe(200);
  });

  it('keeps enforcing a schema attached before a plan lapsed', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    // Free plan, schema already on the route: turning a form's own rules off
    // silently would be a worse failure than anything they prevent.
    const env = baseEnv({ routes });
    await installRoute(env, routes, {
      schema: parseFormSchema({ fields: { name: { type: 'text', required: true } } }),
    });

    expect((await submit(env, { name: '' })).status).toBe(422);
  });
});
