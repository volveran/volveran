// The link to a Checkout waiting for Approval, for the requester to paste in
// chat. It opens the Approvals view on that Checkout. The id travels in the
// URL fragment, which the server never routes on and sign-in keeps (returnTo).

const PREFIX = '#/approvals/';

/** The link to waiting Checkout `checkoutId` on the app at `origin` (e.g. window.location.origin). */
export function approvalLink(origin: string, checkoutId: string): string {
  return `${origin}/${PREFIX}${encodeURIComponent(checkoutId)}`;
}

/** The waiting Checkout a URL fragment (window.location.hash) links to, or null. */
export function waitingCheckoutIn(hash: string): string | null {
  if (!hash.startsWith(PREFIX) || hash.length === PREFIX.length) return null;
  try {
    return decodeURIComponent(hash.slice(PREFIX.length));
  } catch {
    return null;
  }
}
