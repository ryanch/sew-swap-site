/**
 * Local testing only: creates an open swap owned by the admin, with 50 people already signed up.
 *
 *   docker compose exec api npm run seed:demo
 *
 * 5 live in Hawaii, 8 in Canada and 37 elsewhere in the US. Skill levels 1–5 are spread evenly
 * (10 each) and everyone starts in the Default pod with no pairings. The same 50 people
 * (demo01@example.test … demo50@example.test) are reused, so each run adds one new swap.
 * The emulator keeps data in memory, so run it again after restarting `firestore`.
 */
import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { col, db, memberId, now } from '../db/firestore';
import { validateAddress, type Address } from '../profile/address';
import { addressColumns } from '../routes/profile';

type Place = Omit<Address, 'name' | 'firstName' | 'lastName' | 'line1' | 'line2'>;
const us = (city: string, region: string, postalCode: string): Place => ({ city, region, postalCode, country: 'US' });
const ca = (city: string, region: string, postalCode: string): Place => ({ city, region, postalCode, country: 'CA' });

const HAWAII = [
  us('Honolulu', 'HI', '96813'),
  us('Hilo', 'HI', '96720'),
  us('Kailua', 'HI', '96734'),
  us('Kahului', 'HI', '96732'),
  us('Lihue', 'HI', '96766'),
];

const CANADA = [
  ca('Toronto', 'ON', 'M5V 2T6'),
  ca('Ottawa', 'ON', 'K1P 1J1'),
  ca('Vancouver', 'BC', 'V6B 1A1'),
  ca('Victoria', 'BC', 'V8W 1P6'),
  ca('Montreal', 'QC', 'H2X 1Y4'),
  ca('Calgary', 'AB', 'T2P 1J9'),
  ca('Halifax', 'NS', 'B3H 1A1'),
  ca('Winnipeg', 'MB', 'R3C 0V8'),
];

// Some states repeat so bulk-adding by state has something to find.
const MAINLAND = [
  us('Los Angeles', 'CA', '90012'),
  us('San Francisco', 'CA', '94103'),
  us('San Diego', 'CA', '92101'),
  us('Sacramento', 'CA', '95814'),
  us('Oakland', 'CA', '94607'),
  us('New York', 'NY', '10001'),
  us('Brooklyn', 'NY', '11201'),
  us('Buffalo', 'NY', '14202'),
  us('Albany', 'NY', '12207'),
  us('Austin', 'TX', '78701'),
  us('Houston', 'TX', '77002'),
  us('Dallas', 'TX', '75201'),
  us('San Antonio', 'TX', '78205'),
  us('Chicago', 'IL', '60601'),
  us('Springfield', 'IL', '62701'),
  us('Evanston', 'IL', '60201'),
  us('Seattle', 'WA', '98101'),
  us('Spokane', 'WA', '99201'),
  us('Tacoma', 'WA', '98402'),
  us('Miami', 'FL', '33130'),
  us('Orlando', 'FL', '32801'),
  us('Tampa', 'FL', '33602'),
  us('Portland', 'OR', '97204'),
  us('Eugene', 'OR', '97401'),
  us('Denver', 'CO', '80202'),
  us('Boulder', 'CO', '80302'),
  us('Boston', 'MA', '02108'),
  us('Cambridge', 'MA', '02139'),
  us('Atlanta', 'GA', '30303'),
  us('Savannah', 'GA', '31401'),
  us('Philadelphia', 'PA', '19107'),
  us('Pittsburgh', 'PA', '15222'),
  us('Phoenix', 'AZ', '85004'),
  us('Tucson', 'AZ', '85701'),
  us('Minneapolis', 'MN', '55401'),
  us('St. Paul', 'MN', '55102'),
  us('Columbus', 'OH', '43215'),
];

const FIRST = [
  'Ava', 'Ben', 'Cora', 'Dev', 'Elsie', 'Finn', 'Grace', 'Hugo', 'Iris', 'Jonah',
  'Kai', 'Lena', 'Milo', 'Nora', 'Owen', 'Pia', 'Quinn', 'Rosa', 'Sam', 'Tess',
  'Uma', 'Vic', 'Wren', 'Xena', 'Yara', 'Zane', 'Alma', 'Bea', 'Cal', 'Dina',
  'Eli', 'Fay', 'Gus', 'Hana', 'Ike', 'June', 'Kit', 'Lola', 'Max', 'Nell',
  'Opal', 'Pete', 'Ruby', 'Sid', 'Tara', 'Ula', 'Vera', 'Walt', 'Yuki', 'Zoe',
];
const LAST = ['Stitch', 'Baste', 'Hemming', 'Quilter', 'Bobbin', 'Thimble', 'Seamwell', 'Pinney', 'Selvage', 'Tuck'];

async function main() {
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('This only runs against the Firestore emulator (FIRESTORE_EMULATOR_HOST).');
  const adminEmail = config.auth.adminEmails[0];
  if (!adminEmail) throw new Error('Set ADMIN_EMAILS so the swap has an owner.');

  const places = [...HAWAII, ...CANADA, ...MAINLAND];
  const people = places.map((place, i) => {
    const first = FIRST[i];
    const last = LAST[i % LAST.length];
    const checked = validateAddress({ firstName: first, lastName: last, line1: `${100 + i} Main St`, line2: '', ...place });
    if ('error' in checked) throw new Error(`${place.city}: ${checked.error}`);
    return {
      email: `demo${String(i + 1).padStart(2, '0')}@example.test`,
      instagram: `demo_${first}_${last}`.toLowerCase(),
      address: checked.address,
      // Every fifth person shares a level, so each of 1–5 gets 10 people across all the places.
      skillLevel: (i % 5) + 1,
    };
  });

  const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  const swapId = randomUUID();
  const title = `Demo swap ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

  await db.runTransaction(async (tx) => {
    // Reads first: who already has an account (signing in made it, or an earlier run did).
    const emails = [adminEmail, ...people.map((p) => p.email)];
    const found = await tx.getAll(...emails.map((e) => col.userEmails.doc(e)));
    const ids = new Map(found.filter((s) => s.exists).map((s) => [s.id, (s.data() as { UserId: string }).UserId]));
    const adminSnap = ids.has(adminEmail) ? await tx.get(col.users.doc(ids.get(adminEmail)!)) : null;
    const adminRoles: string[] = (adminSnap?.data()?.Roles as string[] | undefined) ?? [];

    const at = now();
    const userId = (email: string, roles: string[] = []) => {
      let id = ids.get(email);
      if (!id) {
        id = randomUUID();
        ids.set(email, id);
        tx.create(col.userEmails.doc(email), { UserId: id });
        tx.create(col.users.doc(id), {
          UserId: id,
          Email: email,
          DisplayName: null,
          GoogleSub: null,
          Roles: roles,
          RoleGrants: Object.fromEntries(roles.map((r) => [r, { GrantedBy: null, GrantedAt: at }])),
          EmailVerifiedAt: null,
          LastLoginAt: null,
          CreatedAt: at,
          UpdatedAt: at,
        });
      }
      return id;
    };

    // The admin may not have signed in yet since the emulator restarted. Signing in later finds this account.
    const adminId = userId(adminEmail, ['admin']);
    if (adminSnap && !adminRoles.includes('admin')) {
      tx.set(
        col.users.doc(adminId),
        { Roles: [...adminRoles, 'admin'].sort(), RoleGrants: { admin: { GrantedBy: null, GrantedAt: at } }, UpdatedAt: at },
        { merge: true },
      );
    }
    tx.create(col.swaps.doc(swapId), {
      SwapId: swapId,
      Title: title,
      Description: 'Seeded for testing pods and pairing: 50 makers, 5 in Hawaii, 8 in Canada, 37 elsewhere in the US.',
      SignUpOpens: day(-1),
      SignUpCloses: day(14),
      PartnersAnnounced: day(21),
      MakingDeadline: day(60),
      ShipBy: day(65),
      MakersPublishedAt: null,
      MakersPublishedBy: null,
      CreatedBy: adminId,
      CreatedAt: at,
      UpdatedAt: at,
    });
    tx.create(col.swapMembers.doc(memberId(swapId, adminId, 'manager')), {
      SwapId: swapId,
      UserId: adminId,
      Role: 'manager',
      CreatedAt: at,
    });

    for (const p of people) {
      const id = userId(p.email);
      tx.set(
        col.userProfiles.doc(id),
        {
          UserId: id,
          ...addressColumns(p.address),
          InstagramHandle: p.instagram,
          InstagramStatus: 'public',
          InstagramCheckedAt: at,
          InstagramStrategy: 'seed',
          UpdatedAt: at,
        },
        { merge: true },
      );
      tx.create(col.swapMembers.doc(memberId(swapId, id, 'participant')), {
        SwapId: swapId,
        UserId: id,
        Role: 'participant',
        SkillLevel: p.skillLevel,
        PodId: null,
        InstagramPublicConfirmed: null,
        CreatedAt: at,
      });
    }
  });

  console.log(`Created "${title}" with ${people.length} people.`);
  console.log(`Pods:    ${config.appBaseUrl}/manage/swaps/${swapId}/pods`);
  console.log(`Members: ${config.appBaseUrl}/manage/swaps/${swapId}/members`);
}

main()
  .then(async () => {
    await db.terminate();
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
