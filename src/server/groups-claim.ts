// The Operator's groups, read from the signed-in identity's claims at sign-in
// (Team Mode). Each Broker Profile's `roles` maps groups to a Role
// (profile-access.ts). VOLVERAN_OIDC_GROUPS_CLAIM names the claim, default
// `groups`, as a dotted path into the claims (`realm_access.roles` on
// Keycloak); a top-level claim with that exact name, dots and all (Auth0's
// `https://example.com/groups`), wins over the path.
//
// The claim is read from the ID token; when the ID token does not have it,
// from the provider's userinfo endpoint. A list of strings is the groups, a
// single string a list of one. Anything else counts as no groups and is
// logged, and so does a userinfo request that fails. A claim missing from
// both counts as no groups too: an Operator without groups has a role only on
// profiles without `roles`. Never a failed sign-in.

/** Where sign-in reports a groups claim it could not use. */
export interface GroupsLog {
  warn(fields: Record<string, unknown>, message: string): void;
}

export interface GroupsAtSignIn {
  /** The ID token's claims. */
  idToken: Record<string, unknown>;
  /** VOLVERAN_OIDC_GROUPS_CLAIM. */
  claim: string;
  /** Fetches the provider's userinfo; null when the provider has no userinfo endpoint. */
  userinfo: (() => Promise<Record<string, unknown>>) | null;
  log: GroupsLog;
}

type ClaimValue = { kind: 'groups'; groups: string[] } | { kind: 'absent' } | { kind: 'malformed'; shape: string };

/** The Operator's group names; empty when there are none or the claim cannot be used (logged). */
export async function groupsAtSignIn({ idToken, claim, userinfo, log }: GroupsAtSignIn): Promise<string[]> {
  let source = 'ID token';
  let value = readClaim(idToken, claim);
  if (value.kind === 'absent' && userinfo) {
    source = 'userinfo';
    try {
      value = readClaim(await userinfo(), claim);
    } catch (err) {
      log.warn(
        { claim, err: (err as Error)?.message ?? String(err) },
        `The ID token has no groups claim "${claim}" and the provider's userinfo could not be read: the Operator has no groups`,
      );
      return [];
    }
  }
  if (value.kind === 'malformed') {
    log.warn(
      { claim, source, shape: value.shape },
      `The groups claim "${claim}" in the ${source} is ${value.shape}, not a list of group names: the Operator has no groups`,
    );
    return [];
  }
  return value.kind === 'groups' ? value.groups : [];
}

function readClaim(claims: Record<string, unknown>, path: string): ClaimValue {
  let value: unknown = claims[path];
  if (value === undefined) {
    value = claims;
    for (const key of path.split('.')) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        // A path through something other than an object: present but unusable.
        return { kind: 'malformed', shape: shapeOf(value) };
      }
      value = (value as Record<string, unknown>)[key];
      if (value === undefined) return { kind: 'absent' };
    }
  }
  if (typeof value === 'string') return { kind: 'groups', groups: value === '' ? [] : [value] };
  if (Array.isArray(value) && value.every((g) => typeof g === 'string')) {
    return { kind: 'groups', groups: [...new Set(value.filter((g) => g !== ''))] };
  }
  return { kind: 'malformed', shape: shapeOf(value) };
}

function shapeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list with entries that are not strings';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}
