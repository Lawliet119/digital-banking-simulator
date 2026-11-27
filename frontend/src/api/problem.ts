/**
 * Errors of the API are `application/problem+json` with a stable `errorCode` and the
 * `correlationId` the server logged under. The UI branches on `errorCode` and `status`, never on
 * `detail`, which is English and may be reworded.
 */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly errorCode: string | undefined,
    readonly detail: string | undefined,
    readonly correlationId: string | undefined,
    /** Seconds from `Retry-After`, on a 429 or 503. */
    readonly retryAfterSeconds?: number,
    /** Per-field messages of a 400. */
    readonly errors: string[] = [],
    /** The transfer a 422 rejection was recorded as: its status page explains it. */
    readonly transferId?: string,
  ) {
    super(detail ?? errorCode ?? `HTTP ${status}`);
    this.name = 'ApiProblem';
  }
}

/** Builds an `ApiProblem` from a response and its already-parsed body (anything, even nothing). */
export function toProblem(response: Response, body: unknown): ApiProblem {
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const text = (key: string) => (typeof record[key] === 'string' ? record[key] : undefined);
  const retryAfter = Number(response.headers.get('Retry-After'));
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((e): e is string => typeof e === 'string')
    : [];
  return new ApiProblem(
    response.status,
    text('errorCode'),
    text('detail'),
    text('correlationId') ?? response.headers.get('X-Correlation-Id') ?? undefined,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    errors,
    text('transferId'),
  );
}

const MESSAGES: Record<string, string> = {
  ACCOUNT_NOT_ACTIVE: 'Tài khoản nguồn hoặc tài khoản nhận đang bị khóa hoặc không tồn tại.',
  LIMIT_PER_TX_EXCEEDED: 'Số tiền vượt hạn mức cho một giao dịch.',
  LIMIT_PER_DAY_EXCEEDED: 'Số tiền vượt hạn mức chuyển trong ngày.',
  INSUFFICIENT_FUNDS: 'Số dư không đủ.',
  IDEMPOTENCY_KEY_REQUIRED: 'Yêu cầu thiếu mã chống gửi trùng. Hãy tải lại trang và thử lại.',
  IDEMPOTENCY_KEY_REUSED: 'Yêu cầu này đã được gửi với nội dung khác. Hãy bắt đầu lại.',
  ACCOUNT_LIMIT_REACHED: 'Bạn đã có đủ số tài khoản tối đa.',
  ACCOUNT_NOT_FOUND: 'Không tìm thấy tài khoản với số này.',
  UNAUTHENTICATED: 'Phiên đã hết hạn hoặc bị thu hồi. Hãy đăng nhập lại.',
  TOKEN_EXPIRED: 'Phiên đã hết hạn hoặc bị thu hồi. Hãy đăng nhập lại.',
  SESSION_REVOKED: 'Phiên đã hết hạn hoặc bị thu hồi. Hãy đăng nhập lại.',
  FORBIDDEN: 'Bạn không có quyền thực hiện thao tác này.',
  FLAG_ALREADY_REVIEWED: 'Cờ này đã được review.',
  RATE_LIMITED: 'Bạn thao tác quá nhanh. Hãy chờ một lát rồi thử lại.',
  SERVICE_TEMPORARILY_UNAVAILABLE: 'Hệ thống tạm thời bận. Hãy thử lại sau ít giây.',
};

/** A sentence for the person in front of the screen. Unknown codes get a generic sentence. */
export function describeProblem(problem: ApiProblem): string {
  const known = problem.errorCode ? MESSAGES[problem.errorCode] : undefined;
  if (known) {
    if (problem.status === 429 && problem.retryAfterSeconds) {
      return `${known} Thử lại sau ${problem.retryAfterSeconds} giây.`;
    }
    return known;
  }
  if (problem.status === 404) return 'Không tìm thấy.';
  if (problem.status === 400) return 'Dữ liệu gửi lên không hợp lệ.';
  const trace = problem.correlationId ? ` Mã truy vết: ${problem.correlationId}.` : '';
  return `Đã có lỗi xảy ra (HTTP ${problem.status}).${trace}`;
}

/** A network failure or anything that is not an `ApiProblem`. */
export function describeError(error: unknown): string {
  if (error instanceof ApiProblem) return describeProblem(error);
  return 'Không kết nối được tới máy chủ. Kiểm tra mạng rồi thử lại.';
}
