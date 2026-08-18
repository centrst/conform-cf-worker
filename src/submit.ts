import { checkAccessKey } from './access-keys';
import {
  dailyLimit,
  maxFieldLength,
  maxFields,
  maxRequestSize,
  monthlyLimit,
} from './config';
import { nextActionFor, quotaResetsAt } from './contract';
import { isValidFormId, openToken, ownerIdForEmail } from './crypto';
import { routeStatusUrl, sendQuotaWarning, sendSubmissionEmail } from './email';
import { ApiError, ConfigError, json } from './errors';
import { acceptsHtml, submissionResultPage } from './pages';
import {
  countThrottled,
  peekQuota,
  reserveQuota,
  rollbackQuota,
} from './quota';
import { acceptStoredAccessKey, getStoredRoute, indexStoredRoute } from './routes';
import { validateSubmission } from './schema';
import { parseSubmission, type ParsedSubmission } from './submission';
import { refreshVerifiedRoute } from './verification';
import { deliverWebhook, submissionEvent } from './webhook';
import type {
  Env,
  RouteAccessKey,
  RouteDeliveryMode,
  RouteTokenPayload,
  StoredRouteRecord,
} from './types';

/**
 * A submission, in three stages: check it, then either spend or report.
 *
 * The stages are separate functions rather than sections of one, because the
 * dry run is not a mode -- it is a place to stop. When both lived in one
 * 300-line function the boundary was a comment ("everything above this line is
 * a check"), and the property the dry run sells, that it runs exactly the
 * checks a real submission runs, held only as long as two code paths inside
 * that function stayed in step. They did not: the honeypot answer and the clean
 * answer were built independently and drifted, turning the difference between
 * them into an oracle for the trap.
 */

/** A route resolved and cleared for delivery. Absent when the honeypot fired. */
interface ResolvedRoute {
  record: StoredRouteRecord;
  payload: RouteTokenPayload;
  acceptedKey?: RouteAccessKey;
  quotaKey: string;
}

interface CheckedSubmission {
  parsed: ParsedSubmission;
  redirect?: string;
  /**
   * Absent means the honeypot fired: no route was looked up, and the caller
   * must not be able to tell. Every answer below is built from this one shape
   * so that a trapped response cannot grow a field a clean one lacks.
   */
  route?: ResolvedRoute;
}

function validatedRedirect(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError('invalid_redirect_url', 'Redirect must be an absolute https:// URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new ApiError('invalid_redirect_url', 'Redirect must be an absolute https:// URL');
  }
  return parsed.toString();
}

function submissionSuccess(
  request: Request,
  redirect: string | undefined,
  body: Record<string, unknown>,
): Response {
  if (redirect) {
    return new Response(null, {
      status: 303,
      headers: { Location: redirect, 'Cache-Control': 'no-store' },
    });
  }
  if (acceptsHtml(request)) {
    return submissionResultPage('sent', String(body.message));
  }
  return json(body);
}

/**
 * Runs every check, and spends nothing.
 *
 * Throws the same ApiError a real submission would, which is what makes the
 * dry run worth running: its failures are the real ones.
 */
async function checkSubmission(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  formId: string,
): Promise<CheckedSubmission> {
  const parsed = await parseSubmission(request, {
    maxBytes: maxRequestSize(env),
    maxFields: maxFields(env),
    maxFieldLength: maxFieldLength(env),
  });
  // Before the honeypot, so a malformed redirect is reported even to a sender
  // the trap caught -- it is a fault in the form, not in the submission.
  const redirect =
    parsed.redirect !== undefined ? validatedRedirect(parsed.redirect) : undefined;

  if (parsed.spam) return { parsed, redirect };

  if (Object.keys(parsed.fields).length === 0) {
    throw new ApiError('submission_empty', 'Form data is required');
  }
  if (!isValidFormId(formId)) {
    throw new ApiError('route_not_found', 'Form route not found');
  }

  // Sits after the honeypot (which costs nothing to reject) and before the
  // route lookup, so a burst is turned away without touching storage.
  //
  // This is the control that makes an unmetered allowance safe. A monthly
  // quota bounds the total but not the rate, so without this a scraped form
  // delivers its flood as fast as the attacker can send it -- into the
  // customer's own inbox. Two keys: the form, so one abused endpoint cannot
  // affect another, and the client, so a single source is capped regardless of
  // how many forms it found.
  if (env.SUBMISSION_RATE_LIMITER) {
    const clientAddress = request.headers.get('cf-connecting-ip') || 'unknown';
    const clientId = await ownerIdForEmail(
      `submission-client:${clientAddress}`,
      env.OWNER_HASH_SECRET,
    );
    // Two bindings, not one, because the ceilings differ: a form may legitimately
    // be busy, a single client never is. Sharing one binding is what made the
    // per-client limit silently equal to the per-form one.
    //
    // Keyed by client AND form. A key of client alone is shared fate across
    // every tenant on a hosted deployment: one office NAT, one CGNAT pool or
    // one mobile carrier exit would be capped at two submissions a minute
    // across every customer's forms combined, and the third real visitor gets
    // an error the form owner never hears about. That is the exact failure the
    // per-form ceiling is deliberately kept loose to avoid. What it gives up is
    // capping one source across many forms at once -- weak protection anyway,
    // since each form has its own ceiling and each inbox its own day cap.
    const clientLimiter = env.SUBMISSION_CLIENT_RATE_LIMITER ?? env.SUBMISSION_RATE_LIMITER;
    const [formLimit, clientLimit] = await Promise.all([
      env.SUBMISSION_RATE_LIMITER.limit({ key: `form:${formId}` }),
      clientLimiter.limit({ key: `client:${clientId}:${formId}` }),
    ]);
    if (!formLimit.success || !clientLimit.success) {
      // Record that this inbox is being throttled, but at most once per form
      // per minute. An attack is unbounded, so counting every refused request
      // would turn the throttle into the storage amplification it exists to
      // prevent -- and the route lookup needed to find the inbox is itself the
      // work being avoided. The reporting limiter buys that lookup once a
      // minute, which is enough for the owner to see it happening.
      if (env.THROTTLE_REPORT_LIMITER) {
        const report = await env.THROTTLE_REPORT_LIMITER.limit({ key: `report:${formId}` });
        if (report.success) {
          ctx.waitUntil(
            (async () => {
              const throttledRoute = await getStoredRoute(env, formId);
              if (!throttledRoute) return;
              await countThrottled(env, throttledRoute.quotaKey ?? throttledRoute.ownerId);
            })().catch(() => undefined),
          );
        }
      }
      throw new ApiError('rate_limited', 'Too many submissions. Try again in a minute.', {
        retry_after_seconds: 60,
      });
    }
  }

  const found = await getStoredRoute(env, formId);
  if (!found) throw new ApiError('route_not_found', 'Form route not found');
  const record = await refreshVerifiedRoute(env, found);
  await indexStoredRoute(env, record.ownerId, record.formId, record.createdAt);
  if (record.status !== 'active') {
    const origin = new URL(request.url).origin;
    throw new ApiError('inbox_not_verified', 'This inbox has not been verified yet.', {
      next_action: nextActionFor('pending', routeStatusUrl(env, origin, formId)),
    });
  }
  const acceptedKey = await checkAccessKey(env, record, parsed);

  const route = await openToken<RouteTokenPayload>(
    record.encryptedRoute,
    'route',
    env.ROUTE_TOKEN_SECRET,
  );
  if (
    route.routeId !== record.formId ||
    route.ownerId !== record.ownerId ||
    route.formName !== record.alias
  ) {
    throw new Error('Stored route metadata does not match its encrypted payload');
  }

  // Before the reservation, so a submission refused on its shape costs the
  // owner nothing. This is the only check that can reject on merits rather
  // than on fingerprints -- and it exists only because the form said what it
  // is. Errors are per-field and go to everyone: the schema is derivable from
  // the page an attacker already scraped, so withholding detail protects
  // nothing and leaves real integrators debugging blind.
  if (route.schema) {
    const errors = validateSubmission(route.schema, parsed.fields);
    if (errors.length > 0) {
      throw new ApiError('submission_invalid', 'This submission does not match the form.', {
        errors,
      });
    }
  }

  const quotaKey = record.quotaKey ?? record.ownerId;
  return { parsed, redirect, route: { record, payload: route, acceptedKey, quotaKey } };
}

const DRY_RUN_MESSAGE =
  'Dry run — nothing was delivered and no allowance was spent. ' +
  'Remove the _dry_run field to submit for real.';

/**
 * The only place a dry-run answer is built.
 *
 * Trapped and clean submissions come through here alike, so the two cannot
 * carry different field sets -- which they did, when the honeypot returned a
 * bare envelope while the clean path added `would_deliver`. The absence of one
 * field named the trap for free.
 *
 * A dry run never redirects and never renders a thank-you page: a `_dry_run`
 * field shipped into a live form has to announce itself rather than silently
 * swallow a month of enquiries.
 */
async function reportDryRun(
  request: Request,
  env: Env,
  checked: CheckedSubmission,
): Promise<Response> {
  const detail = await dryRunDetail(env, checked.route);
  if (acceptsHtml(request)) return submissionResultPage('dry-run', DRY_RUN_MESSAGE);
  return json({
    success: true,
    dry_run: true,
    delivered: false,
    ...detail,
    message: DRY_RUN_MESSAGE,
  });
}

async function dryRunDetail(
  env: Env,
  resolved: CheckedSubmission['route'],
): Promise<Record<string, unknown>> {
  // The honeypot's answer. It reports what a clean submission to a healthy
  // route reports, and nothing a clean submission would not.
  if (!resolved) return { would_deliver: true };

      const routeDelivery = resolved.payload.delivery;
      const mode: RouteDeliveryMode = routeDelivery?.mode ?? 'email';
      const quota = await peekQuota(env, resolved.quotaKey, monthlyLimit(env));
      const withinMonth = quota.limit === 0 || quota.used < quota.limit;
      const withinDay = dailyLimit(env) === 0 || quota.day_used < dailyLimit(env);
      // The counters and the delivery plan are the owner's business: month-to-date
      // volume across every form on the inbox, and whether a webhook exists at
      // all. `/f/{id}` is unauthenticated and the form ID is in the page source,
      // so publishing them here would make an inbox's enquiry rate pollable by
      // anyone who scraped it. A caller holding an accepted access key has proved
      // it is the installer; everyone else gets the answer they actually need.
      const installer = resolved.acceptedKey !== undefined;
      return {
        would_deliver: withinMonth && withinDay,
        ...(installer
          ? {
              delivery:
                mode === 'email'
                  ? { email: 'would send' }
                  : mode === 'webhook'
                    ? { webhook: 'would post' }
                    : { email: 'would send', webhook: 'would post' },
              ...(quota.limit > 0
                ? {
                    quota: {
                      used: quota.used,
                      limit: quota.limit,
                      resets_at: quotaResetsAt(quota.month),
                      day_used: quota.day_used,
                      day_limit: dailyLimit(env),
                    },
                  }
                : {}),
            }
          : {}),
      };
}

/** Everything past this point spends something: an allowance, an email, a webhook. */
async function deliverSubmission(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  checked: CheckedSubmission,
  resolved: ResolvedRoute,
): Promise<Response> {
  const { parsed, redirect } = checked;
  const reservation = await reserveQuota(
    env,
    resolved.quotaKey,
    monthlyLimit(env),
    dailyLimit(env),
  );
  if (!reservation.allowed && reservation.reason === 'daily') {
    throw new ApiError(
      'daily_allowance_exhausted',
      'This inbox has reached its daily submission ceiling.',
      {
        used: reservation.used,
        limit: reservation.limit,
        day: reservation.day,
      },
    );
  }
  if (!reservation.allowed) {
    throw new ApiError(
      'monthly_allowance_exhausted',
      'This inbox has reached its shared monthly submission allowance.',
      {
        used: reservation.used,
        limit: reservation.limit,
        resets_at: quotaResetsAt(reservation.month),
      },
    );
  }

  const route = resolved.payload;
  const routeDelivery = route.delivery;
  const routeDeliveryMode: RouteDeliveryMode = routeDelivery?.mode ?? 'email';
  const event =
    routeDeliveryMode !== 'email' && routeDelivery?.webhook
      ? submissionEvent(route, parsed.fields, {
          test: parsed.test,
          replyTo: parsed.replyTo,
          subject: parsed.subject,
        })
      : undefined;

  async function rollback(): Promise<void> {
    if (reservation.limit > 0) {
      try {
        await rollbackQuota(env, resolved.quotaKey, reservation.month, reservation.day);
      } catch {
        // The delivery failed, so the response remains an error even if rollback
        // also fails. No form fields are included in logs or error messages.
      }
    }
  }

  let deliveryReport: Record<string, string>;
  if (routeDeliveryMode === 'webhook' && routeDelivery?.webhook && event) {
    // Synchronous, at-most-once delivery: on failure the reservation is rolled
    // back and nothing was delivered, so the request is safe to retry.
    // Receivers deduplicate on the webhook-id header.
    const result = await deliverWebhook(routeDelivery.webhook, event, {
      retryWaitsMs: [1000],
      timeoutMs: 10_000,
    });
    if (!result.ok) {
      await rollback();
      throw new ApiError('webhook_delivery_failed', 'Webhook delivery failed');
    }
    deliveryReport = { webhook: 'delivered' };
  } else {
    try {
      await sendSubmissionEmail(env, route, parsed.fields, {
        format: parsed.format,
        replyTo: parsed.replyTo,
        subject: parsed.subject,
        test: parsed.test,
        testNonce: parsed.testNonce,
      });
    } catch (error) {
      await rollback();
      if (error instanceof ConfigError) throw error;
      throw new ApiError('delivery_failed', 'Email delivery failed');
    }
    if (routeDeliveryMode === 'both' && routeDelivery?.webhook && event) {
      // Email is authoritative and already delivered; the webhook is
      // best-effort in the background — the human inbox is the durable record.
      ctx.waitUntil(
        deliverWebhook(routeDelivery.webhook, event, {
          retryWaitsMs: [1000, 4000],
          timeoutMs: 10_000,
        }).catch(() => undefined),
      );
      deliveryReport = { email: 'delivered', webhook: 'queued' };
    } else {
      deliveryReport = { email: 'delivered' };
    }
  }

  // Retirement happens here, on a delivery that actually succeeded, and only
  // the first time. A key that has proved itself is what retires the keys it
  // superseded -- so a pipeline that mints a key and then fails to deploy
  // leaves the live site's key untouched, instead of quietly starting a clock
  // on it. Steady state costs nothing: `usedAt` is already set.
  if (resolved.acceptedKey && !resolved.acceptedKey.usedAt) {
    ctx.waitUntil(
      acceptStoredAccessKey(env, resolved.record.formId, resolved.acceptedKey.keyId).catch(() => undefined),
    );
  }

  // The quota Durable Object decides this, not the count. It claims each mark
  // once per month, so a rolled-back reservation reaching the same number again
  // — or two submissions landing together — cannot resend the same warning.
  if (reservation.warn) {
    ctx.waitUntil(
      sendQuotaWarning(env, route, reservation.used, reservation.limit, reservation.month).catch(() => undefined),
    );
  }

  return submissionSuccess(request, redirect, {
    success: true,
    message: parsed.test ? 'Test submission delivered' : 'Submission delivered',
    ...(parsed.test ? { test: true, echo: parsed.testNonce ?? null } : {}),
    delivery: deliveryReport,
    used: reservation.limit > 0 ? reservation.used : undefined,
    limit: reservation.limit > 0 ? reservation.limit : undefined,
  });
}

export async function submit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  formId: string,
): Promise<Response> {
  const checked = await checkSubmission(request, env, ctx, formId);
  if (checked.parsed.dryRun) return reportDryRun(request, env, checked);
  if (!checked.route) {
    // The honeypot fired. Answering as though it had not is the whole point.
    return submissionSuccess(request, checked.redirect, {
      success: true,
      message: 'Submission received',
    });
  }
  return deliverSubmission(request, env, ctx, checked, checked.route);
}
