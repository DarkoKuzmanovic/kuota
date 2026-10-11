# OpenDesign (Go plan): usage recon

Status: **deferred** (owner decision, 2026-10-11) until OpenDesign ships Linux support. See PLAN.md *Deferred providers*. No version bump for this until the provider lands.

## Findings (probed 2026-10-11; status codes and response shapes only, no values)

- **The API key cannot read usage.** `OPENDESIGN_API_KEY` (the Hermes provider key for `https://amr-link.open-design.ai/v1`) gets 200 from `/v1/models`. It gets 404 from every usage/billing path tried: `/v1/dashboard/billing/{subscription,usage}`, `/v1/usage`, `/v1/credits`, `/v1/key`, `/api/usage/token` and `/api/user/self`. `/v1/models` responses carry no balance or usage headers.
- **The real balance API needs a different credential.** `GET https://amr-api.open-design.ai/api/v1/wallet/balance` returns `{balanceUsd: "<decimal string>", updatedAt?}` when called with a Cloud sign-in "control key". With the API key it returns 401. `/api/v1/me` behaves the same way.
- **Where the control key lives:** the closed-source `vela`/`amr` CLI (Go) writes it during a device-authorization login (`vela login`) to `~/.amr/config.json` (or `$AMR_HOME/config.json`), at `profiles[<profile>].controlKey`. The same entry also holds `runtimeKey` and `user.{id,email,name,plan}`. Source: `nexu-io/open-design` `apps/daemon/src/integrations/vela.ts` and `vela-wallet.ts`.
- **Plan windows exist:** `vela billing preflight|summary --format json` returns `codingPlan.tier` (`go|plus|pro|max`) and `windows[]`, each with `usedCredits`, `remainingCredits` and `limitCredits` (integer strings), plus `resetsAt`, `durationSeconds` and `resetMode`. The parser is in `apps/daemon/src/integrations/vela-billing.ts`. The HTTP endpoint the CLI calls for this is not known yet, because the CLI is closed source.
- **No Linux build:** OpenDesign ships desktop builds for macOS and Windows only, and `vela`/`amr` is not on PATH here. `~/.amr` does not exist.

## Next step (after the owner signs in)

1. Confirm that `~/.amr/config.json` exists and record its key names only.
2. Probe the wallet and billing endpoints with the control key and record the response shapes.
3. Write `docs/specs/<date>-opendesign-design.md` to cover: a read-only control-key source with no refresh (it belongs to another tool), the credit windows, and the PLAN.md milestone. Then follow the provider-addition sequence and bump the version together with the provider.
