// A request the web app sends on its own, with nobody necessarily at the page, carries this
// header. It does not count as the Operator's activity for the idle timeout of sign-in (auth.ts).
export const BACKGROUND_REQUEST_HEADER = 'x-volveran-background';
