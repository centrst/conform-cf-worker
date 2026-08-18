import { accessKeyHash, generateAccessKey, generateKeyId, isValidAccessKey, isValidFormId, openToken, sealToken } from './crypto';
import { ApiError, TokenError, json } from './errors';
import { getStoredRoute, mintStoredAccessKey } from './routes';
import { keyResource } from './contract';
import type {
  Env,
  ManageTokenPayload,
  RotateTokenPayload,
  RouteAccessKey,
  StoredRouteRecord,
} from './types';

/**
 * Access keys: minting, rotation, and the check on the submission path.
 *
 * One concept, one file. These were spread through index.ts around the route
 * handlers they happened to be dispatched from, which is how index.ts came to
 * be twice the size of anything else in the repository.
 */

export async function mintRotationToken(
  env: Env,
  formId: string,
  ownerId: string,
): Promise<string> {
  const payload: RotateTokenPayload = {
    kind: 'rotate',
    version: 1,
    routeId: formId,
    ownerId,
    issuedAt: Date.now(),
  };
  return sealToken(payload, env.ROUTE_TOKEN_SECRET);
}

/**
 * Authorises key rotation. Accepts a rotation token or the more powerful
 * management token, but a rotation token can do nothing else -- which is the
 * point of it existing, because this is the credential that lives in CI.
 */
export async function rotatableRoute(
  request: Request,
  env: Env,
  formId: string,
): Promise<StoredRouteRecord> {
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new ApiError(
      'rotation_token_required',
      'Rotating access keys requires a rotation or management token as a Bearer Authorization header',
    );
  }
  const token = authorization.slice('Bearer '.length).trim();
  let payload: RotateTokenPayload | ManageTokenPayload;
  try {
    payload = await openToken<RotateTokenPayload>(token, 'rotate', env.ROUTE_TOKEN_SECRET);
  } catch (rotateError) {
    if (!(rotateError instanceof TokenError)) throw rotateError;
    try {
      payload = await openToken<ManageTokenPayload>(token, 'manage', env.ROUTE_TOKEN_SECRET);
    } catch (manageError) {
      if (manageError instanceof TokenError) {
        throw new ApiError('rotation_token_invalid', 'The rotation token is not valid');
      }
      throw manageError;
    }
  }
  if (!isValidFormId(formId)) {
    throw new ApiError('route_not_found', 'Form route not found');
  }
  const record = await getStoredRoute(env, formId);
  if (!record) throw new ApiError('route_not_found', 'Form route not found');
  if (payload.routeId !== formId || payload.ownerId !== record.ownerId) {
    throw new ApiError(
      'rotation_token_invalid',
      'The rotation token does not match this route',
    );
  }
  return record;
}

export async function listRouteKeys(
  request: Request,
  env: Env,
  formId: string,
): Promise<Response> {
  const record = await rotatableRoute(request, env, formId);
  return json({
    success: true,
    form_id: formId,
    require_key: Boolean(record.requireKey),
    keys: (record.accessKeys ?? []).map(keyResource),
  });
}

export async function mintRouteKey(request: Request, env: Env, formId: string): Promise<Response> {
  const record = await rotatableRoute(request, env, formId);

  if (env.ROTATION_RATE_LIMITER) {
    const allowed = await env.ROTATION_RATE_LIMITER.limit({ key: `rotate:${formId}` });
    if (!allowed.success) {
      throw new ApiError('rate_limited', 'Too many key rotations. Try again shortly.', {
        retry_after_seconds: 60,
      });
    }
  }

  const key = generateAccessKey();
  const minted: RouteAccessKey = {
    keyId: generateKeyId(),
    hash: await accessKeyHash(key, env.OWNER_HASH_SECRET),
    createdAt: new Date().toISOString(),
  };
  const keys = await mintStoredAccessKey(env, formId, minted);
  if (!keys) throw new ApiError('route_not_found', 'Form route not found');

  return json(
    {
      success: true,
      form_id: formId,
      key,
      key_id: minted.keyId,
      require_key: Boolean(record.requireKey),
      keys: keys.map(keyResource),
      message:
        'Send this value as the access_key field. It is returned once. The key it replaces ' +
        'stays valid until this one is first accepted, so a failed deploy costs nothing.',
    },
    201,
  );
}

/**
 * Matches the submitted `access_key` against the route's live keys.
 *
 * The key is not proof of origin -- it is inlined into a page a scraper
 * already reads. What it buys is rotation: the endpoint, the route and the
 * inbox all stay put while the value a harvested payload carries goes stale.
 *
 * Enforcement is a separate switch (`requireKey`). Until it is on, a wrong or
 * missing key still delivers, so a customer can mint keys, ship them, and only
 * then start refusing -- rather than breaking their own form at step one.
 */
export async function checkAccessKey(
  env: Env,
  record: StoredRouteRecord,
  parsed: { allFields: Record<string, string | string[]> },
): Promise<RouteAccessKey | undefined> {
  const keys = record.accessKeys ?? [];
  if (keys.length === 0) {
    // Enforcement on with nothing to enforce against must refuse, not admit.
    // The API guard that prevents this state lives in updateRouteSettings, in
    // another function; the Durable Object itself will accept it. An invariant
    // held in one of two write paths is one refactor from being lost, and this
    // one fails in the direction of silently disabling the control.
    if (record.requireKey) {
      throw new ApiError(
        'access_key_required',
        'This form requires an access_key but has none. Mint one to restore delivery.',
      );
    }
    return undefined;
  }

  const raw = parsed.allFields.access_key;
  const presented = (Array.isArray(raw) ? raw[0] : raw)?.trim();

  if (!presented) {
    if (record.requireKey) {
      throw new ApiError(
        'access_key_required',
        'This form requires an access_key field.',
      );
    }
    return undefined;
  }

  const presentedHash = isValidAccessKey(presented)
    ? await accessKeyHash(presented, env.OWNER_HASH_SECRET)
    : undefined;
  const matched = presentedHash
    ? keys.find((key) => key.hash === presentedHash)
    : undefined;
  if (!matched && record.requireKey) {
    throw new ApiError('access_key_invalid', 'The access_key is not valid for this form.');
  }
  return matched;
}
