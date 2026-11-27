import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { RouterProvider } from 'react-router';
import { ApiProblem } from './api/problem';
import { AuthProvider } from './auth/AuthProvider';
import { LocalDevSource } from './auth/local-dev-source';
import { router } from './routes';

/** Retries only what may succeed on a second try; a 4xx answer will not change. */
function retry(failures: number, error: unknown): boolean {
  if (error instanceof ApiProblem && error.status < 500 && error.status !== 429) return false;
  return failures < 2;
}

export function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry, refetchOnWindowFocus: false },
          // A money request is never repeated behind the user's back.
          mutations: { retry: false },
        },
      }),
  );
  const [source] = useState(() => new LocalDevSource());
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider source={source}>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>
  );
}
