import { NavLink, Outlet, useNavigate } from 'react-router';
import { ROLE_HOME, ROLE_LABELS } from '../auth/auth-source';
import { useAuth } from '../auth/AuthProvider';

export function Layout() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Ngân hàng mô phỏng</span>
        {me && (
          <nav aria-label="Vai trò">
            {me.roles.map(role => (
              <NavLink key={role} to={ROLE_HOME[role]}>
                {ROLE_LABELS[role]}
              </NavLink>
            ))}
          </nav>
        )}
        <span className="spacer" />
        {me && (
          <span className="who" data-testid="who">
            {me.sub}
          </span>
        )}
        <button
          type="button"
          className="link"
          onClick={() => void signOut().then(() => navigate('/login'))}
        >
          Đăng xuất
        </button>
      </header>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
