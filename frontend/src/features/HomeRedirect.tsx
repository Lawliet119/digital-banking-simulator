import { Navigate } from 'react-router';
import { ROLE_HOME } from '../auth/auth-source';
import { useAuth } from '../auth/AuthProvider';

/** `/`: the home of the caller's first role; a visitor sees the landing page. */
export function HomeRedirect() {
  const { signedIn, me } = useAuth();
  if (!signedIn) return <Navigate to="/welcome" replace />;
  if (!me) return <p aria-busy="true">Đang tải…</p>;
  return <Navigate to={ROLE_HOME[me.roles[0] ?? 'customer']} replace />;
}
