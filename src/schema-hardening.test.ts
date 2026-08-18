import { describe, expect, it } from 'vitest';
import { parseFormSchema, validateSubmission } from './schema';

/**
 * Each test here is named after a property a comment in schema.ts asserts.
 * All four were claimed in prose, none held, and none had a test — which is
 * how they drifted. The assertion that proves a stated property belongs
 * beside the property.
 */
describe('properties schema.ts claims', () => {
  it('refuses a pattern that backtracks catastrophically, at declaration time', () => {
    expect(() =>
      parseFormSchema({ fields: { a: { type: 'text', pattern: '^(a+)+$' } } }),
    ).toThrow(/backtracks catastrophically/u);
    expect(() =>
      parseFormSchema({ fields: { a: { type: 'text', pattern: '^(?:\\d*)*$' } } }),
    ).toThrow(/backtracks catastrophically/u);
    // Alternation with overlapping branches has star height 1, so the
    // structural check misses it and the timed probes catch it instead.
    expect(() =>
      parseFormSchema({ fields: { a: { type: 'text', pattern: '^(a|a)*$' } } }),
    ).toThrow(/backtracks catastrophically/u);
  });

  it('accepts alternation whose branches do not overlap', () => {
    expect(() =>
      parseFormSchema({ fields: { a: { type: 'text', pattern: '^(cat|dog)+$' } } }),
    ).not.toThrow();
  });

  it('still accepts an ordinary pattern', () => {
    const schema = parseFormSchema({
      fields: { code: { type: 'text', pattern: '^[A-Z]{3}-\\d{4}$' } },
    });
    expect(validateSubmission({ ...schema, strict: false }, { code: 'ABC-1234' })).toEqual([]);
  });

  it('applies a pattern regardless of value length', () => {
    // Skipping above MAX_PATTERN_SUBJECT made every pattern bypassable by
    // padding, and MAX_FIELD_LENGTH is five times that cap.
    const schema = parseFormSchema({
      fields: { code: { type: 'text', pattern: '^\\d{5}$' } },
    });
    for (const length of [15, 5000, 19000]) {
      expect(
        validateSubmission({ ...schema, strict: false }, { code: 'x'.repeat(length) })
          .map((error) => error.code),
        `length ${length}`,
      ).toContain('pattern_mismatch');
    }
  });

  it('flags a field named after an Object.prototype member', () => {
    const schema = parseFormSchema({ fields: { name: { type: 'text' } } });
    const flagged = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];
    for (const name of flagged) {
      const fields = Object.create(null);
      fields.name = 'ok';
      fields[name] = 'payload';
      expect(
        validateSubmission(schema, fields).flatMap((error) =>
          'field' in error ? [error.field] : [],
        ),
        name,
      ).toEqual([name]);
    }
  });

  it('survives a schema that round-tripped through JSON, as the sealed token does', () => {
    // The fix cannot live in parseFormSchema: the schema is JSON.parse'd out of
    // the route token on every submission, which restores Object.prototype.
    const schema = JSON.parse(
      JSON.stringify(parseFormSchema({ fields: { name: { type: 'text' } } })),
    );
    const fields = Object.create(null);
    fields.name = 'ok';
    fields.toString = 'payload';
    expect(validateSubmission(schema, fields).map((e) => e.code)).toEqual(['unknown_field']);
  });

  it('exempts conForm-reserved underscore fields from strict mode', () => {
    const schema = parseFormSchema({ fields: { name: { type: 'text' } } });
    expect(
      validateSubmission(schema, { name: 'x', _utm_source: 'ads', _hp: '' }),
    ).toEqual([]);
  });

  it('still flags an ordinary undeclared field', () => {
    const schema = parseFormSchema({ fields: { name: { type: 'text' } } });
    expect(validateSubmission(schema, { name: 'x', submit: '' }).map((e) => e.code)).toEqual([
      'unknown_field',
    ]);
  });
});
