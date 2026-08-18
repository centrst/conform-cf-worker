import { nextActionFor } from './contract';
import { isValidFormId } from './crypto';
import { routeStatusUrl, submissionEndpoint } from './email';
import { ApiError, json } from './errors';
import { getStoredRoute } from './routes';
import {
  FRAMEWORKS,
  dryRunCommand,
  installFiles,
  installNotes,
  isFramework,
  testCommand,
  type Framework,
} from './templates';
import type { Env } from './types';

function frameworkFrom(request: Request): Framework {
  const value = new URL(request.url).searchParams.get('framework') ?? 'html';
  if (!isFramework(value)) {
    throw new ApiError(
      'unknown_framework',
      `Framework must be one of: ${FRAMEWORKS.join(', ')}`,
    );
  }
  return value;
}

function respond(
  request: Request,
  framework: Framework,
  endpoint: string,
  extra: Record<string, unknown>,
  withKey = false,
): Response {
  const files = installFiles(framework, endpoint, withKey);
  if (new URL(request.url).searchParams.get('raw') === '1') {
    return new Response(files[0].content, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });
  }
  return json({
    success: true,
    framework,
    files,
    // Stated on the artifact itself so an agent installing this never has to
    // infer which licence applies from the repository it came out of. The
    // engine is FSL; what you paste into your site is not.
    license: 'MIT',
    notes: installNotes(framework, withKey),
    dry_run_command: dryRunCommand(endpoint),
    test_command: testCommand(endpoint),
    ...extra,
  });
}

/** Generic artifact with a {{FORM_ENDPOINT}} placeholder — for docs and previews. */
export function genericInstall(request: Request): Response {
  const framework = frameworkFrom(request);
  return respond(request, framework, '{{FORM_ENDPOINT}}', {});
}

/** Personalized artifact with the route's real endpoint baked in. */
export async function routeInstall(
  request: Request,
  env: Env,
  formId: string,
): Promise<Response> {
  const framework = frameworkFrom(request);
  if (!isValidFormId(formId)) {
    throw new ApiError('route_not_found', 'Form route not found');
  }
  const record = await getStoredRoute(env, formId);
  if (!record) throw new ApiError('route_not_found', 'Form route not found');
  const origin = new URL(request.url).origin;
  const endpoint = submissionEndpoint(env, origin, formId);
  // The artifact carries the access_key field only once the route has a key to
  // put in it. Adding it earlier would ship a form posting a placeholder as a
  // real value, which is worse than not having the field at all.
  const withKey = (record.accessKeys ?? []).length > 0;
  return respond(
    request,
    framework,
    endpoint,
    {
      form_id: formId,
      status: record.status === 'active' ? 'active' : 'pending_verification',
      requires_access_key: Boolean(record.requireKey),
      next_action: nextActionFor(record.status, routeStatusUrl(env, origin, formId)),
    },
    withKey,
  );
}
