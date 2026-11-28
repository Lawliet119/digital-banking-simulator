import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { call } from '../api/client';
import { ROLE_LABELS, type Role } from '../auth/auth-source';
import { useApi, useAuth } from '../auth/AuthProvider';
import { POLL_INTERVAL_MS } from '../lib/polling';
import { Icon, type IconName } from './Icon';
import { Brand } from './ui';

interface Link {
  to: string;
  label: string;
  icon: IconName;
  badge?: 'unread';
}

/** The links of each role. A role a person does not have shows no link. */
const LINKS: Record<Role, Link[]> = {
  customer: [
    { to: '/accounts', label: 'Tổng quan', icon: 'home' },
    { to: '/transfer', label: 'Chuyển tiền', icon: 'send' },
    { to: '/notifications', label: 'Thông báo', icon: 'bell', badge: 'unread' },
  ],
  operator: [
    { to: '/operator/accounts', label: 'Tìm tài khoản', icon: 'search' },
    { to: '/operator/deposit', label: 'Nạp tiền', icon: 'plus' },
    { to: '/operator/fraud-flags', label: 'Cờ gian lận', icon: 'flag' },
  ],
  auditor: [{ to: '/audit', label: 'Nhật ký kiểm toán', icon: 'list' }],
  admin: [{ to: '/admin/risk-config', label: 'Cấu hình luật', icon: 'sliders' }],
};

/** Unread notices of the customer, asked as often as the notification list. */
function UnreadBadge() {
  const api = useApi();
  const unread = useQuery({
    queryKey: ['customer', 'unread'],
    refetchInterval: POLL_INTERVAL_MS,
    queryFn: async () =>
      (await call(api.GET('/v1/notifications', { params: { query: { limit: 1 } } }))).unreadCount,
  });
  if (!unread.data) return null;
  return (
    <span className="tag warn" aria-label={`${unread.data} chưa đọc`}>
      {unread.data > 99 ? '99+' : unread.data}
    </span>
  );
}

export function Layout() {
  const { me, signOut } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="app">
      <aside className="side">
        <Brand sub={me?.roles.map(role => ROLE_LABELS[role]).join(', ')} />
        {me && (
          <nav aria-label="Chức năng">
            {me.roles.flatMap(role =>
              LINKS[role].map(link => (
                <NavLink key={link.to} to={link.to} className="nav-link">
                  <Icon name={link.icon} size={19} />
                  <span className="grow">{link.label}</span>
                  {link.badge && <UnreadBadge />}
                </NavLink>
              )),
            )}
          </nav>
        )}
        <span className="grow" />
        {me && (
          <div className="card">
            <div
              className="mono"
              data-testid="who"
              title={me.roles.map(role => ROLE_LABELS[role]).join(', ')}
              style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {me.sub}
            </div>
            <button
              type="button"
              className="link"
              onClick={() => void signOut().then(() => navigate('/login'))}
            >
              Đăng xuất
            </button>
          </div>
        )}
      </aside>
      <main>
        <Outlet />
      </main>
    </div>
  );
}
