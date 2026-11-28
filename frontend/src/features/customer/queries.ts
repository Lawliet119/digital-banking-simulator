import { useQuery } from '@tanstack/react-query';
import { call } from '../../api/client';
import { ApiProblem } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';

export const keys = {
  profile: ['customer', 'profile'] as const,
  accounts: ['customer', 'accounts'] as const,
  account: (id: string) => ['customer', 'accounts', id] as const,
  history: (id: string, from: string | null, to: string | null, direction: string) =>
    ['customer', 'accounts', id, 'history', from, to, direction] as const,
  recent: (id: string) => ['customer', 'accounts', id, 'recent'] as const,
  limits: (id: string) => ['customer', 'accounts', id, 'limits'] as const,
  summary: (days: 1 | 30) => ['customer', 'summary', days] as const,
  recipients: ['customer', 'recipients'] as const,
  transfer: (id: string) => ['customer', 'transfers', id] as const,
  notifications: (filter: string) => ['customer', 'notifications', filter] as const,
  /** Every notification list and the unread badge. */
  allNotifications: ['customer', 'notifications'] as const,
  unread: ['customer', 'unread'] as const,
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

/** The latest 20 movements of an account: recent activity and the balance chart. */
export function useRecentMovements(id: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.recent(id ?? ''),
    enabled: Boolean(id),
    queryFn: () =>
      call(
        api.GET('/v1/accounts/{id}/transactions', {
          params: { path: { id: id ?? '' }, query: { limit: 20 } },
        }),
      ),
  });
}

export function useLimits(id: string | undefined) {
  const api = useApi();
  return useQuery({
    queryKey: keys.limits(id ?? ''),
    enabled: Boolean(id),
    queryFn: () =>
      call(api.GET('/v1/accounts/{id}/limits', { params: { path: { id: id ?? '' } } })),
  });
}

export function useSummary(days: 1 | 30) {
  const api = useApi();
  return useQuery({
    queryKey: keys.summary(days),
    queryFn: () => call(api.GET('/v1/insights/summary', { params: { query: { days } } })),
  });
}

export function useRecipients() {
  const api = useApi();
  return useQuery({
    queryKey: keys.recipients,
    queryFn: () => call(api.GET('/v1/insights/recipients')),
  });
}
