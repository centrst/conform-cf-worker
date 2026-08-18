/**
 * The key lifecycle, stated once.
 *
 * The rule lives in SQL inside FormRoute and, unavoidably, a second time in
 * the fake Durable Object the node suite runs against. Two implementations of
 * a subtle rule is how the eviction bug survived: the flagship tests asserted
 * against the fake, so the fake and the prose agreed while the SQL did
 * something else. These cases are driven through BOTH, so the fake is a claim
 * about the Worker rather than a second opinion.
 *
 * `expect` is newest-first, exactly as a listing returns it.
 */
export interface KeyLifecycleCase {
  name: string;
  /** `+ID` mints, `!ID` accepts (a submission delivering with that key). */
  ops: string[];
  expect: string[];
}

export const KEY_LIFECYCLE_CASES: KeyLifecycleCase[] = [
  {
    name: 'a single mint is the current key',
    ops: ['+A'],
    expect: ['A'],
  },
  {
    name: 'a superseded key stays live until its successor is accepted',
    ops: ['+A', '!A', '+B'],
    expect: ['B', 'A'],
  },
  {
    name: 'accepting the successor retires what it superseded',
    ops: ['+A', '!A', '+B', '!B'],
    expect: ['B'],
  },
  {
    name: 'a stale cached page does not retire the key a deploy just shipped',
    // The old rule promoted the accepted older key over the newer deployed one.
    ops: ['+A', '+B', '!A', '+C'],
    expect: ['C', 'B', 'A'],
  },
  {
    name: 'a deployed key with no traffic yet survives failed builds',
    // The old rule evicted A here: never accepted, so it looked abandoned.
    ops: ['+A', '+B', '+C'],
    expect: ['C', 'B', 'A'],
  },
  {
    name: 'unaccepted keys are bounded by the window',
    ops: ['+A', '+B', '+C', '+D', '+E', '+F', '+G'],
    expect: ['G', 'F', 'E', 'D', 'C'],
  },
  {
    name: 'the newest accepted key survives the window',
    ops: ['+A', '!A', '+B', '+C', '+D', '+E', '+F', '+G'],
    expect: ['G', 'F', 'E', 'D', 'C', 'A'],
  },
  {
    name: 'accepting an older key retires nothing newer',
    ops: ['+A', '+B', '!A'],
    expect: ['B', 'A'],
  },
  {
    name: 'accepting the newest retires every older key at once',
    ops: ['+A', '+B', '+C', '!C'],
    expect: ['C'],
  },
  {
    name: 'accepting twice is idempotent',
    ops: ['+A', '!A', '!A'],
    expect: ['A'],
  },
];
