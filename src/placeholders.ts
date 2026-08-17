/**
 * Form IDs that appear in documentation, marketing copy and generated
 * artifacts as illustrations. They are not routes and never will be.
 *
 * Someone who posts to one of these has copied a sample and is trying the
 * product — the single most interesting moment in the funnel. Returning a bare
 * `route_not_found` tells them nothing, so these IDs get a dedicated code and a
 * page explaining what to do next.
 *
 * Adding an ID here is deliberate: it permanently burns that ID as a real
 * route. Keep the list to values actually published somewhere.
 */
const PLACEHOLDER_FORM_IDS: ReadonlySet<string> = new Set([
  // Used across the docs, the README, and the site's install snippets.
  'cfm_7K4P9X2M8RWD3JNH',
  // The obvious fill-in-the-blank form, used in the centrst.com product visual.
  'cfm_your_form_id',
  'cfm_YOUR_FORM_ID',
]);

export function isPlaceholderFormId(formId: string): boolean {
  return PLACEHOLDER_FORM_IDS.has(formId);
}

export function placeholderFormIds(): string[] {
  return [...PLACEHOLDER_FORM_IDS];
}
