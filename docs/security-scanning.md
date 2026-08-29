# Security Scanning (#83, #82, #81)

What's actually running, where findings surface, and what's explicitly out of scope with why.

## SAST — CodeQL (#83)

`.github/workflows/codeql.yml` runs CodeQL against JavaScript/TypeScript on every push to `main`, every PR, and weekly on a schedule (catches newly disclosed vulnerability patterns in code that hasn't changed recently).

- **Query pack**: `security-extended` — GitHub's broader security query pack (beyond the CodeQL default setup's `security-and-quality`), covering more injection variants, CORS misconfiguration patterns, and similar.
- **Findings surface in the repo's Security tab** (Security → Code scanning alerts) — this is CodeQL's native findings-tracking mechanism (SARIF upload via `codeql-action/analyze`, which the workflow uses by default). It substitutes for a hand-built "security dashboard": trends, alert status (open/dismissed/fixed), and severity are all tracked there without any custom infrastructure.
- **Not implemented — custom business-logic queries**: #83 asks for "custom rules for business logic." Authoring correct CodeQL QL requires the `codeql` CLI to test a query against known-good/known-bad fixtures before trusting it — not available in the environment this PR was built in. A hand-written query that's wrong either silently finds nothing (false confidence) or floods false positives (alert fatigue) — both worse than shipping none. Flagged for whoever has a CodeQL CLI setup to author and verify queries against this repo's actual escrow/payment authorization code paths.
- **Not implemented — merge-blocking quality gate**: CodeQL findings currently surface in the Security tab but do not block PR merges. Wiring that up (e.g. failing the check on any new `error`/`critical` finding) is a policy decision for a maintainer, not something to default into a PR silently.

## DAST — not implemented (hard blocker)

#83 also asks for DAST (OWASP ZAP/Nuclei) "against staging, nightly." **This repo has no staging environment** — confirmed via `docker-compose.yml` (only defines local `postgres`/`redis`, no app services or staging profile) and `infrastructure/` (README-only stubs describing an aspirational AWS/Terraform setup that isn't provisioned). There is nothing reachable to point a DAST scanner at.

Two real paths forward, neither attempted here:

1. **Provision a real staging deployment first**, then add a DAST workflow against it. This is an infrastructure project, not a scanning-config change.
2. **Substitute a local scan**: spin up the docker-compose stack in CI and run OWASP ZAP's baseline scan against it. This is achievable without real infrastructure, but it is explicitly **not equivalent** to a real DAST run — no real network topology, no real auth flows exercised end-to-end, no production-like data. If this path is chosen later, label it clearly as a local substitute, not "DAST against staging."

## Dependency scanning (#82)

- **`.github/dependabot.yml`**: weekly scans across every workspace package (root + each `apps/backend/*`, `agents`, `packages/*`), grouped patch/minor updates batched into one PR per package per week, `github-actions` ecosystem included (a stale/unpinned Action is itself a supply-chain risk).
- **`pnpm audit --prod --audit-level=high`** in `ci.yml`'s `security-scan` job now actually gates merges — was `continue-on-error: true` before this PR (advisory only, never blocking). Fixed the 3 real high-severity findings that existed at the time (see `pnpm-workspace.yaml`'s comment for the fix and why it's a direct `@stellar/stellar-sdk` version bump rather than a pnpm `overrides` entry).
- **SBOM generation**: `ci.yml`'s `security-scan` job generates a CycloneDX SBOM via `@cyclonedx/cdxgen` (not `cyclonedx-npm` — that tool shells out to `npm ls`, which errors against this repo's pnpm-managed `node_modules` layout) and uploads it as a build artifact, retained 90 days.
- **Not implemented — license compliance enforcement**: #82 asks for this explicitly. No license-checking tool is wired up; this repo's dependency tree hasn't been audited for license compatibility as part of this PR.
- **Auto-remediation PRs**: this is what Dependabot's `updates` config itself provides (it opens PRs for outdated/vulnerable dependencies automatically) — no additional tooling needed beyond `.github/dependabot.yml` existing.

## Secret scanning (#81)

See [`secret-management.md`](./secret-management.md) for the full writeup — Gitleaks on every push/PR, `.gitleaks.toml` + `.gitleaksignore` for allowlisting/suppression, and the manual credential-rotation procedure (no secrets-manager integration exists yet to automate rotation against).
