import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { DATE_FIELDS, type Swap } from '../swaps/swaps';

// Only the fields the form edits: the API refuses any others.
type Form = Omit<Swap, 'swapId' | 'makersPublishedAt' | 'swapperCount'>;
const EMPTY: Form = {
  title: '',
  description: '',
  makingDeadline: '',
  partnersAnnounced: '',
  shipBy: '',
  signUpOpens: '',
  signUpCloses: '',
};

/** One form for creating (/manage/swaps/new) and editing (/manage/swaps/:swapId/edit). */
export default function SwapFormPage() {
  const { swapId } = useParams();
  const navigate = useNavigate();
  const [form, setForm] = useState<Form>(EMPTY);
  const [loading, setLoading] = useState(!!swapId);
  const [canEdit, setCanEdit] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!swapId) return;
    // A load that finishes after cleanup (StrictMode runs effects twice) must not overwrite what was typed.
    let stale = false;
    api<{ swap: Swap; canEdit: boolean }>(`/api/swaps/${swapId}`)
      .then(({ swap: { swapId: _id, makersPublishedAt: _published, swapperCount: _count, ...rest }, canEdit }) => {
        if (stale) return;
        setForm(rest);
        setCanEdit(canEdit);
      })
      .catch((e) => !stale && setError(e.message))
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [swapId]);

  const set = (key: keyof Form) => (value: string) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ swap: Swap }>(swapId ? `/api/swaps/${swapId}` : '/api/swaps', {
        method: swapId ? 'PUT' : 'POST',
        body: form,
      });
      navigate(`/swaps/${res.swap.swapId}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  if (loading) return <main>Loading…</main>;
  if (!canEdit) {
    return (
      <main className="stack">
        <h1>No access</h1>
        <p>You don't have access to change this swap.</p>
      </main>
    );
  }

  return (
    <main className="stack wide">
      <p>
        <Link to="/manage/swaps">← My swaps</Link>
      </p>
      <h1>{swapId ? 'Edit swap' : 'Create a swap'}</h1>
      <form className="stack" onSubmit={submit}>
        <div>
          <label htmlFor="title">Title</label>
          <input id="title" required maxLength={200} value={form.title} onChange={(e) => set('title')(e.target.value)} />
        </div>
        <div>
          <label htmlFor="description">Description</label>
          <textarea
            id="description"
            rows={6}
            maxLength={5000}
            value={form.description}
            onChange={(e) => set('description')(e.target.value)}
          />
        </div>
        {DATE_FIELDS.map(([key, label]) => (
          <div key={key}>
            <label htmlFor={key}>{label}</label>
            <input id={key} type="date" required value={form[key]} onChange={(e) => set(key)(e.target.value)} />
          </div>
        ))}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {swapId ? 'Save changes' : 'Create swap'}
        </button>
      </form>
    </main>
  );
}
