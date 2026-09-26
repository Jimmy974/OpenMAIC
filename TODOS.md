# TODOS

## Auth

### Company deployment with company SSO

**What:** Deploy OpenMAIC on company infrastructure with oauth2-proxy + Microsoft Entra ID feeding a signed-identity bridge adapter, and a company-approved model.

**Why:** Company content must not flow through the family home server or a personal Grok subscription, but colleagues want the same per-person libraries, parent-style oversight (manager view) and sharing.

**Context:** The signed-identity contract (provider-neutral headers `X-OpenMAIC-Identity-*`, HMAC over the transmitted values) is defined in `docs/designs/tailscale-identity-login.md` §1; the app needs no changes. Start from `scripts/identity-bridge.mjs`: replace the Tailscale header reader and root-peer check with an oauth2-proxy `X-Forwarded-Email`/`X-Forwarded-User` reader behind a trusted network boundary. Decided in /plan-eng-review D28 (2026-09-26).

**Effort:** M
**Priority:** P3
**Depends on:** Family login feature shipped (branch `feat/tailscale-identity`); company IT approval for hosting and model choice.

## Completed
