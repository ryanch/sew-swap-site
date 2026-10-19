export type Swap = {
  swapId: string;
  title: string;
  description: string;
  makingDeadline: string;
  partnersAnnounced: string;
  shipBy: string;
  signUpOpens: string;
  signUpCloses: string;
  /** How many have signed up. Only sent to the swap's managers and admins, on swap lists. */
  swapperCount?: number;
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

/** Someone a member makes for, or who makes for them. */
export type Person = { userId: string; name: string; instagramHandle: string | null };

/** A participant as the swap's managers see them. Skill, pod and pairings are never shown to participants. */
export type SwapMember = {
  userId: string;
  email: string;
  displayName: string | null;
  name: string;
  joinedAt: string;
  instagramHandle: string | null;
  instagramConfirmed: boolean;
  skillLevel: number | null;
  pod: { podId: string; name: string };
  country: string | null;
  region: string | null;
  city: string | null;
  makingFor: Person[];
  madeBy: Person[];
};

export type Pod = { podId: string; name: string; count: number };

/** The Default pod holds everyone not put in another pod. */
export const DEFAULT_POD = 'default';

export const MAX_RECIPIENTS = 5;

export const SKILL_LEVELS: [number, string][] = [
  [1, '1 - Beginner'],
  [2, '2'],
  [3, '3'],
  [4, '4'],
  [5, '5 - Expert'],
];

export type MemberFilters = {
  pod?: string;
  exceptPod?: string;
  q?: string;
  country?: string;
  region?: string;
  skill?: string;
  needs?: 'maker' | 'recipient';
};

export type MembersPage = { members: SwapMember[]; total: number; nextCursor: string | null };

export function membersUrl(swapId: string, filters: MemberFilters & { after?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return `/api/swaps/${swapId}/members${qs ? `?${qs}` : ''}`;
}

export const instagramUrl = (handle: string) => `https://www.instagram.com/${handle}/`;
