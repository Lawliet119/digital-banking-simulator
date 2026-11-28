import type { ReactNode } from 'react';
import { createBrowserRouter } from 'react-router';
import type { Role } from './auth/auth-source';
import { RequireRole } from './auth/RequireRole';
import { Layout } from './components/Layout';
import { AccountDetailPage } from './features/customer/AccountDetailPage';
import { AccountsPage } from './features/customer/AccountsPage';
import { CustomerGate } from './features/customer/CustomerGate';
import { NotificationsPage } from './features/customer/NotificationsPage';
import { OnboardingPage } from './features/customer/OnboardingPage';
import { TransferPage } from './features/customer/TransferPage';
import { TransferStatusPage } from './features/customer/TransferStatusPage';
import { HomeRedirect } from './features/HomeRedirect';
import { LandingPage } from './features/landing/LandingPage';
import { LoginPage } from './features/LoginPage';
import { AuditPage } from './features/staff/AuditPage';
import { DepositPage } from './features/staff/DepositPage';
import { FraudFlagDetailPage } from './features/staff/FraudFlagDetailPage';
import { FraudFlagsPage } from './features/staff/FraudFlagsPage';
import { OperatorAccountsPage } from './features/staff/OperatorAccountsPage';
import { RiskConfigNewPage } from './features/staff/RiskConfigNewPage';
import { RiskConfigPage } from './features/staff/RiskConfigPage';

const only = (role: Role, page: ReactNode) => <RequireRole role={role}>{page}</RequireRole>;

/** A customer screen: the role, then a profile (onboarding first when there is none). */
const customer = (page: ReactNode) => only('customer', <CustomerGate>{page}</CustomerGate>);

export const router = createBrowserRouter([
  { path: '/', element: <HomeRedirect /> },
  { path: '/welcome', element: <LandingPage /> },
  { path: '/login', element: <LoginPage /> },
  {
    element: <Layout />,
    children: [
      { path: 'onboarding', element: only('customer', <OnboardingPage />) },
      { path: 'accounts', element: customer(<AccountsPage />) },
      { path: 'accounts/:id', element: customer(<AccountDetailPage />) },
      { path: 'transfer', element: customer(<TransferPage />) },
      { path: 'transfers/:id', element: customer(<TransferStatusPage />) },
      { path: 'notifications', element: customer(<NotificationsPage />) },
      { path: 'operator/accounts', element: only('operator', <OperatorAccountsPage />) },
      { path: 'operator/deposit', element: only('operator', <DepositPage />) },
      { path: 'operator/fraud-flags', element: only('operator', <FraudFlagsPage />) },
      {
        path: 'operator/fraud-flags/:transferId',
        element: only('operator', <FraudFlagDetailPage />),
      },
      { path: 'audit', element: only('auditor', <AuditPage />) },
      { path: 'admin/risk-config', element: only('admin', <RiskConfigPage />) },
      { path: 'admin/risk-config/new', element: only('admin', <RiskConfigNewPage />) },
      { path: '*', element: <p className="panel">Không tìm thấy trang.</p> },
    ],
  },
]);
