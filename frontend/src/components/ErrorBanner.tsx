import { ApiProblem, describeError } from '../api/problem';

/** One error, in words for people, with the trace id when the server gave one. */
export function ErrorBanner({ error }: { error: unknown }) {
  if (!error) return null;
  const trace = error instanceof ApiProblem ? error.correlationId : undefined;
  return (
    <div role="alert" className="error">
      <p>{describeError(error)}</p>
      {trace && <p className="muted">Mã truy vết: {trace}</p>}
    </div>
  );
}
