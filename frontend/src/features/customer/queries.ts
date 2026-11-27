import { useQuery } from '@tanstack/react-query';
import { call } from '../../api/client';
import { ApiProblem } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';

export const keys = {
  profile: ['customer', 'profile'] as const,
  accounts: ['customer', 'accounts'] as const,
  account: (id: string) => ['customer', 'accounts', id] as const,
  history: (id: string, from: string | null, to: string | null) =>
    ['customer', 'accounts', id, 'history', from, to] as const,
  transfer: (id: string) => ['customer', 'transfers', id] as const,
  notifications: ['customer', 'notifications'] as const,
};

/** The profile, or `null` when the customer has not onboarded yet (404). */
export function useProfile() {
  const api = useApi();
  return useQuery({
    queryKey: keys.profile,
    staleTime: Infinity,
    queryFn: async () => {
      try {
        return await call(api.GET('/v1/customers/me'));
      } catch (error) {
        if (error instanceof ApiProblem && error.status === 404) return null;
        throw error;
      }
    },
  });
}

export function useAccounts() {
  const api = useApi();
  return useQuery({
    queryKey: keys.accounts,
    queryFn: () => call(api.GET('/v1/accounts')),
  });
}
