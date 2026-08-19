# X Tweet Scraper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Implementers must use superpowers:test-driven-development and superpowers:verification-before-completion. The controller writes coordination artifacts only; Terra and Luna own all implementation code.

**Goal:** Deliver a production-grade, browserless Apify Actor for public X author timelines and tweet IDs, backed by a Vercel entitlement signer and an authoritative Upstash per-run output counter.

**Architecture:** A strict TypeScript Actor discovers current X web GraphQL operation IDs, manages guest sessions, parses and normalizes tweet results, applies filters, and obtains signed emission grants before every dataset push. A Node.js Vercel Function authenticates the canonical Actor, freezes entitlements, and atomically grants idempotent output slots in Upstash Redis.

**Tech Stack:** Node.js 24, TypeScript strict mode, Apify SDK v3, got-scraping, zod, Vitest, Vercel Functions, Upstash Redis, npm.

**Spec:** `/home/morgan-desktop/Downloads/senior-x-scraper-test-v2.pdf`

## Global Constraints

- HTTP requests only. Do not add Playwright, Puppeteer, Selenium, or any browser engine.
- Required surfaces: `UserByScreenName`, `UserTweets`, and `TweetResultByRestId`; `searchTerms` must fail validation clearly.
- Bootstrap operation IDs: `Gb-d6r0vxPOADdG62OEBpQ`, `SXVCYB8XHSS25nzIljNtZA`, and `GZsN2Pc4knAoit6pXa4HSA`; runtime discovery refreshes them from X public assets.
- The dataset tweet schema is exact: every nullable field is present as `null`, IDs remain strings, timestamps are ISO-8601 UTC, and counts are integers.
- Input defaults: `maxResults=100`, `includeReplies=true`, `includeRetweets=false`, `mediaType=any`, `sortBy=latest`; validate `maxResults` in `1..10000`; reject `sortBy=top`.
- Free/unknown runs may receive at most 10 grants. Paid runs may receive at most validated `maxResults`. No dataset push may occur without a valid signed grant.
- Entitlement authority is external and bound to canonical actor ID, run ID, and user ID. Invalid/missing identity, request authentication, signatures, or service availability must never grant paid access.
- Redis reservations are atomic, idempotent by hashed tweet ID, freeze the initial limit, and expire after seven days.
- Respect 429 reset headers and stop on generic 403/challenge responses. Never rotate tokens or proxy IPs to evade restrictions.
- Actor runs with limited permissions and uses sticky proxy affinity per guest session.
- Use TDD for production behavior and include RED/GREEN evidence in each task report.
- Do not publish to the Apify Store. Deployment is unlisted/shared and for the authorized assessment only.

---

### Task 1: Greenfield scaffold and contracts (Luna)

Before scaffolding, use the authenticated Vercel CLI under Node 24 to link/create the `x-tweet-scraper-entitlements` project and provision Upstash Redis through the Vercel Marketplace (`--yes --no-claim` where supported). Never print environment values. If the integration requires an interactive claim or unavailable credential, report `NEEDS_CONTEXT` before writing application code.

Create the Git repository directly on branch `feature/x-tweet-scraper`, add `.worktrees/`, `.vercel/`, local env files, and coordination scratch paths to `.gitignore`, and scaffold the npm project. Configure Node 24, strict TypeScript (`strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), Vitest, ESLint, build/typecheck/lint/test scripts, Docker, Apify actor metadata, and Vercel Node Function discovery without adding implementation behavior.

Define shared Zod/types for Actor input, exact tweet output, entitlement resolution, signed decisions, batch reservation requests, and signed reservation responses. Add `INPUT_SCHEMA.json`, output/dataset schemas, and tests proving input defaults/rejections and exact output nullability. Commit a clean baseline.

### Task 2: X guest HTTP extraction stack (Terra)

Implement bundle/manifest discovery, bootstrap fallback, operation registry caching, guest token activation, cookie/proxy-affine HTTP sessions, retry/rate-limit classification, `UserByScreenName`, `UserTweets`, and `TweetResultByRestId` clients. Implement URT instruction traversal, bottom cursor extraction, wrapper/module handling, tweet normalization, text URL expansion, media selection, source parsing, and every documented post-filter.

Use complete recorded fixtures and TDD. Cover stale operation refresh-once, 401 refresh-once, 429 reset handling, generic 403 stop, bounded 5xx/network retry, malformed GraphQL shapes, cursor variants, duplicates, replies/retweets, every media type, verified semantics, inclusive dates, language, engagement floors, and exact normalization.

### Task 3: Authoritative entitlements and emission guard (Luna)

Implement the Vercel Node.js resolution and batch-reservation endpoints, HMAC request verification with clock-skew validation, canonical actor binding, Ed25519 response signing, and an Upstash repository using atomic Lua operations. Freeze the initial tier/effective limit, expire run state after seven days, hash item IDs, return existing grants idempotently, and grant at most 20 IDs per request.

Implement the Actor client that reads platform identity, authenticates requests, verifies the pinned Ed25519 public key and response subject/expiry, and refuses all ungranted pushes. Add the serialized emission guard, migration state, statistics, and `OUTPUT` metadata. Tests must prove free `1000 -> 10`, paid `100 -> 100`, duplicate reservation idempotency, storage reset resistance, actor/user/run mismatch rejection, bad HMAC/signature/replay handling, and service-failure fail-closed behavior.

### Task 4: Actor coordinator and integration (Terra)

Integrate Tasks 2 and 3 into the Actor entrypoint. Resolve profiles, schedule up to three independent targets, maintain global seen IDs, paginate author timelines, hydrate tweet IDs, stop date-expired cursors, normalize/filter candidates, request reservation batches of at most 20, validate output, and push only granted items. Cancel further pagination once the remote limit is exhausted, but continue past filtered candidates until the requested number of valid outputs or source exhaustion.

Persist per-target cursors/exhaustion, seen IDs, and statistics with `Actor.useState()`/`persistState`; Redis remains the cap authority. Isolate target failures, produce structured logs, and always write the final `OUTPUT`. Add integration tests with fake external HTTP boundaries and real internal components.

### Task 5: Packaging, documentation, and deployment configuration (Luna)

Complete GitHub Actions for `npm ci`, lint, typecheck, test, build, and Docker build. Add an opt-in live smoke command, benchmark command, secret-safe `.env.example`, Vercel/Upstash provisioning instructions, Apify deployment configuration, and a complete README covering architecture, data flow, operation discovery, supported surfaces, search auth wall, entitlement threat model, anti-input/anti-fork reasoning, migration, proxy behavior, local/cloud use, limitations, costs, and X terms.

README performance numbers must remain explicitly unmeasured until a real paid run is executed. Dependency checks must demonstrate there is no browser engine.

### Task 6: Cross-review, verification, and publishing (Terra + Luna)

Terra reviews security/extraction integration and Luna reviews packaging/tests/deployment. Fix all Critical/Important findings through reviewed fix rounds. Run fresh full verification: clean install, lint, strict typecheck, unit/integration tests, production build, Docker build, dependency scan, signer smoke test, and fixture Actor run.

After local gates pass and the user-authenticated CLIs are available, provision/link the Vercel project and Upstash integration, deploy the signer with production-scoped secrets, deploy the unlisted/shared Apify Actor, pin the canonical actor ID/signer URL/public key, execute free and paid live runs, run the 100-result benchmark, replace the README's unmeasured marker with the observed result, then create/push the public GitHub repository. Publishing is an external side effect and must use the authorization already recorded in the parent request; never expose secret values in logs or commits.
