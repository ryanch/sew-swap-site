import { cleanInstagramHandle } from './handle';

export type PostLink = { shortcode: string; url: string };

const SHORTCODE = '[A-Za-z0-9_-]{1,64}';
// /p/CODE, /reel/CODE, /reels/CODE, /tv/CODE, optionally after the owner's name (/john/p/CODE).
const POST_PATH = new RegExp(`^(?:[a-z0-9._]{1,30}/)?(?:p|reels?|tv)/(${SHORTCODE})(?:/|$)`, 'i');
// The phone app sometimes copies a short link that redirects to the post.
const SHARE_PATH = new RegExp(`^share/(?:(?:p|reels?)/)?(${SHORTCODE})(?:/|$)`, 'i');

const INSTAGRAM_PATHS = new Set(['p', 'reel', 'reels', 'tv', 'share', 'stories', 'explore', 'accounts', 'direct']);

const NOT_A_POST = "That doesn't look like a link to an Instagram post. Press \"How do I copy a post link?\" for help.";
const NAME_NOT_POST =
  'That looks like an Instagram name or profile. We need a link to one of your posts. Press "How do I copy a post link?" for help.';

/**
 * Turns what people paste ("https://www.instagram.com/p/ABC/?utm_source=ig_web_copy_link",
 * "instagram.com/reel/ABC", "www.instagram.com/john/p/ABC/") into the post's address.
 */
export function parsePostLink(input: string): PostLink | { error: string } {
  const s = input.trim();
  if (!s) return { error: 'Please paste a link to one of your Instagram posts.' };
  const m = /^(?:https?:\/\/)?(?:(?:www|m)\.)?instagram\.com\/+([^?#\s]*)(?:[?#]\S*)?$/i.exec(s);
  if (!m) {
    if (!s.includes('/') && 'handle' in cleanInstagramHandle(s)) return { error: NAME_NOT_POST };
    return { error: NOT_A_POST };
  }
  const path = m[1];
  const share = SHARE_PATH.exec(path);
  if (share) return { shortcode: share[1], url: `https://www.instagram.com/${path.replace(/\/*$/, '/')}` };
  const post = POST_PATH.exec(path);
  if (post) {
    const kind = /(?:^|\/)tv\//i.test(path) ? 'tv' : /(?:^|\/)reels?\//i.test(path) ? 'reel' : 'p';
    return { shortcode: post[1], url: `https://www.instagram.com/${kind}/${post[1]}/` };
  }
  // A link to a profile rather than a post (but not a cut-off post link like "instagram.com/p/").
  const first = path.split('/')[0].toLowerCase();
  if (!INSTAGRAM_PATHS.has(first) && 'handle' in cleanInstagramHandle(s)) return { error: NAME_NOT_POST };
  return { error: NOT_A_POST };
}
