import type { IgResult, InstagramStrategy, PostStrategy } from './check';
import { HANDLE_RE } from './handle';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// Instagram serves link-preview crawlers a page with og: tags; browsers get an empty JS shell.
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
// Instagram's own web app id, sent by instagram.com when it calls its JSON API.
const IG_APP_ID = '936619743392459';

/**
 * The JSON endpoint instagram.com uses for profile pages. Answers `is_private` directly,
 * but logged-out requests from cloud IPs are often refused with 401 "Please wait a few minutes".
 */
export const webProfileInfo: InstagramStrategy = {
  name: 'webProfileInfo',
  async check(handle, signal) {
    const res = await fetch(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`, {
      headers: { 'User-Agent': BROWSER_UA, 'x-ig-app-id': IG_APP_ID, Accept: 'application/json' },
      redirect: 'manual',
      signal,
    });
    if (res.status === 404) return 'not_found';
    if (res.status !== 200) return 'unknown';
    const body = (await res.json().catch(() => null)) as { data?: { user?: { is_private?: unknown } | null } } | null;
    if (!body?.data) return 'unknown';
    if (body.data.user === null) return 'not_found';
    const isPrivate = body.data.user?.is_private;
    if (typeof isPrivate !== 'boolean') return 'unknown';
    return isPrivate ? 'private' : 'public';
  },
};

async function fetchProfilePage(handle: string, signal: AbortSignal) {
  const res = await fetch(`https://www.instagram.com/${encodeURIComponent(handle)}/`, {
    headers: { 'User-Agent': CRAWLER_UA, 'Accept-Language': 'en-US' },
    redirect: 'manual',
    signal,
  });
  return { status: res.status, html: res.status === 200 ? await res.text() : '' };
}

const isProfilePage = (html: string) => /<meta[^>]+property="og:type"[^>]+content="profile"/.test(html);

// Before trusting "no profile tags" to mean "no such account", make sure a well-known
// account still gets them. If it doesn't, Instagram changed the page and we can't tell.
const CONTROL_HANDLE = 'instagram';
let controlOk: { ok: boolean; at: number } | null = null;

async function crawlerStillWorks(signal: AbortSignal): Promise<boolean> {
  if (controlOk && Date.now() - controlOk.at < 10 * 60_000) return controlOk.ok;
  const { status, html } = await fetchProfilePage(CONTROL_HANDLE, signal);
  controlOk = { ok: status === 200 && isProfilePage(html), at: Date.now() };
  return controlOk.ok;
}

/**
 * The profile page as a link-preview crawler sees it. Tells real accounts from missing ones,
 * but the page usually looks the same for public and private accounts, so it mostly answers 'exists'.
 */
export const crawlerPage: InstagramStrategy = {
  name: 'crawlerPage',
  async check(handle, signal) {
    const { status, html } = await fetchProfilePage(handle, signal);
    if (status !== 200) return 'unknown';
    if (isProfilePage(html)) {
      if (/This account is private|"is_private":\s*true/.test(html)) return 'private';
      if (/"is_private":\s*false/.test(html)) return 'public';
      return 'exists';
    }
    return (await crawlerStillWorks(signal)) ? 'not_found' : 'unknown';
  },
};

/**
 * The post's owner, from the page a link-preview crawler gets: `og:url` is
 * "https://www.instagram.com/<owner>/p/<code>/", and `og:description` ends "- <owner> on <date>: …".
 * Null when the page has neither, which is what a missing post or a private account's post gets.
 */
export function postOwner(html: string): string | null {
  const meta = (property: string) =>
    new RegExp(`<meta[^>]+property="og:${property}"[^>]+content="([^"]*)"`).exec(html)?.[1] ?? '';
  const candidates = [
    /^https:\/\/www\.instagram\.com\/([^/]+)\/(?:p|reels?|tv)\//.exec(meta('url'))?.[1],
    / - ([A-Za-z0-9._]{1,30}) on [A-Z][a-z]+ \d/.exec(meta('description'))?.[1],
  ];
  for (const c of candidates) {
    const handle = c?.toLowerCase();
    if (handle && HANDLE_RE.test(handle)) return handle;
  }
  return null;
}

async function fetchPostPage(url: string, signal: AbortSignal) {
  // Share links redirect to the post. Follow a few hops, but only within instagram.com.
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(url, {
      headers: { 'User-Agent': CRAWLER_UA, 'Accept-Language': 'en-US' },
      redirect: 'manual',
      signal,
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url);
      if (next.protocol !== 'https:' || !/(^|\.)instagram\.com$/.test(next.hostname)) break;
      url = next.href;
      continue;
    }
    return { status: res.status, html: res.status === 200 ? await res.text() : '' };
  }
  return { status: 0, html: '' };
}

// Kevin Systrom's first post (2010). If even it shows no owner, Instagram changed the page.
const CONTROL_POST = 'https://www.instagram.com/p/C/';
let controlPostOk: { ok: boolean; at: number } | null = null;

async function postCrawlerStillWorks(signal: AbortSignal): Promise<boolean> {
  if (controlPostOk && Date.now() - controlPostOk.at < 10 * 60_000) return controlPostOk.ok;
  const { status, html } = await fetchPostPage(CONTROL_POST, signal);
  controlPostOk = { ok: status === 200 && postOwner(html) !== null, at: Date.now() };
  return controlPostOk.ok;
}

/** The post as a link-preview crawler sees it. Readable means public, and the page names the owner. */
export const crawlerPost: PostStrategy = {
  name: 'crawlerPost',
  async check(url, signal) {
    const { status, html } = await fetchPostPage(url, signal);
    if (status !== 200) return { result: 'unknown' };
    const handle = postOwner(html);
    if (handle) return { result: 'public', handle };
    return { result: (await postCrawlerStillWorks(signal)) ? 'not_found' : 'unknown' };
  },
};

/** Local and e2e only, so tests never call Instagram. The handle's prefix picks the answer. */
export const fake: InstagramStrategy = {
  name: 'fake',
  async check(handle) {
    const prefixes: [string, IgResult][] = [
      ['private', 'private'],
      ['nosuch', 'not_found'],
      ['exists', 'exists'],
      ['unknown', 'unknown'],
    ];
    return prefixes.find(([p]) => handle.startsWith(p))?.[1] ?? 'public';
  },
};

/**
 * Local and e2e only. The shortcode, lowercased, is the owner's name, and its prefix picks the answer:
 * "nosuch" and "private" can't be read, "unknown" and "exists" act as if Instagram is blocking us.
 */
export const fakePost: PostStrategy = {
  name: 'fakePost',
  async check(url) {
    const code = /\/([^/]+)\/?$/.exec(url)?.[1].toLowerCase() ?? '';
    if (/^(nosuch|private)/.test(code)) return { result: 'not_found' };
    if (/^(unknown|exists)/.test(code) || !HANDLE_RE.test(code)) return { result: 'unknown' };
    return { result: 'public', handle: code };
  },
};

export const STRATEGIES: Record<string, InstagramStrategy> = { webProfileInfo, crawlerPage, fake };
export const POST_STRATEGIES: Record<string, PostStrategy> = { crawlerPost, fakePost };
