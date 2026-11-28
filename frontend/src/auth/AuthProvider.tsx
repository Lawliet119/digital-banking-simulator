import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { call, createApiClient, type ApiClient, type Schemas } from '../api/client';
import { rolesFromGroups, type AuthSource, type Role } from './auth-source';

export const EXPIRED_NOTICE = 'Phiên đã hết hạn hoặc bị thu hồi';

export interface Me {
  sub: string;
  userId: string;
  roles: Role[];
  /** What to show for the person: the sign-in email in the cloud, else the subject. */
  label: string;
}

interface AuthState {
  api: ApiClient;
  source: AuthSource;
  signedIn: boolean;
  /** `undefined` while loading or signed out. */
  me: Me | undefined;
  meLoading: boolean;
  /** Shown once on the sign-in screen after a 401. */
  notice: string | undefined;
  /** Called by a sign-in screen once its source holds a session. */
  completeSignIn: () => void;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ source, children }: { source: AuthSource; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [signedIn, setSignedIn] = useState(() => source.hasSession());
  const [notice, setNotice] = useState<string | undefined>();

  const expire = useCallback(() => {
    void source.signOut();
    queryClient.clear();
    setNotice(EXPIRED_NOTICE);
    setSignedIn(false);
  }, [queryClient, source]);

  const api = useMemo(
    () => createApiClient({ getToken: () => source.getToken(), onUnauthorized: expire }),
    [source, expire],
  );

  const meQuery = useQuery({
    queryKey: ['identity', 'me'],
    enabled: signedIn,
    staleTime: Infinity,
    queryFn: async (): Promise<Me> => {
      const body: Schemas['IdentityMeDto'] = await call(api.GET('/v1/identity/me'));
      const label = await source.userLabel();
      return {
        sub: body.sub,
        userId: body.userId,
        roles: rolesFromGroups(body.groups),
        label: label ?? body.sub,
      };
    },
  });

  const value = useMemo<AuthState>(
    () => ({
      api,
      source,
      signedIn,
      me: signedIn ? meQuery.data : undefined,
      meLoading: signedIn && meQuery.isPending,
      notice,
      completeSignIn() {
        queryClient.clear();
        setNotice(undefined);
        setSignedIn(true);
      },
      async signOut() {
        await source.signOut();
        queryClient.clear();
        setNotice(undefined);
        setSignedIn(false);
      },
    }),
    [api, signedIn, meQuery.data, meQuery.isPending, notice, source, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const state = useContext(AuthContext);
  if (!state) throw new Error('useAuth outside AuthProvider');
  return state;
}

/** The typed API client of the signed-in user. */
export function useApi(): ApiClient {
  return useAuth().api;
}
