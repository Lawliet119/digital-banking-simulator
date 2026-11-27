import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useProfile } from './queries';

/** Customer screens need a profile: a customer who has none goes to `/onboarding` first. */
export function CustomerGate({ children }: { children: ReactNode }) {
  const profile = useProfile();
  if (profile.isPending) return <p aria-busy="true">Đang tải…</p>;
  if (profile.isError) return <ErrorBanner error={profile.error} />;
  if (profile.data === null) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}
