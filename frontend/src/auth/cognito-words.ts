/** The password policy of the user pool (`infra/terraform/envs/dev/base/cognito.tf`). */
export const PASSWORD_RULES: readonly [string, (password: string) => boolean][] = [
  ['Ít nhất 12 ký tự', password => password.length >= 12],
  ['Có chữ hoa', password => /[A-Z]/.test(password)],
  ['Có chữ thường', password => /[a-z]/.test(password)],
  ['Có chữ số', password => /\d/.test(password)],
  // Cognito's list of special characters, the space included.
  ['Có ký tự đặc biệt', password => /[\^$*.[\]{}()?"!@#%&/\\,><':;|_~`=+\- ]/.test(password)],
];

export function passwordOk(password: string): boolean {
  return PASSWORD_RULES.every(([, test]) => test(password));
}

const MESSAGES: Record<string, string> = {
  // Wrong password and unknown email read the same: the screen does not say who has an account.
  NotAuthorizedException: 'Email hoặc mật khẩu không đúng.',
  UserNotFoundException: 'Email hoặc mật khẩu không đúng.',
  UsernameExistsException: 'Email này đã có tài khoản. Hãy đăng nhập.',
  InvalidPasswordException: 'Mật khẩu chưa đủ các quy tắc bên dưới.',
  CodeMismatchException: 'Mã xác nhận không đúng.',
  ExpiredCodeException: 'Mã đã hết hạn. Hãy gửi mã mới.',
  LimitExceededException: 'Thử quá nhiều lần. Đợi vài phút rồi thử lại.',
  TooManyRequestsException: 'Thử quá nhiều lần. Đợi vài phút rồi thử lại.',
  TooManyFailedAttemptsException: 'Thử quá nhiều lần. Đợi vài phút rồi thử lại.',
  InvalidParameterException: 'Thông tin chưa hợp lệ. Kiểm tra lại email.',
  CodeDeliveryFailureException: 'Không gửi được mã tới email này.',
  NetworkError: 'Không kết nối được máy chủ đăng nhập.',
  UnsupportedStep: 'Tài khoản này cần một bước đăng nhập mà ứng dụng chưa hỗ trợ.',
};

/** Words for people from an Amplify or Cognito error; never the raw service message. */
export function describeCognitoError(error: unknown): string {
  const name = error instanceof Error ? error.name : undefined;
  if (name && name in MESSAGES) return MESSAGES[name] ?? '';
  if (error instanceof TypeError) return MESSAGES.NetworkError ?? '';
  return 'Không đăng nhập được. Thử lại sau.';
}
