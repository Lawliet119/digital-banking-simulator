import { Amplify } from 'aws-amplify';
import {
  confirmResetPassword,
  confirmSignIn,
  confirmSignUp,
  fetchAuthSession,
  getCurrentUser,
  resendSignUpCode,
  resetPassword,
  signIn,
  signOut,
  signUp,
} from 'aws-amplify/auth';
import { cognitoUserPoolsTokenProvider } from 'aws-amplify/auth/cognito';
import { sessionStorage as tabStorage } from 'aws-amplify/utils';
import type { CloudSource, CloudStep } from './auth-source';
import type { CloudConfig } from './cloud-config';

/** Amplify's sign-in steps that this app knows how to continue. */
function stepOf(step: string): CloudStep {
  switch (step) {
    case 'DONE':
      return 'done';
    case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
      return 'new-password';
    case 'CONFIRM_SIGN_UP':
      return 'confirm-sign-up';
    case 'RESET_PASSWORD':
      return 'reset-password';
    default:
      // MFA and custom challenges are not set up on the pool.
      throw Object.assign(new Error(step), { name: 'UnsupportedStep' });
  }
}

/**
 * The user pool, through Amplify with SRP: the password never leaves the browser. Tokens live in
 * sessionStorage (one tab), never localStorage; Amplify refreshes the access token with the
 * refresh token when it expires. The API checks the same app client (`client_id`).
 */
export class CognitoSource implements CloudSource {
  readonly kind = 'cloud';
  private readonly lastUserKey: string;

  constructor(config: CloudConfig) {
    Amplify.configure({
      Auth: {
        Cognito: {
          userPoolId: config.userPoolId,
          userPoolClientId: config.userPoolClientId,
          loginWith: { email: true },
          signUpVerificationMethod: 'code',
        },
      },
    });
    cognitoUserPoolsTokenProvider.setKeyValueStorage(tabStorage);
    this.lastUserKey = `CognitoIdentityServiceProvider.${config.userPoolClientId}.LastAuthUser`;
  }

  hasSession(): boolean {
    return window.sessionStorage.getItem(this.lastUserKey) !== null;
  }

  async getToken(): Promise<string | null> {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.accessToken.toString() ?? null;
    } catch {
      return null;
    }
  }

  async userLabel(): Promise<string | null> {
    try {
      return (await getCurrentUser()).signInDetails?.loginId ?? null;
    } catch {
      return null;
    }
  }

  async signIn(email: string, password: string): Promise<CloudStep> {
    await this.signOut(); // a session left in this tab would refuse a new sign-in
    const result = await signIn({ username: email, password });
    return stepOf(result.nextStep.signInStep);
  }

  async confirmNewPassword(password: string): Promise<CloudStep> {
    const result = await confirmSignIn({ challengeResponse: password });
    return stepOf(result.nextStep.signInStep);
  }

  async signUp(email: string, password: string): Promise<CloudStep> {
    const result = await signUp({
      username: email,
      password,
      options: { userAttributes: { email } },
    });
    return result.nextStep.signUpStep === 'CONFIRM_SIGN_UP' ? 'confirm-sign-up' : 'done';
  }

  async confirmSignUp(email: string, code: string): Promise<void> {
    await confirmSignUp({ username: email, confirmationCode: code });
  }

  async resendSignUpCode(email: string): Promise<void> {
    await resendSignUpCode({ username: email });
  }

  async forgotPassword(email: string): Promise<void> {
    await resetPassword({ username: email });
  }

  async confirmForgotPassword(email: string, code: string, password: string): Promise<void> {
    await confirmResetPassword({ username: email, confirmationCode: code, newPassword: password });
  }

  async signOut(): Promise<void> {
    try {
      await signOut();
    } catch {
      // Nothing to revoke, or no network: the local copy is gone either way.
    }
  }
}
