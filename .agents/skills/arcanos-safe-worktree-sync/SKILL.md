---
name: arcanos-safe-worktree-sync
description: Safely synchronize an ARCANOS checkout with its remote branch or transfer branch ownership between worktrees while preserving local work. Use for workspace sync, make local and remote match, or main is checked out elsewhere; do not apply it to ordinary PR review.
---

# ARCANOS safe worktree sync

Align the user-selected checkout and branch while preserving existing commits, modifications, ignored files, stashes, and unrelated worktrees. Resolve paths and branch names from the current task; do not reuse historical checkout paths or assume every request targets `main`.

## Establish the target and existing authority

Read `AGENTS.md` for the target checkout. Inspect repository root, branch or detached state, HEAD, upstream, `git status --short --branch`, `git worktree list --porcelain`, and current divergence. Inspect staged/unstaged filename summaries rather than printing potentially sensitive file contents. Preserve rebase/merge/cherry-pick state; an active operation needs a scoped resolution before synchronization.

An explicit request to sync the selected checkout authorizes the necessary ordinary fetch and fast-forward. Preserve authorization already given for backup/stash creation, exact branch alignment, or transferring ownership. It does not implicitly authorize pushing, merging a PR, deleting worktrees, deploying, or changing an unrelated checkout. Ask only when a specific required target or action remains outside the existing scope, and explain that boundary.

Verify the intended remote identity without printing credential-bearing remote URLs. Fetch the requested branch into its tracking ref and resolve it locally; use `git ls-remote --heads` for a final live comparison when needed. If remote state cannot be refreshed, label the tracking ref as cached and do not claim current remote equality.

Protect ignored files before every merge, checkout, or switch, including clean checkouts and detached-head transitions. A clean `git status` does not reveal ignored files, and Git can overwrite them when the target starts tracking the same path. Pass `--no-overwrite-ignore` to `git merge`, `git checkout`, or `git switch`; if a collision is reported, stop and preserve the affected files outside the checkout before retrying within the authorized scope. Backup branches and `git stash --include-untracked` do not save ignored files.

## Select the smallest safe path

### Clean checkout, same branch, fast-forward possible

Fetch the verified remote branch and use `git merge --ff-only --no-overwrite-ignore` on the resolved tracking ref. Use this two-step sequence because `git pull` does not accept `--no-overwrite-ignore`. A refusal signals divergence, a local-file collision, or another precondition failure; investigate rather than retrying with an automatic merge, rebase, hard reset, or ignored-file overwrite.

### Dirty checkout or branch-only commits

Before a branch switch or authorized realignment, preserve the current HEAD with a uniquely named backup branch and save staged/unstaged plus normal untracked changes in a uniquely named stash using `git stash push --include-untracked --message "<unique-recovery-name>"`, replacing the placeholder with a unique name for this operation. Do not stash merely to answer a status question. Check ignored/untracked path names for prospective checkout collisions; never include ignored files with `--all` as routine preservation.

Record the backup branch and OID, stash OID, source checkout/branch, and target OID. Verify the backup resolves to the original HEAD, verify stash parent and tree metadata and applicable untracked entries, and independently recheck checkout cleanliness before proceeding. Line-ending normalization can make stash summaries misleading; an empty `stash show` alone is not proof that nothing was saved. If preservation fails, stop dependent writes and retain all recovery objects.

If the goal is to keep working with local changes, restore them with `git stash apply --index` only when consistent with the requested result. If the goal is exact remote equality, keep them in the named stash and report how to restore them later. Do not pop or drop the stash automatically. On apply conflicts, retain the stash and report the conflict state; do not discard or repeatedly reapply it.

For divergence, distinguish ordinary synchronization from an explicit request to replace the target branch state while preserving local work. The latter permits a carefully scoped ref realignment only after the above recovery evidence and branch-ownership checks are complete. If that intent is absent, show the divergence and smallest options before any history rewrite. Never force-push as a consequence of local synchronization.

### Desired branch belongs to another worktree

Identify the exact holder using the worktree inventory. Check whether transferring its ownership is included in the user's request. If authorized, verify it is clean, has no active operation, and is not being used by an active task; record its HEAD. Detach only that verified holder at its existing HEAD, then confirm its HEAD and files are unchanged. Switch the target checkout to the desired branch and fast-forward as appropriate.

If the holder is dirty, active, locked, inaccessible, or outside the authorized scope, leave it intact. When the user requested checkout equality without requiring ownership of the local branch, proceed with the selected checkout detached at the verified remote commit after preserving its local work; this satisfies that authorized result without another approval. A task branch is also suitable when consistent with the request. If the user specifically requires branch ownership and that cannot be transferred safely within scope, report the precise blocker and request the missing decision. Do not remove the holder, force checkout with ignored ownership checks, or update a branch ref still attached elsewhere.

## Windows and recovery details

- Use PowerShell with explicit working directories and literal paths. Never repurpose `$HOME`, `$home`, or `$CODEX_HOME`. Avoid shell-built command strings and pass branch/ref arguments as values after validation.
- Do not use `git clean`, blanket hard resets, recursive filesystem deletion, or worktree prune/remove as routine sync steps. Ignored dependencies and other worktrees must survive.
- Inspect relevant Git hook behavior before a checkout operation that may run it. If hooks or Git LFS fail, re-read HEAD, branch ownership, and status: an error may occur after a partial state change. Do not bypass hooks, install tools, or retry destructive steps blindly.

## Verify and report

Re-read target branch/upstream, HEAD, tracking ref, divergence, dirty state, and worktree ownership. For exact equality, require zero ahead/behind and equality with a freshly observed remote OID; if the remote moved, refresh and re-evaluate rather than declaring success from the earlier snapshot. For preservation-and-restore, distinguish synchronized commits from intentionally restored local modifications.

Report the resulting branch/OID, ahead/behind counts, worktree state, recovery branch/stash identifiers, and any remaining limitation. Retain recovery objects until the user authorizes their removal. A successful local sync does not imply a push, PR merge, or deployment.
