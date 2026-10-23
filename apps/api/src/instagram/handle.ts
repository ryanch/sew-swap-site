// Instagram usernames: letters, numbers, periods and underscores, at most 30, no leading,
// trailing or doubled period. Instagram treats them case-insensitively.
export const HANDLE_RE = /^(?!\.)(?!.*\.\.)[a-z0-9._]{1,30}(?<!\.)$/;

export type CleanResult = { handle: string } | { error: string };

/**
 * Turns what people paste ("@John ", "https://www.instagram.com/john/?hl=en",
 * "instagram.com/john") into the bare username "john".
 */
export function cleanInstagramHandle(input: string): CleanResult {
  let s = input.trim().replace(/^@+/, '');
  s = s.replace(/^https?:\/\//i, '').replace(/^(www\.|m\.)/i, '');
  s = s.replace(/^instagram\.com\/?/i, '');
  s = s.split(/[/?#]/)[0].replace(/^@+/, '').trim().toLowerCase();
  if (!s) return { error: 'Please type your Instagram name.' };
  if (!HANDLE_RE.test(s)) {
    return {
      error:
        "That doesn't look like an Instagram name. Instagram names use only letters, numbers, periods and underscores.",
    };
  }
  return { handle: s };
}
