import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { ROLE_LABELS, ROLES, type Role } from '../auth/auth-source';
import { useAuth } from '../auth/AuthProvider';
import { Field } from '../components/Field';
import { Brand } from '../components/ui';

const SUB = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Sign-in on a developer machine: pick a role and a subject, the Vite dev server signs the token.
 * A subject is one person. The cloud sign-in (email and password) replaces this form when the
 * app is configured for an Identity Provider.
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
    <div className="auth">
      <div className="auth-art">
        <Link to="/welcome" aria-label="Về trang chủ">
          <Brand />
        </Link>
        <h2>
          Chào mừng
          <br />
          <span className="soft-text">quay lại.</span>
        </h2>
        <div className="balance-card" aria-hidden="true">
          <div className="row between">
            <span>Thanh toán</span>
            <span className="mono">**** 0002</span>
          </div>
          <div className="big">48.000.000 ₫</div>
          <span>NGUYEN MINH ANH</span>
        </div>
      </div>
      <main>
        <form className="auth-form" onSubmit={event => void submit(event)}>
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
      </main>
    </div>
  );
}
