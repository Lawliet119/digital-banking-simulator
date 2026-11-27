import createClient from 'openapi-fetch';
import { toProblem } from './problem';
import type { components, paths } from './schema';

export type Schemas = components['schemas'];
export type ApiClient = ReturnType<typeof createClient<paths>>;

export interface ClientHooks {
  /** The access token to send, or null when signed out. */
  getToken(): Promise<string | null>;
  /** Any 401: the token is missing, expired or revoked. Signing in again is the only way on. */
  onUnauthorized(): void;
}

/**
 * The typed client of the API (types generated from `docs/deliverables/openapi.json`). Relative
 * URLs: the dev server proxies `/v1` to the backend, so the browser stays on one origin.
 */
export function createApiClient(hooks: ClientHooks): ApiClient {
  const client = createClient<paths>({ baseUrl: '' });
  client.use({
    async onRequest({ request }) {
      const token = await hooks.getToken();
      if (token) request.headers.set('Authorization', `Bearer ${token}`);
      return request;
    },
    onResponse({ response }) {
      if (response.status === 401) hooks.onUnauthorized();
      return response;
    },
  });
  return client;
}

export interface Result<T> {
  data: T;
  status: number;
  /** `X-Correlation-Id` of the response: what an auditor searches the audit log by. */
  correlationId: string | undefined;
}

type Fetched<T> = Promise<{ data?: T; error?: unknown; response: Response }>;

/** The data of a 2xx, or throws `ApiProblem`. A network failure rejects as is (`TypeError`). */
export async function callWithMeta<T>(request: Fetched<T>): Promise<Result<T>> {
  const { data, error, response } = await request;
  if (!response.ok) throw toProblem(response, error);
  return {
    data: data as T,
    status: response.status,
    correlationId: response.headers.get('X-Correlation-Id') ?? undefined,
  };
}

export async function call<T>(request: Fetched<T>): Promise<T> {
  return (await callWithMeta(request)).data;
}
