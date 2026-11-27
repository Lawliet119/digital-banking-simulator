import { NavLink, Outlet, useNavigate } from 'react-router';
import { ROLE_LABELS, type Role } from '../auth/auth-source';
import { useAuth } from '../auth/AuthProvider';

/** The links of each role. A role a person does not have shows no link. */
const LINKS: Record<Role, { to: string; label: string }[]> = {
  customer: [
    { to: '/accounts', label: 'Tài khoản' },
    { to: '/transfer', label: 'Chuyển tiền' },
    { to: '/notifications', label: 'Thông báo' },
  ],
  operator: [{ to: '/operator', label: 'Nhân viên' }],
  auditor: [{ to: '/auditor', label: 'Kiểm toán' }],
  admin: [{ to: '/admin', label: 'Quản trị' }],
};

export function Layout() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="shell">
      <header className="topbar">
        <span className="brand">Ngân hàng mô phỏng</span>
        {me && (
          <nav aria-label="Chức năng">
            {me.roles.flatMap(role =>
              LINKS[role].map(link => (
                <NavLink key={link.to} to={link.to}>
                  {link.label}
                </NavLink>
              )),
            )}
          </nav>
        )}
        <span className="spacer" />
        {me && (
          <span
            className="who"
            data-testid="who"
            title={me.roles.map(role => ROLE_LABELS[role]).join(', ')}
          >
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
