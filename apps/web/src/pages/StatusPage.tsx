import { useCallback, useEffect, useState } from 'react';

type Check = { ok: boolean; error?: string; roundTripMs?: number; message?: string | null };
type Health = { status: string; spanner: Check; smtp: Check };

function StatusCard({ label, ok, detail }: { label: string; ok: boolean | null; detail?: string }) {
  const color = ok === null ? 'var(--taupe)' : ok ? 'var(--teal)' : 'var(--red)';
  return (
    <div style={{ border: `2px solid ${color}`, borderRadius: 10, padding: 16, background: 'var(--paper)', marginBottom: 12 }}>
      <strong style={{ color }}>{ok === null ? '…' : ok ? '✔' : '✘'} {label}</strong>
      {detail && <div style={{ fontSize: 14, marginTop: 4 }}>{detail}</div>}
    </div>
  );
}

export default function StatusPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [apiOk, setApiOk] = useState<boolean | null>(null);
  const [emailResult, setEmailResult] = useState<string>('');

  const refresh = useCallback(async () => {
    setApiOk(null);
    try {
      const res = await fetch('/api/health');
      setHealth(await res.json());
      setApiOk(true);
    } catch {
      setHealth(null);
      setApiOk(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const sendTestEmail = async () => {
    setEmailResult('Sending…');
    try {
      const res = await fetch('/api/hello-email', { method: 'POST' });
      setEmailResult(res.ok ? 'Sent! Check Mailpit.' : `Failed (${res.status})`);
    } catch (err) {
      setEmailResult(`Failed: ${(err as Error).message}`);
    }
  };

  return (
    <main style={{ maxWidth: 560 }}>
      <h1>System status</h1>
      <StatusCard label="API" ok={apiOk} />
      <StatusCard
        label="Spanner"
        ok={health ? health.spanner.ok : apiOk === false ? false : null}
        detail={
          health?.spanner.ok
            ? `Wrote & read "${health.spanner.message}" in ${health.spanner.roundTripMs}ms`
            : health?.spanner.error
        }
      />
      <StatusCard
        label="Email (SMTP)"
        ok={health ? health.smtp.ok : apiOk === false ? false : null}
        detail={health?.smtp.error}
      />
      <button onClick={refresh}>Re-check</button>{' '}
      <button onClick={sendTestEmail}>Send test email</button> <span>{emailResult}</span>
      <p>
        Mailpit inbox: <a href="http://localhost:8025" target="_blank" rel="noreferrer">http://localhost:8025</a>
      </p>
    </main>
  );
}
