# Public-source Gaming scenario candidates

[gaming-public-sources.json](gaming-public-sources.json) supplies five candidate
cases for the [isolated live PR preview runner](../../docs/LIVE_PR_PREVIEW.md).
The manifest follows its version-1 Gaming scenario contract. Each `sourceUrls`
entry exactly matches the corresponding `input.guideUrl`.

| Case | Source and intended boundary |
| --- | --- |
| `useful_grounded_guide` | The Stardew Valley Getting Started guide supplies first-crop instructions. The request explicitly selects the Standard Farm: the guide distinguishes its 15 Parsnip Seeds from the Meadowlands Farm's starting animals and hay. |
| `incompatible_source` | A Minecraft farming question supplies the Stardew Valley guide, creating an explicit game mismatch. |
| `insufficient_evidence` | The Stardew Valley creator biography is supplied for first-crop instructions. Its suitability as an insufficient-evidence case still needs backend verification. |
| `acquisition_failure` | A deliberately absent Stardew Valley Wiki page exercises source acquisition failure. |
| `unauthorized_test_identity` | The useful-guide input is reused; the trusted runner substitutes an invalid test bearer and expects rejection before acquisition or provider work. |

Bounded public GETs on 2026-10-05 returned HTTP 200 for `Getting_Started` and
`ConcernedApe`, and HTTP 404 for the deliberately absent page. These checks did
not store page bodies. Source pages can change; recheck them before an authorized
run. Retrieval, compatibility, grounding, generation, accepting final-answer
audit, and all live case outcomes remain unverified.

To validate every manifest entry offline, copy it into an owner-only operator
file outside the checkout, then run from the repository root with pinned Node:

```bash
scenario_dir="$(mktemp -d /tmp/arcanos-live-scenarios.XXXXXX)"
install -m 600 examples/live-pr-preview/gaming-public-sources.json "$scenario_dir/scenarios.json"
node scripts/live-pr-preview-e2e.mjs \
  --module-id gaming \
  --commit-sha "$(git rev-parse HEAD)" \
  --pr-number 1527 \
  --backend-base-url https://backend.live-pr-1527.example.com \
  --scenario-file "$scenario_dir/scenarios.json"
```

Add `--case-id useful_grounded_guide` to validate just that entry. The example
backend origin is an offline placeholder; an authorized execution uses the exact
private origins covered by its signed attestation. Offline validation reports
the scenario case IDs and leaves live verification unverified.

The three remaining suite cases require separately prepared sessions:
`model_timeout` needs a genuine observed generation transport timeout;
`audit_timeout` needs completed generation followed by a genuine audit timeout;
and `exhausted_budget` needs trusted broker evidence of budget denial before
another provider invocation. The current scenario input does not configure
stage timeouts or prepare an exhausted budget. Case names alone cannot establish
those outcomes. A timed-out or failed provider request closes its broker session.

Keep all sessions within the user's aggregate spending, request, and elapsed-time
caps. Sum conservative reservations across approvals, including uncertain and
timed-out attempts. A fresh approval or session does not reset the user's cap.
Follow the main runbook for signed approval, independent isolation evidence,
private routing, credentials, source checks, and sanitized execution evidence.
