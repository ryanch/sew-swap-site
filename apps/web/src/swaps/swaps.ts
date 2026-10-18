export type Swap = {
  swapId: string;
  title: string;
  description: string;
  makingDeadline: string;
  partnersAnnounced: string;
  shipBy: string;
  signUpOpens: string;
  signUpCloses: string;
};

/** 'YYYY-MM-DD' to 'March 5, 2026'. Built from the parts so the timezone can't shift the day. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

export const DATE_FIELDS = [
  ['signUpOpens', 'Sign-up opens'],
  ['signUpCloses', 'Sign-up closes'],
  ['partnersAnnounced', 'Partners announced'],
  ['makingDeadline', 'Making deadline'],
  ['shipBy', 'Ship by'],
] as const;

export type SignUpStatus = 'upcoming' | 'open' | 'closed';

export type SwapMember = { userId: string; email: string; displayName: string | null; joinedAt: string };
