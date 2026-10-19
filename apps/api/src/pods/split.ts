export type SplitMember = {
  userId: string;
  skillLevel: number | null;
  country: string | null;
  region: string | null;
  postalCode: string | null;
};

const byText = (a: string | null, b: string | null) => (a ?? '￿').localeCompare(b ?? '￿');

/**
 * Breaks a pod into pods of at most `size` people, as even as possible (10 by 4 → 4, 3, 3).
 * People are ordered by skill, then country, state and postal code, so each new pod holds
 * makers of similar skill who live near each other. Unrated people go last.
 * New pods are named "<name> 1", "<name> 2", … skipping names already used in the swap.
 */
export function planSplit(members: SplitMember[], size: number, name: string, takenNames: string[]) {
  const sorted = [...members].sort(
    (a, b) =>
      (a.skillLevel ?? 99) - (b.skillLevel ?? 99) ||
      byText(a.country, b.country) ||
      byText(a.region?.toUpperCase() ?? null, b.region?.toUpperCase() ?? null) ||
      byText(a.postalCode, b.postalCode) ||
      a.userId.localeCompare(b.userId),
  );
  const count = Math.ceil(sorted.length / size);
  const base = Math.floor(sorted.length / count);
  const extra = sorted.length % count;
  const taken = new Set(takenNames.map((n) => n.toLowerCase()));
  const pods: { name: string; userIds: string[] }[] = [];
  let next = 0;
  let n = 1;
  for (let i = 0; i < count; i++) {
    while (taken.has(`${name} ${n}`.toLowerCase())) n++;
    const take = base + (i < extra ? 1 : 0);
    pods.push({ name: `${name} ${n}`, userIds: sorted.slice(next, next + take).map((m) => m.userId) });
    next += take;
    n++;
  }
  return pods;
}
