// Where to go after signing in, for someone sent to /login from a page that needs it (like the
// /makes link in an email). Kept in localStorage because the sign-in link in the email usually opens
// a new tab, which has no router state or sessionStorage. Only same-site paths are used.

const KEY = 'sewSwap.returnTo';

const safe = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//');

export function rememberReturnTo(path: unknown) {
  try {
    if (safe(path) && path !== '/') localStorage.setItem(KEY, path);
  } catch {
    // Storage can be blocked; people then land on the home page, which links onward.
  }
}

/** The remembered path (once), or '/'. */
export function takeReturnTo(): string {
  try {
    const path = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    return safe(path) ? path : '/';
  } catch {
    return '/';
  }
}
