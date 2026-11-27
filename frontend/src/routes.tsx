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
import { HomeRedirect } from './features/RoleHome';
import { AuditPage } from './features/staff/AuditPage';
import { DepositPage } from './features/staff/DepositPage';
import { FraudFlagDetailPage } from './features/staff/FraudFlagDetailPage';
import { FraudFlagsPage } from './features/staff/FraudFlagsPage';
import { OperatorAccountsPage } from './features/staff/OperatorAccountsPage';
import { RiskConfigNewPage } from './features/staff/RiskConfigNewPage';
import { RiskConfigPage } from './features/staff/RiskConfigPage';

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
        path: 'operator/accounts',
        element: (
          <RequireRole role="operator">
            <OperatorAccountsPage />
          </RequireRole>
        ),
      },
      {
        path: 'operator/deposit',
        element: (
          <RequireRole role="operator">
            <DepositPage />
          </RequireRole>
        ),
      },
      {
        path: 'operator/fraud-flags',
        element: (
          <RequireRole role="operator">
            <FraudFlagsPage />
          </RequireRole>
        ),
      },
      {
        path: 'operator/fraud-flags/:transferId',
        element: (
          <RequireRole role="operator">
            <FraudFlagDetailPage />
          </RequireRole>
        ),
      },
      {
        path: 'audit',
        element: (
          <RequireRole role="auditor">
            <AuditPage />
          </RequireRole>
        ),
      },
      {
        path: 'admin/risk-config',
        element: (
          <RequireRole role="admin">
            <RiskConfigPage />
          </RequireRole>
        ),
      },
      {
        path: 'admin/risk-config/new',
        element: (
          <RequireRole role="admin">
            <RiskConfigNewPage />
          </RequireRole>
        ),
      },
      { path: '*', element: <p className="panel">Không tìm thấy trang.</p> },
    ],
  },
]);
