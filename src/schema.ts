import { ApiError } from './errors';
import { evaluateRules, parseRules, type FormRule, type RuleError } from './rules';
import type { SubmissionFields, SubmissionValue } from './types';

/**
 * A form's declared shape, and the check of a submission against it.
 *
 * This is the difference between a relay and a validator. Without a
 * declaration the endpoint cannot know a form's field names, which are
 * required, or what a plausible value looks like -- so it forwards whatever
 * arrives. With one it can refuse a submission on its merits rather than on
 * its fingerprints, which is the only kind of refusal that stays true as the
 * senders adapt.
 *
 * Everything in this file is a property of a single field. Constraints that
 * span fields ("checkout must follow checkin", "adults + children within the
 * occupancy cap") are `rules`, which live in their own tiny expression
 * language in rules.ts -- kept separate so that a field schema stays a
 * declaration rather than becoming a scripting host.
 */

export const FIELD_TYPES = [
  'text',
  'email',
  'tel',
  'url',
  'integer',
  'number',
  'date',
  'time',
  'datetime',
  'boolean',
  'choice',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  min?: number;
  max?: number;
  min_length?: number;
  max_length?: number;
  pattern?: string;
  options?: string[];
  /** Allows a repeated field (checkbox groups, multi-selects). */
  multiple?: boolean;
}

export interface FormSchema {
  /** Refuse fields the schema does not declare. On unless explicitly disabled. */
  strict: boolean;
  fields: Record<string, FieldSpec>;
  /** Cross-field rules, in declaration order. Absent when the form declares none. */
  rules?: FormRule[];
}

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

/**
 * One `errors` array carries both, and the envelope shape does not change: a
 * field error names a `field`, a rule violation names the `rule` it broke by
 * its index in the published schema. A rule has no single field to blame --
 * that is the whole reason it exists.
 */
export type SubmissionError = FieldError | RuleError;

const MAX_SCHEMA_FIELDS = 100;
const MAX_OPTIONS = 100;
const MAX_PATTERN_LENGTH = 200;
/**
 * The subject a pattern is tested against is truncated to this, never skipped.
 *
 * This cap does NOT bound a pathological pattern, and an earlier comment here
 * claimed it did. `^(a+)+$` against 47 characters backtracks for over a minute;
 * subject length is not the control, the pattern is. See PATTERN_PROBES.
 */
const MAX_PATTERN_SUBJECT = 4096;

/**
 * Probes run only after the structural check below, so they terminate by
 * construction: a pattern with star height 1 backtracks at worst exponentially
 * in the subject, and 24 characters bounds that to a few hundred milliseconds.
 * Timing a regex that might never return is not a check -- it hangs with it.
 */
const PATTERN_PROBES = [
  `${'a'.repeat(24)}!`,
  `${'0'.repeat(24)}!`,
  `${'a '.repeat(12)}!`,
  `${`${'a'.repeat(4)}@`.repeat(4)}!`,
];
const PATTERN_PROBE_BUDGET_MS = 25;

// Leading underscores are reserved for conForm's own fields, so a schema can
// never declare one and `strict` can always exempt them.
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off', '']);

/** True if `body` contains a quantifier outside a character class. */
function containsQuantifier(body: string): boolean {
  let inClass = false;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (inClass) {
      if (character === ']') inClass = false;
      continue;
    }
    if (character === '[') {
      inClass = true;
      continue;
    }
    if (character === '*' || character === '+') return true;
    if (character === '{' && /^\{\d+,\d*\}/u.test(body.slice(index))) return true;
  }
  return false;
}

/**
 * Star height above 1 -- a quantifier applied to a group that itself contains
 * one, as in `(a+)+` or `(?:\d*)*`. Its cost is exponential in the SUBJECT, so
 * no subject cap bounds it: `^(a+)+$` against 47 characters runs for over a
 * minute, and an earlier comment in this file claimed the 4096-character cap
 * made that safe.
 *
 * Checked structurally rather than by timing, because a timed check cannot
 * report on a regex that never returns.
 */
function hasNestedQuantifier(source: string): boolean {
  const opens: number[] = [];
  let inClass = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (inClass) {
      if (character === ']') inClass = false;
      continue;
    }
    if (character === '[') {
      inClass = true;
      continue;
    }
    if (character === '(') {
      opens.push(index);
      continue;
    }
    if (character === ')') {
      const open = opens.pop();
      if (open === undefined) continue;
      const next = source[index + 1];
      // `?` is excluded: `(a+)?` is linear. Only unbounded repetition compounds.
      if (next === '*' || next === '+' || next === '{') {
        if (containsQuantifier(source.slice(open + 1, index))) return true;
      }
    }
  }
  return false;
}

function fail(message: string): never {
  throw new ApiError('invalid_schema', message);
}

function readNumber(spec: Record<string, unknown>, key: string, name: string): number | undefined {
  const value = spec[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`Field "${name}": ${key} must be a number`);
  }
  return value;
}

/** Validates a declaration. Runs at configuration time, never on the delivery path. */
export function parseFormSchema(value: unknown): FormSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('schema must be an object');
  }
  const raw = value as Record<string, unknown>;

  if (raw.strict !== undefined && typeof raw.strict !== 'boolean') {
    fail('schema.strict must be a boolean');
  }
  if (!raw.fields || typeof raw.fields !== 'object' || Array.isArray(raw.fields)) {
    fail('schema.fields must be an object');
  }

  const rawFields = raw.fields as Record<string, unknown>;
  const names = Object.keys(rawFields);
  if (names.length === 0) fail('schema.fields must declare at least one field');
  if (names.length > MAX_SCHEMA_FIELDS) {
    fail(`schema.fields may declare at most ${MAX_SCHEMA_FIELDS} fields`);
  }

  const fields: Record<string, FieldSpec> = {};
  for (const name of names) {
    if (!FIELD_NAME.test(name)) {
      fail(
        `Field "${name}": names start with a letter and use letters, digits, "_", "." or "-" ` +
          '(leading underscores are reserved for conForm)',
      );
    }
    const entry = rawFields[name];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`Field "${name}": must be an object`);
    }
    const spec = entry as Record<string, unknown>;

    const type = spec.type === undefined ? 'text' : spec.type;
    if (typeof type !== 'string' || !(FIELD_TYPES as readonly string[]).includes(type)) {
      fail(`Field "${name}": type must be one of ${FIELD_TYPES.join(', ')}`);
    }
    for (const flag of ['required', 'multiple'] as const) {
      if (spec[flag] !== undefined && typeof spec[flag] !== 'boolean') {
        fail(`Field "${name}": ${flag} must be a boolean`);
      }
    }

    const min = readNumber(spec, 'min', name);
    const max = readNumber(spec, 'max', name);
    const minLength = readNumber(spec, 'min_length', name);
    const maxLength = readNumber(spec, 'max_length', name);
    if (min !== undefined && max !== undefined && min > max) {
      fail(`Field "${name}": min is greater than max`);
    }
    if ((min !== undefined || max !== undefined) && type !== 'integer' && type !== 'number') {
      // They were silently ignored on every other type, so a form declaring
      // {"type":"text","max":500} meaning length was enforcing nothing at all.
      fail(
        `Field "${name}": min and max apply to integer and number fields; ` +
          'use min_length and max_length to bound text',
      );
    }
    if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
      fail(`Field "${name}": min_length is greater than max_length`);
    }

    let pattern: string | undefined;
    if (spec.pattern !== undefined) {
      if (typeof spec.pattern !== 'string') fail(`Field "${name}": pattern must be a string`);
      if (spec.pattern.length > MAX_PATTERN_LENGTH) {
        fail(`Field "${name}": pattern may be at most ${MAX_PATTERN_LENGTH} characters`);
      }
      let compiled: RegExp;
      try {
        compiled = new RegExp(spec.pattern, 'u');
      } catch {
        fail(`Field "${name}": pattern is not a valid regular expression`);
      }
      if (hasNestedQuantifier(spec.pattern)) {
        fail(
          `Field "${name}": pattern nests a quantifier inside a quantified group ` +
            '(such as (a+)+), which backtracks catastrophically. Rewrite it without ' +
            'the inner repetition.',
        );
      }
      for (const probe of PATTERN_PROBES) {
        const started = Date.now();
        compiled.test(probe);
        if (Date.now() - started > PATTERN_PROBE_BUDGET_MS) {
          fail(
            `Field "${name}": pattern backtracks catastrophically on ordinary input. ` +
              'Avoid a quantifier inside a quantified group, such as (a+)+ or (a|a)*.',
          );
        }
      }
      pattern = spec.pattern;
    }

    let options: string[] | undefined;
    if (spec.options !== undefined) {
      if (!Array.isArray(spec.options) || spec.options.some((o) => typeof o !== 'string')) {
        fail(`Field "${name}": options must be an array of strings`);
      }
      if (spec.options.length === 0) fail(`Field "${name}": options must not be empty`);
      if (spec.options.length > MAX_OPTIONS) {
        fail(`Field "${name}": at most ${MAX_OPTIONS} options`);
      }
      options = spec.options as string[];
    }
    if (type === 'choice' && !options) {
      fail(`Field "${name}": a choice field needs options`);
    }

    fields[name] = {
      type: type as FieldType,
      ...(spec.required === true ? { required: true } : {}),
      ...(spec.multiple === true ? { multiple: true } : {}),
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
      ...(minLength === undefined ? {} : { min_length: minLength }),
      ...(maxLength === undefined ? {} : { max_length: maxLength }),
      ...(pattern === undefined ? {} : { pattern }),
      ...(options === undefined ? {} : { options }),
    };
  }

  // Rules are typed against the fields above, so an expression can only ever
  // mention a field this schema declares.
  const rules = raw.rules === undefined ? undefined : parseRules(raw.rules, fields);

  return { strict: raw.strict !== false, fields, ...(rules?.length ? { rules } : {}) };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/u;

function isRealDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isRealTime(value: string): boolean {
  if (!TIME.test(value)) return false;
  const [hours, minutes, seconds] = value.split(':').map(Number);
  return hours < 24 && minutes < 60 && (seconds === undefined || seconds < 60);
}

function checkType(value: string, spec: FieldSpec): FieldError['code'] | undefined {
  switch (spec.type) {
    case 'email':
      // Same shape the reply-to path accepts, so a form cannot declare an
      // address the delivery layer would then refuse to use.
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) && value.length <= 254
        ? undefined
        : 'invalid_email';
    case 'tel':
      // Deliberately loose: numbering plans vary and a strict pattern turns
      // away real people. A form that needs a shape declares one.
      return /^[+()\d][\d\s().-]{4,31}$/u.test(value) ? undefined : 'invalid_tel';
    case 'url':
      try {
        const parsed = new URL(value);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:'
          ? undefined
          : 'invalid_url';
      } catch {
        return 'invalid_url';
      }
    case 'integer':
      // Digits alone are not enough. "1" followed by 400 zeroes matches the
      // shape, becomes Infinity as a number, and then slips past min/max and
      // reads as absent to a cross-field rule -- so a value that cannot be
      // held exactly is not an integer this form can reason about.
      return /^[+-]?\d+$/u.test(value) && Number.isSafeInteger(Number(value))
        ? undefined
        : 'invalid_integer';
    case 'number':
      return value.trim() !== '' && Number.isFinite(Number(value))
        ? undefined
        : 'invalid_number';
    case 'date':
      return isRealDate(value) ? undefined : 'invalid_date';
    case 'time':
      return isRealTime(value) ? undefined : 'invalid_time';
    case 'datetime':
      return Number.isFinite(Date.parse(value)) ? undefined : 'invalid_datetime';
    case 'boolean':
      // An unchecked checkbox sends nothing and a checked one sends "on", so
      // both spellings have to be accepted or every checkbox form fails.
      return TRUE_VALUES.has(value.toLowerCase()) || FALSE_VALUES.has(value.toLowerCase())
        ? undefined
        : 'invalid_boolean';
    default:
      return undefined;
  }
}

function checkValue(name: string, value: string, spec: FieldSpec): FieldError[] {
  const errors: FieldError[] = [];
  const push = (code: string, message: string) => errors.push({ field: name, code, message });

  const typeError = checkType(value, spec);
  if (typeError) {
    push(typeError, `"${name}" is not a valid ${spec.type}`);
    // Range and length checks against a value of the wrong type would only
    // restate the same problem in a second, more confusing error.
    return errors;
  }

  if (spec.options && !spec.options.includes(value)) {
    push('not_an_option', `"${name}" must be one of the allowed options`);
  }
  if (spec.min_length !== undefined && value.length < spec.min_length) {
    push('too_short', `"${name}" must be at least ${spec.min_length} characters`);
  }
  if (spec.max_length !== undefined && value.length > spec.max_length) {
    push('too_long', `"${name}" must be at most ${spec.max_length} characters`);
  }
  // min/max belong to the numeric types, and parseFormSchema refuses them
  // anywhere else. A value that reaches here has already passed its type
  // check, so it is a finite number and there is nothing left to skip.
  if (spec.min !== undefined || spec.max !== undefined) {
    const numeric = Number(value);
    if (spec.min !== undefined && numeric < spec.min) {
      push('below_minimum', `"${name}" must be at least ${spec.min}`);
    }
    if (spec.max !== undefined && numeric > spec.max) {
      push('above_maximum', `"${name}" must be at most ${spec.max}`);
    }
  }
  if (spec.pattern !== undefined) {
    // Truncate, never skip. Skipping above the cap made every `pattern`
    // bypassable by padding the value past it -- and MAX_FIELD_LENGTH defaults
    // to 20000, five times the cap. Truncating fails closed: an anchored
    // pattern stops matching, which is the right direction for a validator.
    if (!patternFor(spec.pattern).test(value.slice(0, MAX_PATTERN_SUBJECT))) {
      push('pattern_mismatch', `"${name}" is not in the expected format`);
    }
  }
  return errors;
}

/**
 * Patterns are recompiled per request, because the schema is decrypted out of
 * the route token on every submission. Cheap, but not free, and the same few
 * sources recur forever.
 */
const patternCache = new Map<string, RegExp>();

function patternFor(source: string): RegExp {
  const cached = patternCache.get(source);
  if (cached) return cached;
  const compiled = new RegExp(source, 'u');
  if (patternCache.size < 256) patternCache.set(source, compiled);
  return compiled;
}

function values(value: SubmissionValue): string[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Checks a submission against a declaration.
 *
 * Empty counts as absent for `required`, which is the whole point: a browser
 * omits a disabled input entirely, so a required field arriving as an empty
 * string is a sender that assembled the body from the page source rather than
 * from a form. Treating "" as present would let exactly that through.
 *
 * Cross-field rules run only once every field has passed. A rule reading a
 * field that failed its own type check would be asking a question of a value
 * the form already refused, and the answer would be noise on top of an error
 * the submitter must fix first anyway.
 */
export function validateSubmission(
  schema: FormSchema,
  fields: SubmissionFields,
): SubmissionError[] {
  const errors: FieldError[] = [];

  for (const [name, spec] of Object.entries(schema.fields)) {
    const raw = Object.hasOwn(fields, name) ? fields[name] : undefined;
    const present = raw !== undefined && values(raw).some((entry) => entry.trim() !== '');

    if (!present) {
      if (spec.required) {
        errors.push({
          field: name,
          code: 'required',
          message: `"${name}" is required`,
        });
      }
      continue;
    }

    const entries = values(raw);
    if (entries.length > 1 && !spec.multiple) {
      errors.push({
        field: name,
        code: 'too_many_values',
        message: `"${name}" accepts a single value`,
      });
      continue;
    }
    for (const entry of entries) {
      if (entry.trim() === '') continue;
      errors.push(...checkValue(name, entry, spec));
    }
  }

  if (schema.strict) {
    for (const name of Object.keys(fields)) {
      // Reserved for conForm, and exempt as the field-name rule promises. This
      // also covers the tracking fields a page adds without telling the form
      // (_utm_source and friends), which a strict form used to reject.
      if (name.startsWith('_')) continue;
      // `Object.hasOwn`, not `=== undefined`. The schema arrives via JSON.parse
      // out of the sealed token, so it carries Object.prototype: a field named
      // `constructor`, `toString` or `valueOf` resolved to an inherited member
      // and was waved through as declared. Building the object with
      // Object.create(null) would not help -- the JSON round trip undoes it.
      if (!Object.hasOwn(schema.fields, name)) {
        errors.push({
          field: name,
          code: 'unknown_field',
          message: `"${name}" is not a field on this form`,
        });
      }
    }
  }

  if (errors.length > 0 || !schema.rules) return errors;

  return evaluateRules(schema.rules, schema.fields, fields);
}
