import type { Timestamp, Transaction } from '@google-cloud/firestore';
import { col, getMany } from './firestore';

/** The `users/{UserId}` fields other modules read. */
export type UserDoc = { UserId: string; Email: string; DisplayName: string | null };

/** The `userProfiles/{UserId}` doc: the mailing address and Instagram from swap sign-up. */
export type ProfileDoc = {
  UserId: string;
  RecipientName: string | null;
  RecipientFirstName?: string | null;
  RecipientLastName?: string | null;
  Country: string | null;
  AddressLine1: string | null;
  AddressLine2: string | null;
  City: string | null;
  Region: string | null;
  PostalCode: string | null;
  InstagramHandle: string | null;
  InstagramStatus: string | null;
  InstagramCheckedAt: Timestamp | null;
  InstagramStrategy: string | null;
  /** The post link that passed the check, to prefill the next sign-up. */
  InstagramPostUrl?: string | null;
};

/** What to call someone: their display name, else the name on their address, else their email. */
export function personName(user: Pick<UserDoc, 'Email' | 'DisplayName'>, profile?: Pick<ProfileDoc, 'RecipientName'> | null) {
  return user.DisplayName || profile?.RecipientName || user.Email;
}

export type Person = { userId: string; email: string; name: string; instagramHandle: string | null };

/** Users and profiles of `userIds`, read together. Missing users are left out. */
export async function loadPeople(userIds: string[], tx?: Transaction) {
  const [users, profiles] = await Promise.all([
    getMany<UserDoc>(col.users, userIds, tx),
    getMany<ProfileDoc>(col.userProfiles, userIds, tx),
  ]);
  return { users, profiles };
}

/** Name, email and Instagram of each of `userIds`, for display. */
export async function lookupPeople(userIds: string[], tx?: Transaction): Promise<Map<string, Person>> {
  const { users, profiles } = await loadPeople(userIds, tx);
  const out = new Map<string, Person>();
  for (const [id, u] of users) {
    const p = profiles.get(id);
    out.set(id, { userId: id, email: u.Email, name: personName(u, p), instagramHandle: p?.InstagramHandle ?? null });
  }
  return out;
}
