import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '../auth/AuthProvider';
import { AuthFrame } from '../components/AuthFrame';
import { CloudLoginPage, type Mode } from './CloudLoginPage';

/** The role and subject form of a developer machine: absent from a production build. */
const LocalLoginPage = import.meta.env.DEV
  ? lazy(() => import('./LocalLoginPage').then(module => ({ default: module.LocalLoginPage })))
  : null;

/** `/login` and `/signup`: the form of the source this app started with. */
export function LoginPage({ start = 'sign-in' }: { start?: Mode }) {
  const { signedIn, source } = useAuth();
  if (signedIn) return <Navigate to="/" replace />;
  if (source.kind === 'cloud') return <CloudLoginPage source={source} start={start} />;
  if (source.kind === 'local' && LocalLoginPage) {
    return (
      <Suspense fallback={<p aria-busy="true">Đang tải…</p>}>
        <LocalLoginPage source={source} />
      </Suspense>
    );
  }
  return (
    <AuthFrame>
      <h1>Đăng nhập</h1>
      <p role="alert" className="warning">
        Đăng nhập chưa được cấu hình cho trang này.
      </p>
    </AuthFrame>
  );
}
