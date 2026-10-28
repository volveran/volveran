# A Broker Profile without `roles` keeps every Operator `admin`

v0.3 adds Roles per Broker Profile: a profile's `roles` mapping gives OIDC groups the role `viewer`, `operator` or `admin`, and an Operator in no mapped group has no role on it. A profile with no `roles` mapping at all could mean "nobody" (deny by default) or "everybody, as before". We chose everybody: in Team Mode every signed-in Operator is `admin` on a profile without `roles`, exactly as in v0.2, and startup logs a warning naming each such profile. Upgrading to v0.3 then changes nothing for a team until it writes its first mapping, and a deploy can never lock the whole team out of a broker in the middle of an incident because a mapping was forgotten.

## Considered Options

- **Deny by default** (a profile without `roles` has no Operators): safer for a new install, but every v0.2 install would lose all access on upgrade until roles were written for every profile, and the groups claim was configured and tested at the provider first. Kept as a possible later change, behind a setting or a major version.
- **A global default role** (for example `viewer` unless mapped): one more setting to explain, and still a silent change of behaviour on upgrade.

## Consequences

- A profile is only as restricted as its `roles` says. A platform engineer who adds `roles` to `prod` but not to `staging` leaves `staging` open to everyone who can sign in; the startup warning is the reminder.
- Audit Entries of a Broker Profile no longer in the profiles file have no mapping either. Treating them like a profile without `roles` would let every signed-in Operator read their Discarded bodies, including one with no role anywhere, so they are not: on such an entry the Operator holds the highest role they hold on any configured profile (`admin` in Solo Mode; a configured profile without `roles` counts, so before the first mapping nothing changes). An Operator with no role anywhere does not find these entries in the search and is refused them with `403 no_role_on_profile`. Nothing can be done on that broker any more, since Restore needs a configured profile.
- Solo Mode ignores `roles` (one startup log line): its single Operator is `admin` everywhere, so one profiles file serves both modes.
