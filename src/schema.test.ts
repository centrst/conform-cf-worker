import { describe, expect, it, vi } from 'vitest';
import worker from './index';
import { sealToken } from './crypto';
import {
  parseFormSchema,
  validateSubmission,
  type FormSchema,
  type SubmissionError,
} from './schema';
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

function codes(errors: SubmissionError[]) {
  return errors
    .map((error) => ('field' in error ? `${error.field}:${error.code}` : `rule ${error.rule}:${error.code}`))
    .sort();
}

/** The reservation form the 18 Aug 2026 spam was sent to. */
const OAK_AND_ORCHARD: FormSchema = parseFormSchema({
  rules: [
    { when: 'adults + children > 6', reject: 'This property is permitted for 6 guests.' },
    { when: 'check_out <= check_in', reject: 'Check-out must be after check-in.' },
  ],
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
    const blamed = (name: string) =>
      errors.some((error) => 'field' in error && error.field === name);
    expect(blamed('note')).toBe(false);
    expect(blamed('name')).toBe(false);
    expect(blamed('email')).toBe(false);
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

  it('refuses a booking for eleven people into a property permitted for six', () => {
    // Every field is valid and every type is correct: six adults is within the
    // per-field maximum and five children is within theirs. Only the sum is
    // wrong, and only a cross-field rule can see it. This is the refusal that
    // carries legal weight rather than merely tidying an inbox.
    const errors = validateSubmission(OAK_AND_ORCHARD, {
      check_in: '2026-09-04',
      check_out: '2026-09-07',
      adults: '6',
      children: '5',
      name: 'A Real Guest',
      email: 'guest@example.com',
    });

    expect(errors).toEqual([
      {
        rule: 0,
        code: 'rule_violated',
        message: 'This property is permitted for 6 guests.',
      },
    ]);
  });

  it('refuses a stay that ends before it starts', () => {
    // Both dates are real dates. Only the pair of them is wrong.
    expect(
      validateSubmission(OAK_AND_ORCHARD, {
        check_in: '2026-09-07',
        check_out: '2026-09-04',
        adults: '2',
        name: 'A Real Guest',
        email: 'guest@example.com',
      }),
    ).toEqual([{ rule: 1, code: 'rule_violated', message: 'Check-out must be after check-in.' }]);
  });

  it('refuses an occupancy written as a number too large to be one', () => {
    // "1" and 400 zeroes matches the integer shape, is Infinity as a number,
    // and so sailed past both the per-field maximum and the occupancy rule:
    // the range check skipped a value it could not compare, and the rule read
    // the same value as absent, which arithmetic counts as nobody.
    expect(
      codes(
        validateSubmission(OAK_AND_ORCHARD, {
          check_in: '2026-09-04',
          check_out: '2026-09-07',
          adults: `1${'0'.repeat(400)}`,
          children: '5',
          name: 'A Real Guest',
          email: 'guest@example.com',
        }),
      ),
    ).toEqual(['adults:invalid_integer']);
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

describe('cross-field rules', () => {
  const FIELDS = {
    adults: { type: 'integer' },
    children: { type: 'integer' },
    rate: { type: 'number' },
    check_in: { type: 'date' },
    check_out: { type: 'date' },
    starts_at: { type: 'datetime' },
    ends_at: { type: 'datetime' },
    opens: { type: 'time' },
    note: { type: 'text' },
    subscribe: { type: 'boolean' },
    plan: { type: 'choice', options: ['basic', 'pro'] },
    tags: { type: 'text', multiple: true },
  };

  function ruled(when: string): FormSchema {
    return parseFormSchema({
      strict: false,
      fields: FIELDS,
      rules: [{ when, reject: 'no' }],
    });
  }

  function fires(when: string, fields: Record<string, string | string[]>): boolean {
    const errors = validateSubmission(ruled(when), fields);
    // A field error means the rules never ran, so a case that meant to test a
    // rule must not quietly pass on one instead.
    expect(errors.filter((error) => 'field' in error)).toEqual([]);
    return errors.length === 1;
  }

  describe('evaluation', () => {
    const cases: Array<[string, string, Record<string, string | string[]>, boolean]> = [
      ['the occupancy cap, over', 'adults + children > 6', { adults: '6', children: '5' }, true],
      ['the occupancy cap, exactly at it', 'adults + children > 6', { adults: '4', children: '2' }, false],
      ['a number against a literal, not text', 'adults > 9', { adults: '10' }, true],
      ['multiplication before addition', 'adults + children * 2 > 6', { adults: '2', children: '3' }, true],
      ['parentheses overriding it', '(adults + children) * 2 > 6', { adults: '2', children: '1' }, false],
      ['subtraction', 'adults - children > 1', { adults: '5', children: '1' }, true],
      ['a decimal literal', 'rate < 12.5', { rate: '12.4' }, true],
      ['a negative number', 'rate < -1', { rate: '-2' }, true],
      ['dates as text, which is what makes them sort', 'check_out <= check_in', { check_in: '2026-09-07', check_out: '2026-09-04' }, true],
      ['dates in the right order', 'check_out <= check_in', { check_in: '2026-09-04', check_out: '2026-09-07' }, false],
      ['a conditional requirement', 'present(check_in) && !present(check_out)', { check_in: '2026-09-04' }, true],
      ['both halves of it satisfied', 'present(check_in) && !present(check_out)', { check_in: '2026-09-04', check_out: '2026-09-07' }, false],
      ['an empty string counting as absent', 'present(check_in) && !present(check_out)', { check_in: '2026-09-04', check_out: '' }, true],
      ['present on a repeated field', 'present(tags)', { tags: ['a', 'b'] }, true],
      ['a choice compared to a literal', 'plan == "pro" && adults > 4', { plan: 'pro', adults: '5' }, true],
      ['single quotes around a literal', "plan != 'pro'", { plan: 'basic' }, true],
      ['a checked box', 'subscribe && !present(note)', { subscribe: 'on' }, true],
      ['an unchecked box, which a browser omits', '!subscribe', {}, true],
      ['or, on its second operand', 'adults > 6 || children > 4', { adults: '1', children: '5' }, true],
      ['surrounding whitespace on a value', 'note == "hello"', { note: '  hello  ' }, true],
      ['text ordering, which is not only for dates', 'note > "m"', { note: 'zebra' }, true],
      // A datetime is the one text type whose spellings do not sort, and the
      // submitter chooses the spelling — so it is compared as an instant.
      ['a datetime the sender re-spelled to sort the other way', 'ends_at <= starts_at', { starts_at: '2026-06-10T10:00', ends_at: 'Jun 1 2026' }, true],
      ['a datetime pair in the right order', 'ends_at <= starts_at', { starts_at: '2026-06-10T10:00Z', ends_at: '2026-06-10T09:00:00-05:00' }, false],
      ['two spellings of one instant, which is not after it', 'ends_at <= starts_at', { starts_at: '2026-06-10T10:00Z', ends_at: '2026-06-10T05:00:00-05:00' }, true],
      ['a time written without seconds', 'opens == "09:00:00"', { opens: '09:00' }, true],
      ['a time literal written without seconds', 'opens == "09:00"', { opens: '09:00:00' }, true],
      ['a time exactly on the boundary', 'opens > "09:00"', { opens: '09:00' }, false],
      ['a time past the boundary', 'opens > "09:00"', { opens: '09:00:01' }, true],
      ['a datetime against a date, which is a moment too', 'starts_at < check_in', { starts_at: '2026-09-01T10:00Z', check_in: '2026-09-04' }, true],
      ['a datetime against a literal date', 'starts_at < "2026-09-04"', { starts_at: '2026-09-01T10:00Z' }, true],
    ];

    for (const [name, when, fields, expected] of cases) {
      it(`${expected ? 'fires' : 'holds'} on ${name}`, () => {
        expect(fires(when, fields)).toBe(expected);
      });
    }
  });

  describe('a field that was never sent', () => {
    // The two decisions, stated as tests: absent is 0 in arithmetic, and any
    // comparison with an absent operand is false. Between them a bare
    // comparison never fires on a value nobody sent, and present() is how
    // absence is talked about on purpose.
    it('contributes nothing to a sum', () => {
      expect(fires('adults + children > 6', { adults: '7' })).toBe(true);
      expect(fires('adults + children > 6', { adults: '6' })).toBe(false);
    });

    it('answers no to every comparison, including "not equal"', () => {
      expect(fires('children > 0', {})).toBe(false);
      expect(fires('children < 1', {})).toBe(false);
      expect(fires('children == 0', {})).toBe(false);
      expect(fires('children != 0', {})).toBe(false);
    });

    it('survives a minus sign, so -children answers like children', () => {
      expect(fires('-children == 0', {})).toBe(false);
      expect(fires('-children == -2', { children: '2' })).toBe(true);
    });

    it('does not survive arithmetic, which is the price of the occupancy rule', () => {
      // Absent is 0 inside a sum, so a sum is never absent. That is what makes
      // `adults + children > 6` work with children blank, and it is the one
      // place where a rule can fire on a field nobody sent. Pinned, not hidden.
      expect(fires('children + 0 == 0', {})).toBe(true);
      expect(fires('children * 1 == 0', {})).toBe(true);
      expect(fires('adults + children == 0', {})).toBe(true);
    });

    it('does not make a date rule fire by comparing against nothing', () => {
      expect(fires('check_out <= check_in', { check_in: '2026-09-04' })).toBe(false);
    });

    it('is exactly what present() is for', () => {
      expect(fires('!present(children)', {})).toBe(true);
      expect(fires('!present(children)', { children: '0' })).toBe(false);
      expect(fires('present(tags)', { tags: ['', ' '] })).toBe(false);
      expect(fires('present(tags)', { tags: [] })).toBe(false);
    });

    it('leaves an unticked box refusable by "!" but not by comparison', () => {
      // A browser sends nothing for an unticked box. Negation asks about that
      // on purpose; a comparison must not answer it by inventing a false.
      expect(fires('!subscribe', {})).toBe(true);
      expect(fires('!subscribe', { subscribe: 'false' })).toBe(true);
      expect(fires('!subscribe', { subscribe: 'on' })).toBe(false);
      expect(fires('subscribe == present(note)', {})).toBe(false);
      expect(fires('!present(subscribe)', { subscribe: 'false' })).toBe(false);
    });

    it('cannot fire a rule by dividing by it', () => {
      expect(fires('adults / children > 1', { adults: '5' })).toBe(false);
      expect(fires('adults / children > 1', { adults: '5', children: '0' })).toBe(false);
    });
  });

  it('reports every rule that fired, not just the first', () => {
    const schema = parseFormSchema({
      strict: false,
      fields: FIELDS,
      rules: [
        { when: 'adults + children > 6', reject: 'Too many guests.' },
        { when: 'present(check_in) && !present(check_out)', reject: 'Both dates are required.' },
      ],
    });

    expect(validateSubmission(schema, { adults: '6', children: '5', check_in: '2026-09-04' })).toEqual([
      { rule: 0, code: 'rule_violated', message: 'Too many guests.' },
      { rule: 1, code: 'rule_violated', message: 'Both dates are required.' },
    ]);
  });

  it('does not run at all while a field is still wrong', () => {
    // A rule reading a field that failed its own type check would be asking a
    // question of a value the form already refused.
    expect(codes(validateSubmission(ruled('adults + children > 6'), { adults: 'lots', children: '5' }))).toEqual([
      'adults:invalid_integer',
    ]);
  });

  it('stores the expression the customer wrote, not a compiled form', () => {
    // The declaration is what is sealed into the route and what
    // GET /v1/routes/{form_id} publishes, so a rule error's index resolves.
    const rules = [{ when: 'adults > 1', reject: 'Only one.' }];
    expect(parseFormSchema({ fields: FIELDS, rules }).rules).toEqual(rules);
  });

  it('leaves a schema with no rules exactly as it was', () => {
    expect(parseFormSchema({ fields: FIELDS }).rules).toBeUndefined();
    expect(parseFormSchema({ fields: FIELDS, rules: [] }).rules).toBeUndefined();
  });

  describe('refused at declaration, never at submission', () => {
    const bad: Array<[string, unknown]> = [
      ['an identifier that is not a field', 'guests > 1'],
      ['a subtraction written without spaces', 'adults-children > 0'],
      ['present() of an undeclared field', 'present(guests)'],
      ['a repeated field used as a value', 'tags == "a"'],
      ['an expression that is not a question', 'adults + children'],
      ['a bare text field as a question', 'note'],
      ['arithmetic on text', 'note + 1 > 2'],
      ['a number compared with a string', 'adults > "many"'],
      ['a true/false value put in order', 'subscribe > present(note)'],
      ['"!" on a number', '!adults'],
      ['"&&" between numbers', 'adults && children'],
      ['an unclosed parenthesis', '(adults > 1'],
      ['a stray closing parenthesis', 'adults > 1)'],
      ['a trailing operand', 'adults > 1 2'],
      ['a missing operand', 'adults >'],
      ['an operator the language does not have', 'adults % 2 == 0'],
      ['a single ampersand', 'adults > 1 & children > 1'],
      ['a function that is not present()', 'max(adults, 2) > 1'],
      ['present() of something that is not a name', 'present(1)'],
      ['an unclosed string literal', 'note == "abc'],
      ['a number ending in a decimal point', 'adults > 1.'],
      ['an empty expression', '   '],
      ['a number too large to be one', `adults > ${'9'.repeat(400)}`],
      ['a chained comparison', 'adults > 1 > 0'],
      ['a true/false literal', 'subscribe == true'],
      ['a blank string, which can never match', 'note == ""'],
      ['a condition that reads no field at all', '1 > 0'],
      // Object.prototype answers to all of these on a plain object, so without
      // an own-property check they type-checked as undeclared string fields —
      // and `!present(constructor)` would have refused every submission.
      ['a datetime compared with text that is not a moment', 'starts_at > note'],
      ['a datetime compared with a time', 'starts_at > opens'],
      ['a datetime compared with a word', 'starts_at != "never"'],
      ['a datetime compared with a loose literal Date.parse would take', 'starts_at > "6"'],
      ['a date compared with text no date can equal', 'check_in > "banana"'],
      ['a time compared with text no clock can equal', 'opens < "soon"'],
      ['constructor, which is not a field', 'constructor == "x"'],
      ['toString, which is not a field either', '!present(toString)'],
      ['valueOf, same', 'valueOf > "a"'],
      ['hasOwnProperty, same', 'hasOwnProperty == "x"'],
    ];

    for (const [name, when] of bad) {
      it(`refuses ${name}`, () => {
        expect(() =>
          parseFormSchema({ fields: FIELDS, rules: [{ when, reject: 'no' }] }),
        ).toThrow(/^rules\[0\]:/u);
      });
    }

    it('names the rule that is wrong, by the index a violation would carry', () => {
      expect(() =>
        parseFormSchema({
          fields: FIELDS,
          rules: [
            { when: 'adults > 1', reject: 'ok' },
            { when: 'guests > 1', reject: 'no' },
          ],
        }),
      ).toThrow(/^rules\[1\]: "guests" is not a field on this form/u);
    });

    it('refuses a rule that asks about a field the schema already requires', () => {
      // present(x) on a required field is a constant: the field error fires
      // first and the rule never runs. Better to say so than to store a rule
      // that can never have an effect.
      expect(() =>
        parseFormSchema({
          fields: { check_in: { type: 'date' }, check_out: { type: 'date', required: true } },
          rules: [{ when: 'present(check_in) && !present(check_out)', reject: 'no' }],
        }),
      ).toThrow(/already required/u);

      // Optional, and the rule is what requires it: accepted, and it fires.
      const schema = parseFormSchema({
        fields: { check_in: { type: 'date' }, check_out: { type: 'date' } },
        rules: [
          { when: 'present(check_in) && !present(check_out)', reject: 'Both dates are required.' },
        ],
      });
      expect(validateSubmission(schema, { check_in: '2026-09-04' })).toEqual([
        { rule: 0, code: 'rule_violated', message: 'Both dates are required.' },
      ]);
    });

    it('says so when a name was swallowed by a subtraction', () => {
      // Field names may contain "-", so `adults-children` is one name. The
      // message has to say that, or the author reads it as a broken minus.
      expect(() => parseFormSchema({ fields: FIELDS, rules: [{ when: 'adults-children > 0', reject: 'no' }] })).toThrow(
        /needs spaces around it/u,
      );
    });

    it('says which operator was meant by a single ampersand', () => {
      expect(() =>
        parseFormSchema({ fields: FIELDS, rules: [{ when: 'adults > 1 & adults < 9', reject: 'no' }] }),
      ).toThrow(/use "&&", not "&"/u);
    });

    const malformed: Array<[string, unknown]> = [
      ['rules that are not an array', { fields: FIELDS, rules: { when: 'adults > 1' } }],
      ['a rule that is not an object', { fields: FIELDS, rules: ['adults > 1'] }],
      ['a rule with no message', { fields: FIELDS, rules: [{ when: 'adults > 1' }] }],
      ['a rule with an empty message', { fields: FIELDS, rules: [{ when: 'adults > 1', reject: ' ' }] }],
      ['a rule with no expression', { fields: FIELDS, rules: [{ reject: 'no' }] }],
    ];

    for (const [name, schema] of malformed) {
      it(`refuses ${name}`, () => {
        expect(() => parseFormSchema(schema)).toThrow();
      });
    }
  });

  describe('limits, enforced when the schema is set', () => {
    const rule = { when: 'adults > 1', reject: 'no' };

    it('caps the number of rules at 20', () => {
      const twenty = Array.from({ length: 20 }, () => rule);
      expect(() => parseFormSchema({ fields: FIELDS, rules: twenty })).not.toThrow();
      expect(() => parseFormSchema({ fields: FIELDS, rules: [...twenty, rule] })).toThrow(
        /at most 20 rules/u,
      );
    });

    it('caps an expression at 500 characters', () => {
      const long = `adults > 1 ${'|| adults > 2 '.repeat(40)}`;
      expect(long.length).toBeGreaterThan(500);
      expect(() => parseFormSchema({ fields: FIELDS, rules: [{ when: long, reject: 'no' }] })).toThrow(
        /at most 500 characters/u,
      );
    });

    it('caps a rejection message at 200 characters', () => {
      expect(() =>
        parseFormSchema({ fields: FIELDS, rules: [{ when: 'adults > 1', reject: 'x'.repeat(201) }] }),
      ).toThrow(/at most 200 characters/u);
    });

    const accepts = (when: string) =>
      expect(() =>
        parseFormSchema({ fields: FIELDS, rules: [{ when, reject: 'no' }] }),
      ).not.toThrow();
    const refuses = (when: string) =>
      expect(() =>
        parseFormSchema({ fields: FIELDS, rules: [{ when, reject: 'no' }] }),
      ).toThrow(/at most 20 levels deep/u);

    it('measures depth over the whole expression, not only over parentheses', () => {
      // A flat chain of additions nests nothing and still costs 19 levels to
      // evaluate, so it is measured the same way a nested one is.
      accepts(`${'adults + '.repeat(18)}adults > 1`);
      refuses(`${'adults + '.repeat(19)}adults > 1`);

      accepts(`${'!'.repeat(19)}present(adults)`);
      refuses(`${'!'.repeat(20)}present(adults)`);
    });

    it('bounds parentheses separately, because they cost the parser and not the tree', () => {
      // 500 characters of "(" must not overflow the stack, but a parenthesis
      // adds no node to the finished tree, so the depth limit cannot see it.
      accepts(`${'('.repeat(50)}adults${')'.repeat(50)} > 1`);
      expect(() =>
        parseFormSchema({
          fields: FIELDS,
          rules: [{ when: `${'('.repeat(51)}adults${')'.repeat(51)} > 1`, reject: 'no' }],
        }),
      ).toThrow(/not nest more than 50 levels deep/u);
    });
  });

  it('reports a stored rule it cannot read as the Worker’s problem', () => {
    // Unreachable through parseFormSchema, which is the point: if a corrupt
    // schema ever reaches the delivery path it must not be reported as though
    // the submitter got something wrong.
    expect(() =>
      validateSubmission(
        { strict: false, fields: { adults: { type: 'integer' } }, rules: [{ when: 'adults >', reject: 'no' }] },
        { adults: '2' },
      ),
    ).toThrow(/could not be read/u);
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
    // They were accepted and then silently ignored, so a form that wrote
    // {"type":"text","max":500} meaning length was enforcing nothing.
    ['min or max on text', { fields: { a: { type: 'text', max: 500 } } }],
    ['min or max on a date', { fields: { a: { type: 'date', min: 1 } } }],
  ];

  for (const [name, value] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => parseFormSchema(value)).toThrow();
    });
  }

  it('refuses a whole number too large to be checked exactly', () => {
    // Past 2^53 a decimal string and the number it becomes are different
    // values, so nothing downstream — a range check, a rule — can be trusted.
    const schema = parseFormSchema({ strict: false, fields: { n: { type: 'integer' } } });
    expect(validateSubmission(schema, { n: '9007199254740991' })).toEqual([]);
    expect(codes(validateSubmission(schema, { n: '9007199254740993' }))).toEqual([
      'n:invalid_integer',
    ]);
  });

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

  it('refuses a booking every field agrees with and the form does not', async () => {
    const send = vi.fn(async (_message: EmailMessageBuilder) => ({ messageId: 'id' }));
    const routes = new Map<string, StoredRouteRecord>();
    const requests: string[] = [];
    const env = baseEnv({ routes, send, requests });
    await installRoute(env, routes, { schema: OAK_AND_ORCHARD });

    const response = await submit(env, {
      check_in: '2026-09-04',
      check_out: '2026-09-07',
      adults: '6',
      children: '5',
      name: 'A Real Guest',
      email: 'guest@example.com',
    });
    const body = (await response.json()) as any;

    expect(response.status).toBe(422);
    expect(body.error).toBe('submission_invalid');
    expect(body.errors).toEqual([
      { rule: 0, code: 'rule_violated', message: 'This property is permitted for 6 guests.' },
    ]);
    expect(send).not.toHaveBeenCalled();
    expect(requests.some((url) => url.endsWith('/reserve'))).toBe(false);
  });

  it('tells a plain HTML form why, in the words the form’s owner wrote', async () => {
    // A no-JS form gets a page, not JSON. Without the detail the guest is told
    // only that something was wrong, and the message written for exactly this
    // moment never arrives.
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes, { schema: OAK_AND_ORCHARD });

    const response = await fetchWorker(
      new Request(`https://api.conform.test/f/${TEST_FORM_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/html' },
        body: JSON.stringify({
          check_in: '2026-09-04',
          check_out: '2026-09-07',
          adults: '6',
          children: '5',
          name: 'A Real Guest',
          email: 'guest@example.com',
        }),
      }),
      env,
    );
    const page = await response.text();

    expect(response.status).toBe(422);
    expect(page).toContain('This property is permitted for 6 guests.');
  });

  it('carries a schema with rules through settings and back out again', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes);

    const set = await fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}/settings`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await manageToken(env)}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          schema: {
            fields: { adults: { type: 'integer' }, children: { type: 'integer' } },
            rules: [{ when: 'adults + children > 6', reject: 'Six guests, no more.' }],
          },
        }),
      }),
      env,
    );
    expect(set.status).toBe(200);

    const published = (await (
      await fetchWorker(new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}`), env)
    ).json()) as any;
    const refused = (await (await submit(env, { adults: '4', children: '4' })).json()) as any;

    expect(refused.errors).toEqual([
      { rule: 0, code: 'rule_violated', message: 'Six guests, no more.' },
    ]);
    // The index in the error is an index into the array the route publishes.
    expect(published.schema.rules[refused.errors[0].rule].reject).toBe('Six guests, no more.');
  });

  it('does not run rules while an undeclared field is still on the submission', async () => {
    const schema = parseFormSchema({
      fields: { adults: { type: 'integer' }, children: { type: 'integer' } },
      rules: [{ when: 'adults + children > 6', reject: 'Six guests, no more.' }],
    });
    expect(codes(validateSubmission(schema, { adults: '6', children: '5', submit: '' }))).toEqual([
      'submit:unknown_field',
    ]);
  });

  it('publishes the rules, so the index in an error resolves', async () => {
    const routes = new Map<string, StoredRouteRecord>();
    const env = baseEnv({ routes });
    await installRoute(env, routes, { schema: OAK_AND_ORCHARD });

    const response = await fetchWorker(
      new Request(`https://api.conform.test/v1/routes/${TEST_FORM_ID}`),
      env,
    );
    const body = (await response.json()) as any;

    expect(body.schema.rules[0]).toEqual({
      when: 'adults + children > 6',
      reject: 'This property is permitted for 6 guests.',
    });
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
