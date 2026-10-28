// The prompt under an error that only signing in again fixes: the Operator's
// access token for a Broker Profile with `credentials: operatorToken` has
// expired and could not be refreshed (`broker_token_expired`).
import { signIn, type ApiError } from './api.js';

export function SignInAgain({ error }: { error: ApiError }) {
  if (error.code !== 'broker_token_expired') return null;
  return (
    <p>
      <button onClick={signIn}>Sign in again</button>
    </p>
  );
}
