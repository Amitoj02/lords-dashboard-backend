import { ExecutionContext, Injectable } from '@nestjs/common';
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
 * ⚠️ `CF-Connecting-IP` is a CLIENT-SUPPLIABLE header. Trusting it is only safe
 * when the origin provably cannot be reached except through Cloudflare — i.e.
 * Authenticated Origin Pulls (mTLS) or a firewall pinning :443 to Cloudflare's IP
 * ranges (LDA-H2). Without that, an attacker who reaches the origin directly
 * (LDA-H3) sets a fresh CF-Connecting-IP per request and gets unlimited
 * independent rate-limit buckets — and, because the in-memory store keys on that
 * value, also grows throttler memory without bound.
 *
 * So the header is trusted ONLY when TRUST_CF_CONNECTING_IP=true, which the
 * operator sets exactly once the Cloudflare-only-ingress control is enforced.
 * Otherwise (default, and everywhere that control is not in place) the key is the
 * socket peer `req.ip`, which cannot be forged.
 */
@Injectable()
export class CfAwareThrottlerGuard extends ThrottlerGuard {
  private readonly trustCfHeader = process.env.TRUST_CF_CONNECTING_IP === 'true';

  /**
   * Disable rate limiting under NODE_ENV=test. The e2e suites drive many requests
   * from a single client IP into one shared bucket, so per-route limits (added for
   * LDA-H3) would produce flaky 429s that have nothing to do with what a suite is
   * asserting. There are no throttle-specific e2e tests to preserve.
   */
  protected shouldSkip(_context: ExecutionContext): Promise<boolean> {
    return Promise.resolve(process.env.NODE_ENV === 'test');
  }

  protected getTracker(req: ProxyAwareRequest): Promise<string> {
    const cfIp = req.headers?.['cf-connecting-ip'];
    const tracker =
      this.trustCfHeader && typeof cfIp === 'string' && cfIp.length > 0
        ? cfIp
        : (req.ip ?? 'unknown');
    return Promise.resolve(tracker);
  }
}
