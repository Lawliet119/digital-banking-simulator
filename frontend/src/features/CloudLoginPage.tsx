import { useState, type FormEvent, type ReactNode } from 'react';
import type { CloudSource, CloudStep } from '../auth/auth-source';
import { useAuth } from '../auth/AuthProvider';
import { describeCognitoError, passwordOk, PASSWORD_RULES } from '../auth/cognito-words';
import { AuthFrame } from '../components/AuthFrame';
import { Field } from '../components/Field';

export type Mode = 'sign-in' | 'sign-up' | 'confirm' | 'forgot' | 'reset' | 'new-password';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^\d{6}$/;

const TITLES: Record<Mode, string> = {
  'sign-in': 'Đăng nhập',
  'sign-up': 'Mở tài khoản',
  confirm: 'Xác nhận email',
  forgot: 'Quên mật khẩu',
  reset: 'Đặt mật khẩu mới',
  'new-password': 'Đổi mật khẩu lần đầu',
};

function PasswordRules({ password }: { password: string }) {
  return (
    <ul className="items" aria-label="Quy tắc mật khẩu" data-testid="password-rules">
      {PASSWORD_RULES.map(([label, test]) => {
        const met = test(password);
        return (
          <li key={label} className={met ? 'ok-text' : 'muted'}>
            {met ? '✓' : '○'} {label}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Sign-in, sign-up, email code, forgotten password and first-login password change against the
 * user pool. Every step's error is shown in plain words; a wrong password and an unknown email
 * read the same.
 */
export function CloudLoginPage({ source, start }: { source: CloudSource; start: Mode }) {
  const { notice, completeSignIn } = useAuth();
  const [mode, setMode] = useState<Mode>(start);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [info, setInfo] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const emailError = email && !EMAIL.test(email.trim()) ? 'Email chưa đúng dạng.' : undefined;
  const codeError = code && !CODE.test(code.trim()) ? 'Mã gồm 6 chữ số.' : undefined;
  const address = email.trim().toLowerCase();

  function go(next: Mode, message?: string) {
    setMode(next);
    setError(undefined);
    setInfo(message);
    setCode('');
  }

  async function after(step: CloudStep) {
    if (step === 'done') return completeSignIn();
    if (step === 'new-password') return go('new-password');
    if (step === 'reset-password') {
      await source.forgotPassword(address);
      return go('reset', 'Tài khoản cần đặt lại mật khẩu. Mã đã được gửi tới email của bạn.');
    }
    await source.resendSignUpCode(address);
    go('confirm', 'Email chưa được xác nhận. Mã mới đã được gửi tới email của bạn.');
  }

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (cause) {
      setError(describeCognitoError(cause));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      switch (mode) {
        case 'sign-in':
          return after(await source.signIn(address, password));
        case 'sign-up':
          if ((await source.signUp(address, password)) === 'done') {
            return after(await source.signIn(address, password));
          }
          return go('confirm', `Mã xác nhận đã được gửi tới ${address}.`);
        case 'confirm':
          await source.confirmSignUp(address, code.trim());
          if (password) return after(await source.signIn(address, password));
          return go('sign-in', 'Đã xác nhận email. Đăng nhập để tiếp tục.');
        case 'forgot':
          await source.forgotPassword(address);
          return go('reset', `Mã đặt lại mật khẩu đã được gửi tới ${address}.`);
        case 'reset':
          await source.confirmForgotPassword(address, code.trim(), password);
          return after(await source.signIn(address, password));
        case 'new-password':
          return after(await source.confirmNewPassword(password));
      }
    });
  }

  const needsEmail = mode !== 'new-password';
  const needsCode = mode === 'confirm' || mode === 'reset';
  const needsPassword = mode !== 'forgot' && mode !== 'confirm';
  const newPassword = mode === 'sign-up' || mode === 'reset' || mode === 'new-password';
  const ready =
    (!needsEmail || (address && !emailError)) &&
    (!needsCode || (code && !codeError)) &&
    (!needsPassword || (newPassword ? passwordOk(password) : password.length > 0));

  const links: ReactNode[] = [];
  if (mode === 'sign-in') {
    links.push(
      <button key="forgot" type="button" className="link" onClick={() => go('forgot')}>
        Quên mật khẩu?
      </button>,
      <span key="up">
        Chưa có tài khoản?{' '}
        <button type="button" className="link" onClick={() => go('sign-up')}>
          Mở tài khoản
        </button>
      </span>,
    );
  } else {
    links.push(
      <button key="back" type="button" className="link" onClick={() => go('sign-in')}>
        Về đăng nhập
      </button>,
    );
  }
  if (mode === 'confirm') {
    links.push(
      <button
        key="resend"
        type="button"
        className="link"
        disabled={busy || !address}
        onClick={() =>
          void run(async () => {
            await source.resendSignUpCode(address);
            setInfo(`Mã mới đã được gửi tới ${address}.`);
          })
        }
      >
        Gửi lại mã
      </button>,
    );
  }

  return (
    <AuthFrame>
      <form className="col" onSubmit={submit} noValidate>
        <h1>{TITLES[mode]}</h1>
        {notice && mode === 'sign-in' && !info && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {info && (
          <p role="status" className="notice">
            {info}
          </p>
        )}
        {needsEmail && (
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={event => setEmail(event.target.value)}
            error={emailError}
            autoComplete={mode === 'sign-up' ? 'email' : 'username'}
            readOnly={mode === 'confirm' || mode === 'reset'}
            required
          />
        )}
        {needsCode && (
          <Field
            label="Mã xác nhận (6 chữ số)"
            value={code}
            onChange={event => setCode(event.target.value)}
            error={codeError}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
          />
        )}
        {needsPassword && (
          <Field
            label={newPassword ? 'Mật khẩu mới' : 'Mật khẩu'}
            type="password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            autoComplete={newPassword ? 'new-password' : 'current-password'}
            required
          />
        )}
        {newPassword && <PasswordRules password={password} />}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !ready}>
          {busy ? 'Đang xử lý…' : mode === 'forgot' ? 'Gửi mã' : TITLES[mode]}
        </button>
        <div className="row between">{links}</div>
      </form>
    </AuthFrame>
  );
}
