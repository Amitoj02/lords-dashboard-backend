/** The subset of an Express request this resolver reads. */
export interface ClientAddressedRequest {
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
}

/**
 * The one definition of "which client is this request from".
 *
 * ── WHY THIS IS A SHARED FUNCTION AND NOT TWO COPIES ────────────────────────
 * Two features now key on the caller's address: the rate limiter
 * ({@link CfAwareThrottlerGuard}) and the gallery view counter, which dedupes a
 * view per address. If those two ever disagreed about who the caller is, one of
 * them would be wrong — and the wrong one would be silently wrong. So the rule
 * lives here and both read it.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 * `CF-Connecting-IP` when — and only when — `TRUST_CF_CONNECTING_IP=true`,
 * otherwise the socket peer `req.ip`.
 *
 * ⚠️ `CF-Connecting-IP` is a CLIENT-SUPPLIABLE header. Trusting it is only safe
 * once the origin provably cannot be reached except through Cloudflare —
 * Authenticated Origin Pulls (mTLS), or a firewall pinning :443 to Cloudflare's
 * ranges (LDA-H2/H3). Until then an attacker reaching the origin directly could
 * mint a fresh address per request: unlimited rate-limit buckets, and unlimited
 * view increments. The default is therefore `req.ip`, which cannot be forged.
 *
 * Express `trust proxy` is deliberately NOT used to recover the address — the
 * codebase rejects it (any client can forge `X-Forwarded-For`, and a hardcoded
 * hop count breaks silently the moment a proxy is added or removed).
 *
 * CONSEQUENCE, stated plainly: with the header untrusted and a proxy in front,
 * `req.ip` is the proxy on every request, so every visitor shares one address.
 * The rate limiter has always had that property; the view counter inherits it,
 * which means views collapse toward one-per-item behind the edge until
 * TRUST_CF_CONNECTING_IP is turned on. Flipping that one flag fixes both at once
 * — which is the whole reason they read the same function.
 */
export function resolveClientAddress(req: ClientAddressedRequest): string {
  const cfIp = req.headers?.['cf-connecting-ip'];
  if (trustCfConnectingIp() && typeof cfIp === 'string' && cfIp.length > 0) {
    return cfIp;
  }
  return req.ip ?? 'unknown';
}

/**
 * Read at call time rather than captured at import, so a test (and the e2e
 * suites) can flip the env var without re-importing the module graph.
 */
function trustCfConnectingIp(): boolean {
  return process.env.TRUST_CF_CONNECTING_IP === 'true';
}
