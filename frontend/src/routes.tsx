import { createBrowserRouter } from 'react-router';
import { RequireRole } from './auth/RequireRole';
import { Layout } from './components/Layout';
import { LoginPage } from './features/LoginPage';
import { HomeRedirect, RoleHome } from './features/RoleHome';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  {
    element: <Layout />,
    children: [
      { index: true, element: <HomeRedirect /> },
      {
        path: 'customer',
        element: (
          <RequireRole role="customer">
            <RoleHome role="customer" />
          </RequireRole>
        ),
      },
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
