import { toIngressAwareApiPath } from '@/services/globe-render-settings';

const IMAGERY_PREVIEW_HOSTS = [
  'sentinel-s1-l1c.s3.amazonaws.com',
  'sentinel-cogs.s3.us-west-2.amazonaws.com',
  'earth-search.aws.element84.com',
];

// This add-on's own Imagery Watch cache route (rootfs/imagery-relay.mjs's
// cachePreview) -- a root-relative same-origin path, not a foreign host, so
// it's allowed unconditionally rather than checked against
// IMAGERY_PREVIEW_HOSTS (which is only for externally-hosted absolute
// URLs). Checked by exact prefix, not just "isn't parseable as an absolute
// URL", so this can't be satisfied by an unrelated relative-looking string.
const IMAGERY_CACHE_PATH_PREFIX = '/api/imagery-watch/v1/cache/';

export function isAllowedPreviewUrl(url: string | undefined): boolean {
  if (!url) return false;
  if (url.startsWith(IMAGERY_CACHE_PATH_PREFIX)) return true;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && IMAGERY_PREVIEW_HOSTS.some(h => parsed.hostname === h);
  } catch { return false; }
}

// The actual value to put in an <img src>, once isAllowedPreviewUrl (or an
// equivalent same-origin/first-party trust check) has already passed. Two
// cases: our own cache route needs the HA-Ingress-prefix treatment
// (toIngressAwareApiPath) since it's a root-relative path baked into stored
// data server-side with no ingress-token context available at write time;
// an externally-hosted absolute URL just gets re-parsed via `new URL` so a
// malformed/partial value can't smuggle extra markup into the attribute.
export function resolvePreviewImageSrc(url: string): string {
  if (url.startsWith(IMAGERY_CACHE_PATH_PREFIX)) return toIngressAwareApiPath(url);
  return new URL(url).href;
}
