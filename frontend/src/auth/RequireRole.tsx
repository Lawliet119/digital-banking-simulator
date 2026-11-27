import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import type { Role } from './auth-source';
import { useAuth } from './AuthProvider';

/**
 * Hides screens a role has no use for. Display only: the server decides on every request, and a
 * page that slipped past this check still gets 403 from the API.
 */
export function RequireRole({ role, children }: { role: Role; children: ReactNode }) {
  const { signedIn, me, meLoading } = useAuth();
  const location = useLocation();
  if (!signedIn) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (meLoading || !me) return <p aria-busy="true">Đang tải…</p>;
  if (!me.roles.includes(role)) {
    return (
      <section role="alert" className="panel">
        <h1>Không có quyền</h1>
        <p>Tài khoản của bạn không được xem trang này.</p>
      </section>
    );
  }
  return <>{children}</>;
}
