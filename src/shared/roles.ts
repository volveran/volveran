// Roles (GLOSSARY): what an Operator may do on one Broker Profile, shared by
// the server and the web app. Pure values and types (no Node or DOM APIs).
//
// The role `operator` is not the Operator (the person): prose writes roles in
// code format.

/** Every Role, lowest first: each one includes the ones before it. */
export const ROLES = ['viewer', 'operator', 'admin'] as const;

export type Role = (typeof ROLES)[number];

/** Whether `held` includes `required` (the same role or a higher one). */
export function roleIncludes(held: Role, required: Role): boolean {
  return ROLES.indexOf(held) >= ROLES.indexOf(required);
}

/** The highest of `roles`, or null when there is none. */
export function highestRole(roles: Iterable<Role>): Role | null {
  let highest: Role | null = null;
  for (const role of roles) if (highest === null || roleIncludes(role, highest)) highest = role;
  return highest;
}
