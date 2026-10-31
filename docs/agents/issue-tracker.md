# Issue tracker

GitHub Issues on `volveran/volveran`, through `gh`.

- **Spec**: an issue with the problem, the solution and user stories, labelled with its version.
- **Ticket**: an issue carrying out part of a spec. It uses GitHub's native blocked-by to say what must land first (`gh api graphql`, field `blockedBy`), not a list in its body.
- **Version label**: `v<major>.<minor>` of the release the ticket ships in, which can be earlier than the version its spec names.
- **Closing**: a pull request closes work, with `Closes #<n>` in its body. A ticket stays open until that merges.
