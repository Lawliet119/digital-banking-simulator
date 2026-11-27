import type { ReactNode } from 'react';
import { createBrowserRouter } from 'react-router';
import { RequireRole } from './auth/RequireRole';
import { Layout } from './components/Layout';
import { AccountDetailPage } from './features/customer/AccountDetailPage';
import { AccountsPage } from './features/customer/AccountsPage';
import { CustomerGate } from './features/customer/CustomerGate';
import { NotificationsPage } from './features/customer/NotificationsPage';
import { OnboardingPage } from './features/customer/OnboardingPage';
import { TransferPage } from './features/customer/TransferPage';
import { TransferStatusPage } from './features/customer/TransferStatusPage';
import { LoginPage } from './features/LoginPage';
import { HomeRedirect, RoleHome } from './features/RoleHome';

/** A customer screen: the role, then a profile (onboarding first when there is none). */
const customer = (page: ReactNode) => (
  <RequireRole role="customer">
    <CustomerGate>{page}</CustomerGate>
  </RequireRole>
);

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <Layout />,
    children: [
      { index: true, element: <HomeRedirect /> },
      {
        path: 'onboarding',
        element: (
          <RequireRole role="customer">
            <OnboardingPage />
          </RequireRole>
        ),
      },
      { path: 'accounts', element: customer(<AccountsPage />) },
      { path: 'accounts/:id', element: customer(<AccountDetailPage />) },
      { path: 'transfer', element: customer(<TransferPage />) },
      { path: 'transfers/:id', element: customer(<TransferStatusPage />) },
      { path: 'notifications', element: customer(<NotificationsPage />) },
      {
        path: 'operator',
        element: (
          <RequireRole role="operator">
            <RoleHome role="operator" />
          </RequireRole>
        ),
      },
      {
        path: 'auditor',
        element: (
          <RequireRole role="auditor">
            <RoleHome role="auditor" />
          </RequireRole>
        ),
      },
      {
        path: 'admin',
        element: (
          <RequireRole role="admin">
            <RoleHome role="admin" />
          </RequireRole>
        ),
      },
      { path: '*', element: <p className="panel">Không tìm thấy trang.</p> },
    ],
  },
]);
