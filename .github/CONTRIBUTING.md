# Contributing to CoClaw

## Branch protection

`main` is protected by a GitHub **Repository Ruleset** (managed via the API,
not classic branch protection). Source of truth:
[`/.github/rulesets/main-branch-protection.json`](./rulesets/main-branch-protection.json).

The ruleset enforces, on every direct push or PR merge into `main`:

| Rule                                | Behavior                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `deletion`                          | Nobody can delete `main`.                                                                |
| `non_fast_forward`                  | Force pushes to `main` are rejected.                                                     |
| `required_linear_history`           | No merge commits — every PR must squash or rebase.                                       |
| `pull_request`                      | 1 approving review **+** approval from a CODEOWNER **+** all PR threads resolved.        |
| `required_status_checks` (strict)   | `typecheck`, `test`, `build`, `package` must pass *and* the branch must be up to date.   |

Repository admins (you) are listed as a `bypass_actor` with `bypass_mode: always`,
so emergency hotfixes are still possible — but try not to. The whole point of
the ruleset is that the merge button doesn't light up until CI is green.

### Verify the ruleset is active

```bash
gh api repos/gdhanush27/co-claw/rulesets --jq '.[] | {id,name,enforcement}'
gh api repos/gdhanush27/co-claw/rulesets/<id> --jq '{rules:[.rules[]|.type], bypass_actors}'
```

### Re-apply / update the ruleset

If you edit `main-branch-protection.json`, push the change with:

```bash
# Replace the existing ruleset (PUT requires the ruleset id).
RULESET_ID=$(gh api repos/gdhanush27/co-claw/rulesets --jq '.[] | select(.name=="main branch protection") | .id')
gh api \
  --method PUT \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  repos/gdhanush27/co-claw/rulesets/$RULESET_ID \
  --input .github/rulesets/main-branch-protection.json
```

### Delete the ruleset (escape hatch)

```bash
gh api --method DELETE repos/gdhanush27/co-claw/rulesets/$RULESET_ID
```

## CI workflows

| Workflow                  | Trigger                                | Purpose                                                                                          |
| ------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`ci.yml`](./workflows/ci.yml)        | push to `main`, PR to `main`, manual    | Type-check (`tsc --noEmit`), unit tests (mocha), production build (esbuild), `vsce package` smoke. |
| [`release.yml`](./workflows/release.yml) | tag matching `v*`, manual            | Re-runs gates, builds the `.vsix`, attaches it to a generated GitHub Release.                    |

All jobs run on `ubuntu-latest` with Node 20 LTS and `npm ci` for deterministic
installs. Each step pins to read-only `GITHUB_TOKEN` permissions; the release
workflow elevates to `contents: write` only for the release publish step.

### Cutting a release

```bash
# 1. Bump the version in package.json (must match the tag without the leading "v").
# 2. Commit, open a PR, get it merged via the protected pipeline.
# 3. Tag main and push.
git tag v0.2.2
git push origin v0.2.2
# Release workflow takes it from there: builds, publishes the GitHub Release,
# uploads the .vsix asset.
```

The release workflow refuses to publish if `package.json` and the tag disagree.

## Dependency updates

This repo intentionally has **no Dependabot config** — we don't want
auto-generated PRs cluttering the queue. Dependency hygiene is a manual
discipline:

```bash
npm outdated          # see what's behind
npm audit             # see what's vulnerable
npm update            # bump within the lockfile's semver range
```

Re-enable Dependabot later by re-creating `.github/dependabot.yml` and
turning `dependabot_security_updates` back on:

```bash
gh api --method PATCH repos/gdhanush27/co-claw \
  -f 'security_and_analysis[dependabot_security_updates][status]=enabled'
```

Dependabot **vulnerability alerts** (notifications only — no PRs) remain
enabled by default for public repos. Disable them with
`gh api --method DELETE repos/gdhanush27/co-claw/vulnerability-alerts` if
you want full silence.

## CODEOWNERS

Default owner for the repo is `@gdhanush27`. CI/build/policy paths
(`/.github/`, `package.json`, `tsconfig.json`, `esbuild.js`) explicitly
require their owner's review so an automated bump can't bypass scrutiny.
