/** Wait until web -> api -> Spanner/Mailpit are all up (the emulator bootstrap takes a few seconds). */
export default async function globalSetup() {
  const url = `${process.env.BASE_URL ?? 'http://localhost:5173'}/api/health`;
  const deadline = Date.now() + 90_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Stack not healthy at ${url} after 90s (last: ${last})`);
}
