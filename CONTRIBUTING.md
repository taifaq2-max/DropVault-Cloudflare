# Contributing to VaultDrop

Thank you for your interest in contributing to VaultDrop.

---

## Branching model

| Branch    | Purpose                                   |
|-----------|-------------------------------------------|
| `main`    | Production — deployed to Cloudflare Pages / Workers automatically |
| `staging` | Pre-production — deployed to the staging environment automatically |

Feature work and bug fixes are developed on short-lived branches and merged
into `staging` first via a pull request.  After validation on staging they are
promoted to `main`.

---

## CI and required checks

Continuous integration runs automatically on every pull request that targets
`main` or `staging`.  The workflow (`.github/workflows/ci.yml`) runs the
following steps:

1. **Typecheck** — `pnpm typecheck`
2. **Build** — `pnpm build`
3. **Tests** — `pnpm test` (Vitest across the full workspace)
4. **Script verification** — dry-run tests for `deploy.sh` and
   `staging-bootstrap.sh`

The CI job is named **`Typecheck & Build`** in GitHub Actions.

### Merging into staging

The `staging` branch has a branch protection rule that requires the
**`Typecheck & Build`** status check to pass before a pull request can be
merged.  Do not bypass this gate — a failing CI on staging will trigger a
broken deploy.

To configure or verify the rule (requires admin access):

1. **Settings → Branches → staging** protection rule.
2. **Require status checks to pass before merging** must be enabled.
3. **`Typecheck & Build`** must be listed as a required check.
4. **Do not allow bypassing the above settings** should be enabled.

See [SECURITY.md — Branch Protection and CI Requirements](./SECURITY.md#branch-protection-and-ci-requirements)
for the full setup walkthrough.

---

## Running CI locally

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
bash tests/deploy-saved-defaults.sh
bash tests/deploy-dry-run.sh
bash tests/staging-bootstrap-dry-run.sh
```

---

## Pull request checklist

- [ ] CI passes locally (see above).
- [ ] New features are covered by Vitest unit/integration tests.
- [ ] No plaintext secrets or keys are committed.
- [ ] `pnpm typecheck` exits with no errors.
