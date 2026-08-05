/**
 * MIME types for the share shells, derived from a URL's extension (T-0293).
 *
 * ── WHY AN EXTENSION IS TRUSTWORTHY *HERE* ──────────────────────────────────
 * Normally it is not. These URLs are the exception: every one of them was minted
 * by `StorageService.resolveKeyToPublicUrl`, which rejects any key whose tail is
 * not `<uuid>.<ext>` and whose extension the server did not itself choose from
 * the signed content type at presign time. A member never supplies the string
 * being read here.
 *
 * The tags matter because an unfurler decides whether it can play or display
 * something from `og:video:type` / `og:image:type` BEFORE it fetches a byte —
 * an absent or wrong type is the difference between an inline player and a bare
 * link.
 */

/**
 * The container type for an uploaded video.
 *
 * `.mov` is deliberately reported as `video/mp4`: QuickTime is a
 * fourcc-compatible container, and `video/quicktime` makes most unfurlers
 * refuse to play the file at all. Uploads are constrained to mp4/webm/mov at
 * presign time, so those are the only three that reach this function.
 */
export function videoMimeFor(url: string): string {
  return url.toLowerCase().split('?')[0].endsWith('.webm') ? 'video/webm' : 'video/mp4';
}

/** The image type, or null when the extension is one we do not want to claim. */
export function imageMimeFor(url: string): string | null {
  const path = url.toLowerCase().split('?')[0];
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.avif')) return 'image/avif';
  // An extensionless URL (the medal-thumbnail proxy, a provider poster route)
  // gets no tag rather than a guess — the unfurler sniffs the real response,
  // and a wrong declared type is worse than a missing one.
  return null;
}

/**
 * Seconds → an ISO 8601 duration (`PT1M30S`), which is the only form
 * schema.org's `VideoObject.duration` accepts. Returns null for a non-positive
 * or missing runtime, so a bad value is omitted rather than published as `PT0S`.
 */
export function isoDuration(seconds: number | null | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h ? `${h}H` : ''}${m ? `${m}M` : ''}${s || (!h && !m) ? `${s}S` : ''}`;
}
