import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { ROLE_LABELS, ROLES, type Role } from '../auth/auth-source';
import { useAuth } from '../auth/AuthProvider';
import { Field } from '../components/Field';

const SUB = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Local sign-in: pick a role and a subject, get a token signed on this machine. A subject is one
 * person: the same subject is the same customer on the next sign-in.
 */
export function LoginPage() {
  const { signedIn, notice, signIn } = useAuth();
  const [role, setRole] = useState<Role>('customer');
  const [sub, setSub] = useState('dev-customer');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  if (signedIn) return <Navigate to="/" replace />;

  const subError = SUB.test(sub) ? undefined : 'Chỉ chữ, số và dấu gạch ngang, tối đa 64 ký tự.';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (subError) return;
    setBusy(true);
    setError(undefined);
    try {
      await signIn({ role, sub });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form className="panel" onSubmit={event => void submit(event)}>
        <h1>Đăng nhập</h1>
        <p className="muted">Môi trường chạy local: token được ký ngay trên máy này.</p>
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        <fieldset>
          <legend>Vai trò</legend>
          {ROLES.map(option => (
            <label key={option} className="choice">
              <input
                type="radio"
                name="role"
                value={option}
                checked={role === option}
                onChange={() => {
                  setRole(option);
                  if (/^dev-(customer|operator|auditor|admin)$/.test(sub)) setSub(`dev-${option}`);
                }}
              />
              {ROLE_LABELS[option]}
            </label>
          ))}
        </fieldset>
        <Field
          label="Mã người dùng (sub)"
          hint="Cùng một mã là cùng một người ở lần đăng nhập sau."
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
    </main>
  );
}
