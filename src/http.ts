/**
 * The OneBill transport: OAuth token acquisition, request signing, and error normalization.
 *
 * This class is **deliberately not exported from the package barrel.** OneBill's REST surface is
 * verb-gated, so the read-only guarantee of {@link OneBillReadClient} comes from that class having
 * no mutating method — but only as long as consumers cannot reach the raw transport underneath it.
 * Exporting this would let anyone bypass the split in one line.
 */

/** A token and the moment it stops being usable, in epoch milliseconds. */
export interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * Somewhere to keep an access token between requests.
 *
 * The default is an in-memory Map, which is per-isolate and does not survive a restart. In a
 * Cloudflare Worker that means a token fetch per cold isolate; supply a KV- or Durable-Object-backed
 * implementation to share one across them. Methods may be sync or async.
 */
export interface TokenCache {
  get(key: string): CachedToken | undefined | Promise<CachedToken | undefined>;
  set(key: string, value: CachedToken): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}

/** OneBill's own public endpoint. */
const DEFAULT_BASE_URL = 'https://app.onebillsoftware.com';

/** Refresh this many milliseconds before the token actually expires. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface OneBillHttpConfig {
  /**
   * Tenant identifier, from Config > Settings > Business Profile. Doubles as the OAuth `client_id`
   * and is sent on every request as `X-OB-Tenant-Identifier` (mandatory since January 2025).
   */
  tenantId: string;
  /** OAuth client secret, from the same Business Profile screen. */
  clientSecret: string;
  username: string;
  /** Plaintext password. It is SHA-256 hashed before it leaves this process; see the note below. */
  password: string;
  /** OAuth scope. Defaults to `trust`, OneBill's documented value. */
  scope?: string;
  /**
   * Instance base URL. Defaults to OneBill's public endpoint, which is a vendor constant rather
   * than a deployment-specific one. Must be HTTPS.
   */
  baseUrl?: string;
  /** Injectable for tests / non-global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable token storage. Defaults to a per-instance in-memory Map. */
  tokenCache?: TokenCache;
  /** Injectable clock, in epoch milliseconds. Defaults to `Date.now`. For tests. */
  nowMs?: () => number;
}

/**
 * An error from OneBill — either an HTTP failure, or an application-level failure returned with
 * HTTP 200 and an error body.
 */
export class OneBillApiError extends Error {
  constructor(
    message: string,
    /** HTTP status. 200 when the failure was reported in-band. */
    public readonly status: number,
    /** The request path, for context. */
    public readonly path: string,
    /** The HTTP method used. */
    public readonly method: string,
    /** The parsed (or raw) response body. */
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'OneBillApiError';
  }
}

/** SHA-256 of a string, lowercase hex. Web Crypto, so this runs anywhere `fetch` does. */
async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Validate and normalize the configured base URL.
 *
 * HTTPS is required: this client sends a bearer token and, on the token call itself, credentials.
 * Embedded userinfo is rejected so a base URL derived from request input cannot redirect those
 * credentials to another origin.
 */
export function assertBaseUrl(raw: string): string {
  const trimmed = String(raw ?? '').trim().replace(/\/+$/, '');
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error(`Invalid OneBill base URL "${raw}": expected an absolute https:// URL`);
  }
  if (u.protocol !== 'https:') {
    throw new Error(
      `Invalid OneBill base URL "${raw}": must use https so credentials are not sent in the clear`,
    );
  }
  if (u.username || u.password) {
    throw new Error(`Invalid OneBill base URL "${raw}": must not embed credentials`);
  }
  // A query or fragment would swallow the path of every request built from this base, silently
  // rerouting them to `/` on the same host — including the credential-bearing token call.
  if (u.search || u.hash) {
    throw new Error(`Invalid OneBill base URL "${raw}": must not carry a query string or fragment`);
  }
  return trimmed;
}

/** A default in-memory cache. Per instance, so two clients do not share a token by accident. */
class MemoryTokenCache implements TokenCache {
  readonly #map = new Map<string, CachedToken>();
  get(key: string): CachedToken | undefined {
    return this.#map.get(key);
  }
  set(key: string, value: CachedToken): void {
    this.#map.set(key, value);
  }
  delete(key: string): void {
    this.#map.delete(key);
  }
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export class OneBillHttp {
  readonly #baseUrl: string;
  readonly #tenantId: string;
  readonly #clientSecret: string;
  readonly #username: string;
  readonly #password: string;
  readonly #scope: string;
  readonly #fetchImpl: typeof fetch;
  readonly #cache: TokenCache;
  readonly #now: () => number;

  constructor(cfg: OneBillHttpConfig) {
    this.#baseUrl = assertBaseUrl(cfg.baseUrl ?? DEFAULT_BASE_URL);
    this.#tenantId = cfg.tenantId;
    this.#clientSecret = cfg.clientSecret;
    this.#username = cfg.username;
    this.#password = cfg.password;
    this.#scope = cfg.scope ?? 'trust';
    this.#fetchImpl = cfg.fetchImpl ?? fetch;
    this.#cache = cfg.tokenCache ?? new MemoryTokenCache();
    this.#now = cfg.nowMs ?? (() => Date.now());
  }

  /**
   * Cache key. Covers the **whole credential set**, not just its identity half.
   *
   * Two clients differing only in `scope` — or one whose secret has been rotated — would otherwise
   * collide on one key and serve each other's tokens through a shared cache, which is exactly the
   * KV-backed setup this class recommends. The secret and scope are hashed so neither appears in a
   * KV key listing, and the digest is computed once and reused.
   */
  async #cacheKeyFor(): Promise<string> {
    if (this.#cacheKeyCache === undefined) {
      const fingerprint = await sha256Hex(`${this.#clientSecret}\u0000${this.#scope}`);
      this.#cacheKeyCache = `${this.#baseUrl}|${this.#tenantId}|${this.#username}|${fingerprint.slice(0, 16)}`;
    }
    return this.#cacheKeyCache;
  }
  #cacheKeyCache: string | undefined;

  /**
   * Fetch a fresh access token.
   *
   * OneBill's token endpoint takes its parameters in the **query string**, including the client
   * secret and the hashed password. That is the vendor's documented shape, and it is a genuine
   * weakness: query strings land in proxy and server access logs. Whether the endpoint also accepts
   * a form-encoded body is untested; if it does, moving these into the body would be strictly
   * better.
   */
  async #fetchToken(): Promise<CachedToken> {
    const hashed = await sha256Hex(this.#password);
    const url = new URL(`${this.#baseUrl}/oauth/token`);
    url.searchParams.set('grant_type', 'password');
    url.searchParams.set('client_id', this.#tenantId);
    url.searchParams.set('client_secret', this.#clientSecret);
    url.searchParams.set('username', this.#username);
    url.searchParams.set('password', hashed);
    url.searchParams.set('scope', this.#scope);

    // Call via a local, NOT `this.#fetchImpl(...)`: invoking the global fetch as a method of this
    // instance throws "Illegal invocation" in workerd (the global fetch requires a global `this`).
    const doFetch = this.#fetchImpl;
    const res = await doFetch(url.toString(), {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });

    const parsed = await readBody(res);
    if (!res.ok) {
      // Redact before the body reaches an error a consumer will very reasonably log.
      const safe = withoutCredentials(parsed);
      throw new OneBillApiError(
        `OAuth token request failed with ${res.status}: ${detailOf(safe)}`,
        res.status,
        '/oauth/token',
        'POST',
        safe,
      );
    }

    const token = (parsed as { access_token?: unknown } | null)?.access_token;
    if (typeof token !== 'string' || token === '') {
      // Fail closed: a 200 with no usable token is an auth failure, not a usable session.
      throw new OneBillApiError(
        'OAuth token request returned no access_token',
        res.status,
        '/oauth/token',
        'POST',
        withoutCredentials(parsed),
      );
    }

    const expiresIn = (parsed as { expires_in?: unknown }).expires_in;
    const lifetimeMs = (typeof expiresIn === 'number' ? expiresIn : 3600) * 1000;

    return { token, expiresAt: this.#now() + Math.max(lifetimeMs - EXPIRY_MARGIN_MS, 0) };
  }

  /** A valid token, from cache when possible. */
  async #token(): Promise<string> {
    const key = await this.#cacheKeyFor();
    const cached = await this.#cache.get(key);
    if (cached && cached.expiresAt > this.#now()) return cached.token;

    const fresh = await this.#fetchToken();
    await this.#cache.set(key, fresh);
    return fresh.token;
  }

  /**
   * Make an authenticated request.
   *
   * Retries exactly once on a 401, after discarding the cached token — the common case is a token
   * revoked or expired earlier than its stated lifetime.
   *
   * **`USER_AUTHENTICATION_FAILED` in an HTTP-200 body does NOT mean the token was rejected**, and
   * must not trigger a refresh. OneBill returns exactly that message, with a real token, for
   * `quoteDocument` on an order that simply has no document — which is most orders. Retrying on it
   * doubled the request count and churned a new token per miss before this was understood
   * (investigated live 2026-08-06). The message is a lie; the `errorCode` is the truth. Endpoints
   * that have a meaningful "absent" case decode it themselves — see `getQuoteDocument`.
   *
   * Worth knowing for long jobs: the token endpoint does not hand out a fresh hour. It returns the
   * *remaining* life of an existing session (`expires_in: 3524` on a first call), so tokens are
   * shared and can be invalidated by activity elsewhere.
   */
  async request<T = unknown>(
    method: HttpMethod,
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const token = await this.#token();
    const res = await this.#send(method, path, opts, token);

    if (res.status === 401) {
      await this.#cache.delete(await this.#cacheKeyFor());
      const retryToken = await this.#token();
      const retry = await this.#send(method, path, opts, retryToken);
      return this.#handle<T>(method, path, retry);
    }

    return this.#handle<T>(method, path, res);
  }

  async #send(
    method: HttpMethod,
    path: string,
    opts: RequestOptions,
    token: string,
  ): Promise<Response> {
    const url = new URL(`${this.#baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-OB-Tenant-Identifier': this.#tenantId,
      },
    };

    // GET and DELETE never carry a body: OneBill's DELETE endpoints take no payload, and a body on
    // GET is rejected by some intermediaries.
    if (method !== 'GET' && method !== 'DELETE' && opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    const doFetch = this.#fetchImpl;
    return doFetch(url.toString(), init);
  }

  /** Turn a response into a result or an error, covering both of OneBill's failure modes. */
  async #handle<T>(method: HttpMethod, path: string, res: Response): Promise<T> {
    return this.#handleParsed<T>(method, path, res, await readBody(res));
  }

  /** As {@link #handle}, but for a body already read — a `Response` can only be consumed once. */
  async #handleParsed<T>(
    method: HttpMethod,
    path: string,
    res: Response,
    parsed: unknown,
  ): Promise<T> {
    if (!res.ok) {
      const hint =
        res.status === 401
          ? ' (token rejected after refresh; check tenant, username, and secret)'
          : res.status === 403
            ? ' (authenticated, but this account lacks permission)'
            : '';
      throw new OneBillApiError(
        `${method} ${path} -> ${res.status}${hint}: ${detailOf(parsed)}`,
        res.status,
        path,
        method,
        parsed,
      );
    }

    // OneBill also reports failures in-band at HTTP 200:
    //   { status: "Bad Request", validationResponse: { validationErrorInfo: [{ message }] } }
    // Only this documented shape is treated as an error. A non-"OK" `status` WITHOUT a
    // validationResponse is left alone, because it has not been observed and `status` is an
    // ordinary data field on some responses.
    const err = inBandError(parsed);
    if (err) {
      throw new OneBillApiError(`${method} ${path} -> OneBill API: ${err}`, res.status, path, method, parsed);
    }

    return parsed as T;
  }
}

/** Parse a response body as JSON, falling back to raw text (an HTML 502 page, say). */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Strip credential-shaped keys from a token-endpoint error body.
 *
 * The library never puts a credential into an error itself — but the *server's* body is attached
 * verbatim to `OneBillApiError.body`, and OneBill's token endpoint takes `client_secret` and the
 * hashed password in the query string. An OAuth implementation that echoes request parameters back
 * in an error would hand a credential to the first consumer that logs `err.body`, which is an
 * entirely reasonable thing for a consumer to do. Shallow by design: this is a known response
 * shape, not a general sanitizer, and a deep walk over an untrusted body invites its own problems.
 */
function withoutCredentials(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = /client_secret|password|access_token|refresh_token|authorization/i.test(k)
      ? '[redacted]'
      : v;
  }
  return out;
}

/** A bounded, log-safe rendering of a response body. */
function detailOf(body: unknown): string {
  const s = typeof body === 'object' && body !== null ? JSON.stringify(body) : String(body);
  return s.length > 500 ? `${s.slice(0, 500)}...` : s;
}

/** The joined validation messages if this body is an in-band error, otherwise `undefined`. */
function inBandError(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const rec = body as { status?: unknown; validationResponse?: unknown };
  if (typeof rec.status !== 'string' || rec.status === 'OK') return undefined;
  if (typeof rec.validationResponse !== 'object' || rec.validationResponse === null) return undefined;

  const info = (rec.validationResponse as { validationErrorInfo?: unknown }).validationErrorInfo;
  const messages = Array.isArray(info)
    ? info
        .map((e) => (typeof e === 'object' && e !== null ? (e as { message?: unknown }).message : undefined))
        .filter((m): m is string => typeof m === 'string')
    : [];

  return messages.length > 0 ? `${rec.status}: ${messages.join('; ')}` : rec.status;
}
