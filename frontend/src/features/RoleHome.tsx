import { Navigate } from 'react-router';
import { ROLE_HOME, ROLE_LABELS, type Role } from '../auth/auth-source';
import { useAuth } from '../auth/AuthProvider';

/** `/`: the home of the caller's first role. */
export function HomeRedirect() {
  const { signedIn, me } = useAuth();
  if (!signedIn) return <Navigate to="/login" replace />;
  if (!me) return <p aria-busy="true">Đang tải…</p>;
  return <Navigate to={ROLE_HOME[me.roles[0] ?? 'customer']} replace />;
}

/** Placeholder home of a role, until its screens exist. Shows who the server says you are. */
export function RoleHome({ role }: { role: Role }) {
  const { me } = useAuth();
  return (
    <section className="panel">
      <h1>{ROLE_LABELS[role]}</h1>
      <dl className="facts">
        <dt>Mã người dùng (sub)</dt>
        <dd data-testid="me-sub">{me?.sub}</dd>
        <dt>Vai trò</dt>
        <dd data-testid="me-roles">{me?.roles.map(r => ROLE_LABELS[r]).join(', ')}</dd>
      </dl>
    </section>
  );
}
