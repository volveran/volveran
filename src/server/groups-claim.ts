// The Operator's groups, read from the signed-in identity's claims at sign-in
// (Team Mode). Each Broker Profile's `roles` maps groups to a Role
// (profile-access.ts). VOLVERAN_OIDC_GROUPS_CLAIM names the claim, default
// `groups`: a top-level claim holding a list of group names.
//
// Anything else in the claim counts as no groups, and so does a missing
// claim: an Operator without groups has a role only on profiles without
// `roles`. Never a failed sign-in.

/** The group names in claim `claim` of `claims`; empty when there are none or the claim is not a list of strings. */
export function groupsFromClaims(claims: Record<string, unknown>, claim: string): string[] {
  const value = claims[claim];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((g): g is string => typeof g === 'string' && g !== ''))];
}
