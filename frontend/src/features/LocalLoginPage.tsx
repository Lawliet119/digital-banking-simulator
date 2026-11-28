import { useState, type FormEvent } from 'react';
import { ROLE_LABELS, ROLES, type LocalSource, type Role } from '../auth/auth-source';
import { useAuth } from '../auth/AuthProvider';
import { AuthFrame } from '../components/AuthFrame';
import { Field } from '../components/Field';

const SUB = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Sign-in on a developer machine: pick a role and a subject, the Vite dev server signs the token.
 * A subject is one person. Loaded only under `vite dev`.
 */
export function LocalLoginPage({ source }: { source: LocalSource }) {
  const { notice, completeSignIn } = useAuth();
  const [role, setRole] = useState<Role>('customer');
  const [sub, setSub] = useState('dev-customer');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const subError = SUB.test(sub) ? undefined : 'Chỉ chữ, số và dấu gạch ngang, tối đa 64 ký tự.';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (subError) return;
    setBusy(true);
    setError(undefined);
    try {
      await source.signIn({ role, sub });
      completeSignIn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame>
      <form className="col" onSubmit={event => void submit(event)}>
        <h1>Đăng nhập</h1>
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        <fieldset>
          <legend className="label">Vai trò</legend>
          {ROLES.map(option => (
            <label key={option} className="choice">
              <input
                type="radio"
                name="role"
                value={option}
                checked={role === option}
                onChange={() => {
                  setRole(option);
                  if (/^dev-(customer|operator|auditor|admin)$/.test(sub)) {
                    setSub(`dev-${option}`);
                  }
                }}
              />
              {ROLE_LABELS[option]}
            </label>
          ))}
        </fieldset>
        <Field
          label="Mã người dùng (sub)"
          value={sub}
          onChange={event => setSub(event.target.value)}
          error={subError}
          autoComplete="off"
          spellCheck={false}
        />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || Boolean(subError)}>
          {busy ? 'Đang đăng nhập…' : 'Đăng nhập'}
        </button>
      </form>
    </AuthFrame>
  );
}
