// An API error as the Checkout and Approvals pages show it: its message and
// code, and the "Sign in again" button when only that fixes it.
import type { ApiError } from './api.js';
import { SignInAgain } from './SignInAgain.js';

export function ErrorBox({ error }: { error: ApiError }) {
  return (
    <div className="error" role="alert">
      <p>{error.message}</p>
      <code>{error.code}</code>
      <SignInAgain error={error} />
    </div>
  );
}
