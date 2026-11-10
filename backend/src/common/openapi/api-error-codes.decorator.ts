import { ApiExtension } from '@nestjs/swagger';
import type { ErrorCode } from '@common/errors/error-code.enum';

/** OpenAPI extension that lists, per HTTP status, the `errorCode`s an operation can return. */
export const ERROR_CODES_EXTENSION = 'x-error-codes';

/**
 * Declares the route-specific `errorCode`s of a handler, per status, for example
 * `@ApiErrorCodes({ 422: [ErrorCode.INSUFFICIENT_FUNDS] })`. Only the codes that belong to this
 * route: the ones every protected route shares (401, 403, 429, 503) are added by
 * `enrichOpenApi` from the shape of the operation, so they cannot be forgotten here.
 */
export function ApiErrorCodes(
  codes: Partial<Record<number, readonly ErrorCode[]>>,
): MethodDecorator {
  const declared: Record<string, ErrorCode[]> = {};
  for (const [status, list] of Object.entries(codes)) {
    const number = Number(status);
    if (!Number.isInteger(number) || number < 400 || number > 599) {
      throw new Error(`@ApiErrorCodes got status ${status}, which is not a 4xx or 5xx`);
    }
    declared[status] = [...(list ?? [])];
  }
  return ApiExtension(ERROR_CODES_EXTENSION, declared);
}
