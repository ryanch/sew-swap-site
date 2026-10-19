export type Swap = {
  swapId: string;
  title: string;
  description: string;
  makingDeadline: string;
  partnersAnnounced: string;
  shipBy: string;
  signUpOpens: string;
  signUpCloses: string;
  /** When the manager published who makes for whom, or null. */
  makersPublishedAt: string | null;
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

/** A package the maker has sent. `trackingUrl` is null when the carrier is "Other". */
export type Shipment = { shippedAt: string; carrier: string; trackingNumber: string; trackingUrl: string | null };

/** The other end of a pairing, whether the maker has confirmed it, and its tracking once shipped. */
export type Paired = Person & { confirmed: boolean; shipped: Shipment | null };

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
  makingFor: Paired[];
  madeBy: Paired[];
  /** The last confirmation reminder this person was sent for this swap. */
  lastRemindedAt: string | null;
  /** The last shipping reminder this person was sent for this swap. */
  lastShipRemindedAt: string | null;
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
  needs?: 'maker' | 'recipient' | 'confirmation' | 'shipping';
};

export type MembersPage = { members: SwapMember[]; total: number; nextCursor: string | null };

export function membersUrl(swapId: string, filters: MemberFilters & { after?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return `/api/swaps/${swapId}/members${qs ? `?${qs}` : ''}`;
}

/** An ISO timestamp as 'March 5, 2026'. */
export const formatTimestamp = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

/** How many people in plain words: '1 person', '3 people'. */
export const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);

/** Where a manager stands before and after publishing makers (GET …/publish). */
export type PublishSummary = {
  publishedAt: string | null;
  partnersAnnounced: string;
  participants: number;
  withoutRecipient: number;
  withoutMaker: number;
  pairings: number;
  pairingsConfirmed: number;
  makers: number;
  makersConfirmed: number;
  pairingsShipped: number;
  /** Makers who have shipped to everyone they make for. */
  makersShipped: number;
};

export const MAX_REMINDERS_PER_BATCH = 50;

export const instagramUrl = (handle: string) => `https://www.instagram.com/${handle}/`;

/** The carriers a maker can pick. The API builds the tracking links. */
export const CARRIERS = [
  ['usps', 'USPS'],
  ['ups', 'UPS'],
  ['fedex', 'FedEx'],
  ['dhl', 'DHL'],
  ['canadapost', 'Canada Post'],
  ['purolator', 'Purolator'],
  ['canpar', 'Canpar Express'],
  ['other', 'Other'],
] as const;

export const carrierLabel = (id: string) => CARRIERS.find(([c]) => c === id)?.[1] ?? id;

/**
 * A likely carrier from the tracking number's format, to pre-select for the maker. Only a guess:
 * some formats are shared (Purolator and FedEx both use 12 digits), so the maker can change it.
 */
export function guessCarrier(input: string): string {
  const n = input.toUpperCase().replace(/[\s-]+/g, '');
  if (/^1Z[A-Z0-9]{16}$/.test(n)) return 'ups';
  if (/^[A-Z]{2}\d{9}CA$/.test(n)) return 'canadapost';
  if (/^[A-Z]{2}\d{9}US$/.test(n) || /^9\d{19,21}$/.test(n)) return 'usps';
  if (/^\d{16}$/.test(n)) return 'canadapost';
  if (/^\d{10}$/.test(n)) return 'dhl';
  if (/^(\d{12}|\d{15})$/.test(n)) return 'fedex';
  return '';
}
