import { ApiError } from './errors';
import type { FieldSpec, FieldType } from './schema';
import type { SubmissionFields } from './types';

/**
 * Cross-field rules: the one constraint a per-field schema cannot express.
 *
 * A field schema refuses the 18 Aug spam and still accepts a real guest
 * booking eleven people into a property permitted for six, because occupancy
 * is not a property of `adults` or of `children` -- it is a property of their
 * sum. That is what this is for, and it is the check that carries legal
 * weight rather than merely tidying an inbox.
 *
 * The language is deliberately tiny and stays that way: field references,
 * number and string literals, `+ - * /`, the six comparisons, `&& || !`,
 * parentheses, and exactly one function, `present()`. No string manipulation,
 * no loops, no regular expressions, no property access, no user-defined
 * functions. Conditional requirement is a cross-field rule
 * (`present(check_in) && !present(check_out)`), so it needs no second
 * construct.
 *
 * There is a tokenizer, a recursive-descent parser, and a plain interpreter
 * over the resulting AST. There is no `eval` and no `new Function` anywhere:
 * this is a public endpoint, and compiling caller-supplied text into code
 * would be a remote code execution hole regardless of how the text was
 * validated first.
 *
 * Everything that can be wrong is wrong at declaration time. Syntax, the
 * limits, unknown identifiers, and the types of every operand are checked
 * when the schema is set -- so a rule that parsed cannot surprise a
 * submission later, and the only thing left to decide at runtime is what an
 * absent field means.
 */

const MAX_RULES = 20;
const MAX_EXPRESSION_LENGTH = 500;
const MAX_EXPRESSION_DEPTH = 20;
const MAX_REJECT_LENGTH = 200;

/**
 * The parser's own stack guard, and a separate thing from the depth limit.
 *
 * Parentheses cost the parser a frame but add nothing to the finished tree, so
 * MAX_EXPRESSION_DEPTH does not bound them and something has to: 500
 * characters of "(" must not overflow the stack.
 *
 * It is deliberately not the same number as the declared limit. Limits belong
 * to the declaration -- checked once, when the schema is set -- and if the
 * parser re-imposed MAX_EXPRESSION_DEPTH on every read, lowering that constant
 * in a later deploy would brick every form already carrying a deeper rule: a
 * 500 on every submission, forever, and nothing to tell the owner why. This
 * one is re-imposed on every read, because it is what keeps the stack safe --
 * so it may be raised freely and must never be lowered.
 */
const MAX_PARSE_DEPTH = 50;

/** Published in discovery so an agent can write a schema that will be accepted. */
export const RULE_LIMITS = {
  rules_per_form: MAX_RULES,
  expression_characters: MAX_EXPRESSION_LENGTH,
  /** Depth of the whole expression, so a long `+` or `&&` chain counts too. */
  expression_depth: MAX_EXPRESSION_DEPTH,
  reject_characters: MAX_REJECT_LENGTH,
} as const;

/** A rule as the customer wrote it. The declaration is what is stored and published. */
export interface FormRule {
  /** A boolean expression. The rule fires when it is true. */
  when: string;
  /** The message the submitter sees when it fires. */
  reject: string;
}

export interface RuleError {
  /** Index into `schema.rules`, which `GET /v1/routes/{form_id}` publishes. */
  rule: number;
  code: 'rule_violated';
  message: string;
}

export type Expr =
  | { kind: 'literal'; value: number | string }
  | { kind: 'field'; name: string }
  | { kind: 'present'; name: string }
  | { kind: 'not'; operand: Expr }
  | { kind: 'negate'; operand: Expr }
  | { kind: 'arith'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr }
  | { kind: 'compare'; op: '>' | '>=' | '<' | '<=' | '==' | '!='; left: Expr; right: Expr }
  | { kind: 'logic'; op: '&&' | '||'; left: Expr; right: Expr };

/**
 * The three value types the language has. A field's declared type fixes which
 * one it is, so an expression's shape is known before any submission arrives.
 * Dates and times are strings: the ISO forms an HTML date input produces sort
 * correctly under a string comparison, which is what makes
 * `check_out <= check_in` work. A `datetime` is the exception -- its spellings
 * do not sort, so comparisons involving one compare instants. See `comparisonKind`.
 */
type StaticType = 'number' | 'string' | 'boolean';

/** How a comparison reads its operands. See comparisonKind. */
type ComparisonKind = 'instant' | 'clock' | 'plain';

/** Absent is `null`, for every type including `boolean`; see `readField`. */
type Value = number | string | boolean | null;

type Fail = (message: string) => never;

const IDENT_START = /[A-Za-z]/u;
// Field names may contain "-" and ".", so an identifier swallows them. That
// makes `a-b` one name rather than a subtraction, which is why an unknown
// identifier containing "-" says so out loud.
const IDENT_PART = /[A-Za-z0-9_.-]/u;
const DIGIT = /[0-9]/u;
const SPACE = /\s/u;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);

type Token =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string }
  | { kind: 'end'; value: 'end of expression' };

// "," is tokenized only so that `max(a, b)` is reported as an unknown function
// rather than as a stray character.
const OPERATORS = [
  '&&',
  '||',
  '==',
  '!=',
  '>=',
  '<=',
  '>',
  '<',
  '+',
  '-',
  '*',
  '/',
  '!',
  '(',
  ')',
  ',',
];

function tokenize(source: string, fail: Fail): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (SPACE.test(char)) {
      index += 1;
      continue;
    }

    if (DIGIT.test(char)) {
      let end = index;
      while (end < source.length && DIGIT.test(source[end])) end += 1;
      if (source[end] === '.') {
        end += 1;
        if (!DIGIT.test(source[end] ?? '')) fail('a number needs a digit after its decimal point');
        while (end < source.length && DIGIT.test(source[end])) end += 1;
      }
      // A literal long enough to round to Infinity would compare true against
      // everything, so it is a declaration error rather than a rule that
      // always fires.
      const value = Number(source.slice(index, end));
      if (!Number.isFinite(value)) fail('that number is too large');
      tokens.push({ kind: 'number', value });
      index = end;
      continue;
    }

    if (char === '"' || char === "'") {
      // No escape sequences: a literal runs to the next matching quote. If the
      // text needs one kind of quote, write it with the other.
      const end = source.indexOf(char, index + 1);
      if (end === -1) fail('a string literal is not closed');
      tokens.push({ kind: 'string', value: source.slice(index + 1, end) });
      index = end + 1;
      continue;
    }

    if (IDENT_START.test(char)) {
      let end = index;
      while (end < source.length && IDENT_PART.test(source[end])) end += 1;
      tokens.push({ kind: 'ident', value: source.slice(index, end) });
      index = end;
      continue;
    }

    // A lone "&" or "|" is a typo for the boolean operator. There are no
    // bitwise operators to mistake it for, so say which one was meant.
    if ((char === '&' || char === '|') && source[index + 1] !== char) {
      fail(`use "${char}${char}", not "${char}"`);
    }

    const operator = OPERATORS.find((candidate) => source.startsWith(candidate, index));
    if (!operator) fail(`"${char}" is not something this expression language understands`);
    tokens.push({ kind: 'op', value: operator });
    index += operator.length;
  }

  tokens.push({ kind: 'end', value: 'end of expression' });
  return tokens;
}

/**
 * Recursive descent, lowest precedence first:
 *   or -> and -> equality -> comparison -> additive -> multiplicative -> unary -> primary
 */
function parse(tokens: Token[], fail: Fail): Expr {
  let index = 0;
  // Stack guard only; the declared depth limit is checked against the finished
  // tree, in parseRules. See MAX_PARSE_DEPTH.
  let depth = 0;

  const peek = (): Token => tokens[index];
  const describe = (token: Token): string =>
    token.kind === 'end' ? token.value : `"${token.value}"`;

  function eat(value: string): boolean {
    const token = peek();
    if (token.kind === 'op' && token.value === value) {
      index += 1;
      return true;
    }
    return false;
  }

  function expect(value: string): void {
    if (!eat(value)) fail(`expected "${value}" but found ${describe(peek())}`);
  }

  function enter<T>(build: () => T): T {
    depth += 1;
    if (depth > MAX_PARSE_DEPTH) {
      fail(`an expression may not nest more than ${MAX_PARSE_DEPTH} levels deep`);
    }
    const result = build();
    depth -= 1;
    return result;
  }

  function primary(): Expr {
    const token = peek();

    if (token.kind === 'number' || token.kind === 'string') {
      index += 1;
      return { kind: 'literal', value: token.value };
    }

    if (token.kind === 'ident') {
      index += 1;
      const next = peek();
      const called = next.kind === 'op' && next.value === '(';
      if (token.value === 'present' && called) {
        expect('(');
        const argument = peek();
        if (argument.kind !== 'ident') {
          fail(`present() takes a field name, not ${describe(argument)}`);
        }
        index += 1;
        expect(')');
        return { kind: 'present', name: argument.value };
      }
      if (called) {
        fail(`"${token.value}" is not a function; the only function is present()`);
      }
      // `present` without a call is just a name -- a form is allowed to have a
      // field called that, and it reads better than a syntax error.
      return { kind: 'field', name: token.value };
    }

    if (token.kind === 'op' && token.value === '(') {
      index += 1;
      const inner = enter(or);
      expect(')');
      return inner;
    }

    return fail(`expected a value but found ${describe(token)}`);
  }

  function unary(): Expr {
    if (eat('!')) return { kind: 'not', operand: enter(unary) };
    if (eat('-')) return { kind: 'negate', operand: enter(unary) };
    return primary();
  }

  function multiplicative(): Expr {
    let left = unary();
    for (;;) {
      if (eat('*')) left = { kind: 'arith', op: '*', left, right: unary() };
      else if (eat('/')) left = { kind: 'arith', op: '/', left, right: unary() };
      else return left;
    }
  }

  function additive(): Expr {
    let left = multiplicative();
    for (;;) {
      if (eat('+')) left = { kind: 'arith', op: '+', left, right: multiplicative() };
      else if (eat('-')) left = { kind: 'arith', op: '-', left, right: multiplicative() };
      else return left;
    }
  }

  function comparison(): Expr {
    const left = additive();
    for (const op of ['>=', '<=', '>', '<'] as const) {
      if (eat(op)) return { kind: 'compare', op, left, right: additive() };
    }
    return left;
  }

  function equality(): Expr {
    const left = comparison();
    for (const op of ['==', '!='] as const) {
      if (eat(op)) return { kind: 'compare', op, left, right: comparison() };
    }
    return left;
  }

  function and(): Expr {
    let left = equality();
    while (eat('&&')) left = { kind: 'logic', op: '&&', left, right: equality() };
    return left;
  }

  function or(): Expr {
    let left = and();
    while (eat('||')) left = { kind: 'logic', op: '||', left, right: and() };
    return left;
  }

  const expression = or();
  const trailing = peek();
  if (trailing.kind === 'op' && ['>', '>=', '<', '<=', '==', '!='].includes(trailing.value)) {
    // Comparisons are single-shot on purpose: `a > b > c` reads as arithmetic
    // in most languages and as nothing useful in any of them.
    fail('comparisons do not chain; write "a > b && b > c"');
  }
  if (trailing.kind !== 'end') fail(`unexpected ${describe(trailing)}`);
  return expression;
}

/** A rule that reads nothing from the submission is a constant, and a constant is a mistake. */
function mentionsField(expr: Expr): boolean {
  switch (expr.kind) {
    case 'literal':
      return false;
    case 'field':
    case 'present':
      return true;
    case 'not':
    case 'negate':
      return mentionsField(expr.operand);
    default:
      return mentionsField(expr.left) || mentionsField(expr.right);
  }
}

/** Depth of the finished tree. Catches a long left spine, which costs the parser no stack. */
function depthOf(expr: Expr): number {
  switch (expr.kind) {
    case 'literal':
    case 'field':
    case 'present':
      return 1;
    case 'not':
    case 'negate':
      return 1 + depthOf(expr.operand);
    default:
      return 1 + Math.max(depthOf(expr.left), depthOf(expr.right));
  }
}

function staticTypeOf(type: FieldType): StaticType {
  if (type === 'integer' || type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  return 'string';
}

/**
 * Own properties only. A schema arrives back from its sealed payload through
 * `JSON.parse`, so `fields` always carries Object.prototype -- and without this
 * `constructor`, `toString` and six others would answer "yes, that is a
 * declared field". `!present(constructor)` would then be accepted and refuse
 * every submission the form ever received.
 */
function declared(fields: Record<string, FieldSpec>, name: string): FieldSpec | undefined {
  return Object.hasOwn(fields, name) ? fields[name] : undefined;
}

function lookup(name: string, fields: Record<string, FieldSpec>, fail: Fail): FieldSpec {
  const spec = declared(fields, name);
  if (spec) return spec;
  if (name === 'true' || name === 'false') {
    fail('there are no true/false literals; write "subscribe" or "!subscribe"');
  }
  return fail(
    `"${name}" is not a field on this form` +
      (name.includes('-')
        ? '. A field name may contain "-", so a subtraction needs spaces around it'
        : ''),
  );
}

/**
 * Types the expression against the declaration. Every identifier must be a
 * declared field and every operand must be the right kind of thing, so
 * `note + 1` and a bare `note` as a condition are declaration errors rather
 * than a submission that quietly never matches.
 */
function typeOf(expr: Expr, fields: Record<string, FieldSpec>, fail: Fail): StaticType {
  switch (expr.kind) {
    case 'literal':
      if (typeof expr.value === 'string' && expr.value.trim() === '') {
        // Blank counts as absent everywhere else, and a comparison with an
        // absent operand is false -- so `note == ""` could never be true.
        fail('a blank string can never match, because blank counts as absent; use present()');
      }
      return typeof expr.value === 'number' ? 'number' : 'string';

    case 'present':
      if (lookup(expr.name, fields, fail).required) {
        // A required field is present in every submission that gets this far,
        // so the rule is a constant and would never do anything. If the rule
        // is what should require the field, stop declaring it required.
        fail(
          `"${expr.name}" is already required, so present(${expr.name}) never varies. ` +
            'Drop required from the field if the rule is what requires it',
        );
      }
      return 'boolean';

    case 'field': {
      const spec = lookup(expr.name, fields, fail);
      if (spec.multiple) {
        fail(
          `"${expr.name}" accepts repeated values, so it can only be used inside present()`,
        );
      }
      return staticTypeOf(spec.type);
    }

    case 'not':
      if (typeOf(expr.operand, fields, fail) !== 'boolean') {
        fail('"!" needs a true/false operand');
      }
      return 'boolean';

    case 'negate':
      if (typeOf(expr.operand, fields, fail) !== 'number') {
        fail('a negative sign needs a number');
      }
      return 'number';

    case 'arith': {
      for (const side of [expr.left, expr.right]) {
        if (typeOf(side, fields, fail) !== 'number') {
          fail(`"${expr.op}" works on numbers only; there is no string arithmetic`);
        }
      }
      return 'number';
    }

    case 'compare': {
      const left = typeOf(expr.left, fields, fail);
      const right = typeOf(expr.right, fields, fail);
      if (left !== right) fail(`cannot compare a ${left} with a ${right}`);
      if (left === 'boolean' && expr.op !== '==' && expr.op !== '!=') {
        fail(`true/false values compare with "==" or "!=" only`);
      }
      // A datetime is compared as an instant, so the other side has to be
      // readable as one. Text that is not a moment in time would read as
      // absent and the rule would never fire -- a silence this catches now.
      if (comparisonKind(expr.left, expr.right, fields) === 'instant') {
        for (const side of [expr.left, expr.right]) {
          if (!readableAsInstant(side, fields)) {
            fail(
              'a datetime compares against another datetime, a date, or a literal date; ' +
                'nothing else can be read as an instant',
            );
          }
        }
      }
      // Same silence, one type over: `check_in > "banana"` compares a date
      // with text no date can equal, and would answer no forever.
      for (const [side, other] of [
        [expr.left, expr.right],
        [expr.right, expr.left],
      ] as const) {
        if (side.kind !== 'field' || other.kind !== 'literal') continue;
        const type = declared(fields, side.name)?.type;
        const shape = type === 'date' ? DATE_SHAPE : type === 'time' ? TIME_SHAPE : undefined;
        if (shape && !(typeof other.value === 'string' && shape.test(other.value))) {
          fail(`a ${type} compares against a value written the same way a ${type} is`);
        }
      }
      return 'boolean';
    }

    case 'logic': {
      for (const side of [expr.left, expr.right]) {
        if (typeOf(side, fields, fail) !== 'boolean') {
          fail(`"${expr.op}" needs true/false operands`);
        }
      }
      return 'boolean';
    }
  }
}

/** Declaration-time compile: syntax, then the declared depth limit. */
function compile(source: string, fail: Fail): Expr {
  const expression = parse(tokenize(source, fail), fail);
  // Depth of the finished tree, so a flat chain of twenty `&&`s counts as
  // twenty even though it opens no parentheses.
  if (depthOf(expression) > MAX_EXPRESSION_DEPTH) {
    fail(`an expression may be at most ${MAX_EXPRESSION_DEPTH} levels deep`);
  }
  return expression;
}

/**
 * Validates a `rules` declaration. Runs when a schema is set, never on the
 * delivery path -- so a rule that reaches a submission is already known to
 * parse, to reference only declared fields, and to be a true/false question.
 */
export function parseRules(value: unknown, fields: Record<string, FieldSpec>): FormRule[] {
  if (!Array.isArray(value)) throw new ApiError('invalid_schema', 'schema.rules must be an array');
  if (value.length > MAX_RULES) {
    throw new ApiError('invalid_schema', `schema.rules may declare at most ${MAX_RULES} rules`);
  }

  return value.map((entry, position) => {
    const fail: Fail = (message) => {
      // Named by its index, which is the same index a rule_violated error
      // carries -- one way to refer to a rule, not two.
      throw new ApiError('invalid_schema', `rules[${position}]: ${message}`);
    };

    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('must be an object');
    const rule = entry as Record<string, unknown>;

    if (typeof rule.when !== 'string' || rule.when.trim() === '') {
      fail('when must be a non-empty expression');
    }
    const when = rule.when as string;
    if (when.length > MAX_EXPRESSION_LENGTH) {
      fail(`when may be at most ${MAX_EXPRESSION_LENGTH} characters`);
    }

    if (typeof rule.reject !== 'string' || rule.reject.trim() === '') {
      fail('reject must be the message to show when the rule fires');
    }
    const reject = rule.reject as string;
    if (reject.length > MAX_REJECT_LENGTH) {
      fail(`reject may be at most ${MAX_REJECT_LENGTH} characters`);
    }

    const expression = compile(when, fail);
    if (typeOf(expression, fields, fail) !== 'boolean') {
      fail('when must ask a true/false question, such as "adults + children > 6"');
    }
    if (!mentionsField(expression)) {
      fail('when must read at least one field, or it decides the same way every time');
    }

    return { when, reject };
  });
}

function submitted(submission: SubmissionFields, name: string): string[] {
  const raw = Object.hasOwn(submission, name) ? submission[name] : undefined;
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).map((entry) => entry.trim());
}

/**
 * Reads a field as a value of its declared type.
 *
 * Absent is `null` for every type, including `boolean` -- a checkbox that was
 * never ticked is a field that was never sent, and giving it a value here
 * would put a value into a comparison that nobody submitted. `!terms` is still
 * true for an unticked box, because a negation asks about absence on purpose;
 * a comparison does not, and refuses to answer.
 *
 * Absent means missing or blank, the same test `required` uses: a browser
 * omits a disabled input entirely, so an empty string is a sender that built
 * the body from the page source.
 *
 * Field-level validation has already passed by the time this runs, so a
 * present numeric field parses and a present boolean is a spelling of
 * true/false. Values are trimmed: form encodings carry incidental whitespace.
 */
function readField(name: string, fields: Record<string, FieldSpec>, submission: SubmissionFields): Value {
  const spec = declared(fields, name);
  // typeOf guarantees the field exists. If it somehow does not, the stored
  // schema is corrupt and guessing a type would invent an answer.
  if (!spec) return null;

  const value = submitted(submission, name).find((entry) => entry !== '');
  if (value === undefined) return null;

  const type = staticTypeOf(spec.type);
  if (type === 'number') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (type === 'boolean') return TRUE_VALUES.has(value.toLowerCase());
  return value;
}

function isPresent(name: string, submission: SubmissionFields): boolean {
  return submitted(submission, name).some((entry) => entry !== '');
}

/**
 * A `datetime` is the one text type whose spellings do not sort: `2026-06-10T10:00`,
 * `2026-06-10T09:00:00-05:00` and `Jun 10 2026` can all name the same instant,
 * and the submitter picks the spelling. Comparing them as text hands the sender
 * the choice of whether a rule fires, so a comparison involving a `datetime`
 * field compares instants -- both sides parsed, either side unparseable
 * reading as absent, and therefore as false.
 */
function fieldTypeOf(expr: Expr, fields: Record<string, FieldSpec>): FieldType | undefined {
  return expr.kind === 'field' ? declared(fields, expr.name)?.type : undefined;
}

/**
 * How both sides of a comparison are read before they are compared.
 *
 * Asked once and answered here, because the validator and the interpreter both
 * need it and they must not answer it separately. They used to: `typeOf` tested
 * `isInstant(left) || isInstant(right)` to decide what to demand of the
 * operands, and `evaluate` tested the same expression again to decide how to
 * coerce them. Both temporal bugs this file has already had -- a `datetime`
 * compared as text, and a `time` padded on only one side -- were the two
 * answers disagreeing.
 */
function comparisonKind(
  left: Expr,
  right: Expr,
  fields: Record<string, FieldSpec>,
): ComparisonKind {
  const types = [fieldTypeOf(left, fields), fieldTypeOf(right, fields)];
  if (types.includes('datetime')) return 'instant';
  if (types.includes('time')) return 'clock';
  return 'plain';
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_SHAPE = /^\d{2}:\d{2}(:\d{2})?$/u;
const INSTANT_SHAPE = /^\d{4}-\d{2}-\d{2}([T ]|$)/u;

/** What the other side of a datetime comparison may be, checked at declaration. */
function readableAsInstant(expr: Expr, fields: Record<string, FieldSpec>): boolean {
  const type = fieldTypeOf(expr, fields);
  if (type === 'datetime' || type === 'date') return true;
  if (expr.kind === 'field') return false;
  return (
    expr.kind === 'literal' &&
    typeof expr.value === 'string' &&
    // Date.parse reads "6" as a year and "12/25" as a date; a literal has to
    // be written the way a form writes one, or it is a typo, not a moment.
    INSTANT_SHAPE.test(expr.value) &&
    Number.isFinite(Date.parse(expr.value))
  );
}

/**
 * A `time` is text, and a browser sends "09:00" or "09:00:00" for the same
 * moment on the clock. Both sides of a comparison are padded to the longer
 * form, or `opens == "09:00"` would be false for a form that sent seconds and
 * `opens > "09:00"` would be true at exactly nine.
 */
function toSeconds(value: Value): Value {
  return typeof value === 'string' && /^\d{2}:\d{2}$/u.test(value) ? `${value}:00` : value;
}

function toInstant(value: Value): Value {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Interprets the AST. Two decisions, both aimed at making absence impossible
 * to be surprised by:
 *
 * - **In arithmetic an absent field is 0.** A sum is over what was sent, and a
 *   guest who leaves `children` blank brought no children. `adults + children`
 *   is therefore the occupancy whether the optional field arrived or not.
 * - **A comparison with an absent operand is false — all six operators,
 *   `!=` included.** A comparison against something that was never sent has no
 *   answer, and a rule must never fire on the strength of a value it does not
 *   have. `present()` is how absence is stated out loud, which is why it is the
 *   one function in the language.
 *
 * A division that does not produce a finite number is absent too, so `x / y`
 * with `y` blank or zero cannot fire a rule by way of infinity.
 *
 * `!` is the exception that proves the comparison rule: `!terms` is true for a
 * box that was never ticked. Negation is a question about absence, and asking
 * it explicitly is fine -- what must not happen is a comparison quietly
 * answering one.
 */
function evaluate(expr: Expr, fields: Record<string, FieldSpec>, submission: SubmissionFields): Value {
  switch (expr.kind) {
    case 'literal':
      return expr.value;

    case 'field':
      return readField(expr.name, fields, submission);

    case 'present':
      return isPresent(expr.name, submission);

    case 'not':
      return evaluate(expr.operand, fields, submission) !== true;

    case 'negate': {
      const operand = evaluate(expr.operand, fields, submission);
      // Absence survives a sign: `-children == 0` has to answer the same as
      // `children == 0`, which is "no answer".
      return operand === null ? null : -(operand as number);
    }

    case 'arith': {
      const left = evaluate(expr.left, fields, submission);
      const right = evaluate(expr.right, fields, submission);
      const a = left === null ? 0 : (left as number);
      const b = right === null ? 0 : (right as number);
      const result =
        expr.op === '+' ? a + b : expr.op === '-' ? a - b : expr.op === '*' ? a * b : a / b;
      return Number.isFinite(result) ? result : null;
    }

    case 'compare': {
      const kind = comparisonKind(expr.left, expr.right, fields);
      const read = (side: Expr): Value => {
        const value = evaluate(side, fields, submission);
        if (kind === 'instant') return toInstant(value);
        return kind === 'clock' ? toSeconds(value) : value;
      };
      const left = read(expr.left);
      const right = read(expr.right);
      if (left === null || right === null) return false;
      switch (expr.op) {
        case '>':
          return left > right;
        case '>=':
          return left >= right;
        case '<':
          return left < right;
        case '<=':
          return left <= right;
        case '==':
          return left === right;
        default:
          return left !== right;
      }
    }

    case 'logic': {
      const left = evaluate(expr.left, fields, submission) === true;
      if (expr.op === '&&') {
        return left ? evaluate(expr.right, fields, submission) === true : false;
      }
      return left ? true : evaluate(expr.right, fields, submission) === true;
    }
  }
}

/**
 * Parsed expressions, keyed by their source.
 *
 * What is stored and published is the text the customer wrote, not a tree --
 * so the tree has to come back from somewhere on every submission, and an
 * isolate serving the same form repeatedly should not re-derive it every time.
 * The key is the expression itself, which makes the cache correct by
 * construction: parsing is pure syntax and depends on nothing else. Cleared
 * wholesale past a bound, because an isolate can serve many forms and this
 * must not become a place where memory accumulates.
 */
const parsed = new Map<string, Expr>();
const MAX_CACHED_EXPRESSIONS = 500;

function cachedCompile(source: string): Expr {
  const hit = parsed.get(source);
  if (hit) return hit;

  let expression: Expr;
  try {
    // Syntax only. The declared limits were checked when the schema was set,
    // and re-imposing them here would let a future, stricter limit refuse a
    // rule that is already sealed into a live route.
    expression = parse(
      tokenize(source, (message) => {
        throw new Error(message);
      }),
      (message) => {
        throw new Error(message);
      },
    );
  } catch (error) {
    // Unreachable: every stored rule went through parseRules. If it ever
    // happens the stored schema is corrupt, which is the Worker's problem and
    // not the submitter's -- so say so where an operator can find it.
    console.error(
      JSON.stringify({
        event: 'stored_rule_unreadable',
        reason: error instanceof Error ? error.message : String(error),
      }),
    );
    throw new ApiError('internal_error', 'A stored rule could not be read.');
  }

  if (parsed.size >= MAX_CACHED_EXPRESSIONS) parsed.clear();
  parsed.set(source, expression);
  return expression;
}

/**
 * Runs every rule and reports every one that fired, the way field errors
 * report every field at once.
 */
export function evaluateRules(
  rules: FormRule[],
  fields: Record<string, FieldSpec>,
  submission: SubmissionFields,
): RuleError[] {
  const errors: RuleError[] = [];

  rules.forEach((rule, position) => {
    if (evaluate(cachedCompile(rule.when), fields, submission) === true) {
      errors.push({ rule: position, code: 'rule_violated', message: rule.reject });
    }
  });

  return errors;
}
