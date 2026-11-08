import { HttpException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@common/errors/error-code.enum';

/** 429 RATE_LIMITED. `Retry-After` is set on the response by the guard before this is thrown. */
export function rateLimited(): HttpException {
  return new HttpException(
    { errorCode: ErrorCode.RATE_LIMITED, message: 'Too many requests' },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
