import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/** The subset of the request we need; avoids an `any`-typed parameter. */
interface ProxyAwareRequest {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
}

/**
 * Rate-limits by the real client IP rather than the reverse proxy's.
 *
 * In production the request path is Cloudflare -> Caddy -> this API, so `req.ip`
 * is the proxy on every request and the default {@link ThrottlerGuard} lumps all
 * traffic into a single 120/min bucket — one busy member would throttle the whole
 * regiment, and a single abusive client would be indistinguishable from everyone
 * else.
 *
 * Reading `CF-Connecting-IP` directly sidesteps Express's `trust proxy` hop
 * counting, which is the safer of the two fixes: `trust proxy: true` would let any
 * client forge `X-Forwarded-For` and therefore forge the identity used for
 * logging, banning and rate limiting, while a hardcoded hop count silently breaks
 * the moment a proxy is added or removed.
 *
 * `CF-Connecting-IP` is set by Cloudflare and, because the origin only accepts
 * traffic through Cloudflare (Authenticated Origin Pulls), cannot be spoofed by a
 * client. When absent — local dev, direct origin access — this falls back to
 * `req.ip`, so behaviour outside production is unchanged.
 */
@Injectable()
export class CfAwareThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: ProxyAwareRequest): Promise<string> {
    const cfIp = req.headers?.['cf-connecting-ip'];
    const tracker = typeof cfIp === 'string' && cfIp.length > 0 ? cfIp : (req.ip ?? 'unknown');
    return Promise.resolve(tracker);
  }
}
