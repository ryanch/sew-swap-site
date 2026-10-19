export type Edge = { makerId: string; recipientId: string };

/**
 * Plans the assignments that close a pod into a loop, without touching any that exist.
 *
 * Only people who make for nobody get a recipient, and only people nobody makes for get a maker.
 * Existing chains inside the pod (A → B → C) are followed so they become part of one big loop
 * rather than being closed on their own: loose people and chains are shuffled and joined end to
 * start. `edges` is every assignment in the swap, since people can make for others outside the pod.
 * Whoever couldn't be matched is returned so the manager can sort them out.
 */
export function planLoop(memberIds: string[], edges: Edge[], random: () => number = Math.random) {
  const inPod = new Set(memberIds);
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, number>();
  for (const e of edges) {
    outgoing.set(e.makerId, [...(outgoing.get(e.makerId) ?? []), e.recipientId]);
    incoming.set(e.recipientId, (incoming.get(e.recipientId) ?? 0) + 1);
  }
  const needsRecipient = memberIds.filter((id) => !outgoing.has(id));
  const needsMaker = memberIds.filter((id) => !incoming.has(id));

  // A chain starts at someone with no maker and runs along single assignments inside the pod to
  // someone who makes for nobody. Branches or links outside the pod leave its end unknown.
  const fragments: { head: string; tail: string }[] = [];
  const tails = new Set<string>();
  const looseRecipients: string[] = [];
  for (const head of needsMaker) {
    const seen = new Set([head]);
    let cur = head;
    let tail: string | null = null;
    for (;;) {
      const out = outgoing.get(cur);
      if (!out) {
        tail = cur;
        break;
      }
      const next = out[0];
      if (out.length > 1 || !inPod.has(next) || seen.has(next) || incoming.get(next) !== 1) break;
      seen.add(next);
      cur = next;
    }
    if (tail === null) looseRecipients.push(head);
    else {
      fragments.push({ head, tail });
      tails.add(tail);
    }
  }
  const looseMakers = needsRecipient.filter((id) => !tails.has(id));

  shuffle(fragments, random);
  const add: Edge[] = [];
  if (fragments.length > 1 || (fragments.length === 1 && fragments[0].head !== fragments[0].tail)) {
    fragments.forEach((f, i) => add.push({ makerId: f.tail, recipientId: fragments[(i + 1) % fragments.length].head }));
  } else if (fragments.length === 1) {
    // One person on their own: they can still take an end of a broken chain below.
    looseMakers.push(fragments[0].tail);
    looseRecipients.push(fragments[0].head);
  }

  shuffle(looseMakers, random);
  const unmatchedRecipients = shuffle(looseRecipients, random);
  const idleMakers: string[] = [];
  for (const maker of looseMakers) {
    const i = unmatchedRecipients.findIndex((r) => r !== maker);
    if (i === -1) idleMakers.push(maker);
    else add.push({ makerId: maker, recipientId: unmatchedRecipients.splice(i, 1)[0] });
  }

  // Everyone in the pod should make for someone. When nobody is left without a maker (e.g. someone
  // outside the pod already makes for the only other person), give a second maker to whoever has
  // the fewest. That costs nobody extra work, unlike giving a maker a second recipient.
  for (const id of add.map((e) => e.recipientId)) incoming.set(id, (incoming.get(id) ?? 0) + 1);
  const unmatchedMakers: string[] = [];
  for (const maker of idleMakers) {
    const already = new Set([...(outgoing.get(maker) ?? []), ...add.filter((e) => e.makerId === maker).map((e) => e.recipientId)]);
    const options = shuffle(memberIds.filter((id) => id !== maker && !already.has(id)), random);
    const best = options.sort((a, b) => (incoming.get(a) ?? 0) - (incoming.get(b) ?? 0))[0];
    if (best === undefined) unmatchedMakers.push(maker);
    else {
      add.push({ makerId: maker, recipientId: best });
      incoming.set(best, (incoming.get(best) ?? 0) + 1);
    }
  }
  return { add, unmatchedMakers, unmatchedRecipients };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
