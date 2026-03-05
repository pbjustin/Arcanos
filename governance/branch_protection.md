# Branch protection and human approval (Level ≥ 2)

This repo includes a CI check (`Require Human Approval (Self-Improve)`) that **fails** when a PR is labeled `requires-human-approval` (or `autonomy-2` / `autonomy-3`) and there is **no APPROVED review from someone other than the PR author**.

To enforce this before merge:

1. In GitHub → **Settings → Branches → Branch protection rules**:
   - Add rule for `main`
   - Enable **Require a pull request before merging**
   - Enable **Require approvals** (set to 1 or more)
   - Under **Require status checks to pass**, select:
     - `PR CI` (from `.github/workflows/pr-ci.yml`)
     - `Require Human Approval (Self-Improve)` (from `.github/workflows/require-approval.yml`)
   - (Optional) Enable **Require review from Code Owners**

2. (Optional) Add CODEOWNERS.
   - Copy `governance/templates/CODEOWNERS.example` to `.github/CODEOWNERS`
   - Replace the placeholder handles with your team/users.

Notes:
- Self-improve PRs are created with labels: `self-improve`, `autonomy-<n>`, and either `requires-human-approval` (for n ≥ 2) or `propose-only`.
- The approval check is label-driven so you can apply it to other PRs by adding the label manually.
