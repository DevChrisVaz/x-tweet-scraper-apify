# X Tweet Scraper for Apify

This Actor retrieves public X author timelines and individual tweets over X's HTTP GraphQL endpoints, normalizes them into a stable dataset contract, and enforces the entitlement decision before any tweet is emitted. It is designed for authorized assessment and research workloads only. It does not use a browser, automate login, evade an access wall, or claim that an X response is available when it is not.

## Architecture and data flow

The Apify Actor receives validated input, obtains its platform identity from Actor.getEnv(), resolves the run's entitlement with the signer, discovers the current public X operation manifest, keeps one guest session and one configured proxy transport, fetches an author profile/timeline or tweet by ID, normalizes and filters candidate tweets, reserves tweet IDs, and emits only IDs covered by a signed reservation. The coordinator checkpoints cursors, seen IDs, pending grants, and run statistics in Apify state and writes one output metadata record at completion.

The Vercel Node.js 24 Functions are the entitlement authority. They authenticate Actor requests with one canonical JSON body plus timestamp/nonce headers and an HMAC, freeze the first decision for (actorId, runId, userId), sign resolutions and reservation decisions with Ed25519, and reserve SHA-256 tweet-ID hashes atomically in the Marketplace-provisioned Upstash Redis instance. Reservation records have a seven-day TTL and retries are idempotent. Redis state is authoritative; local Actor state is a resumable checkpoint, never a billing authority.

~~~text
Apify input -> Actor.getEnv identity -> HMAC signer request -> Vercel Functions
      ^                                                        |
      |                                                        v
dataset <- emission guard <- signed grant <- Redis Lua reservation <- Ed25519 signer
~~~

## Input and output

The supported input is defined by INPUT_SCHEMA.json. Use a non-empty fromUsers array for author timelines or a non-empty tweetIds array for individual tweets. maxResults, date/language/engagement filters, reply/retweet flags, media filters, verification, and the documented Apify proxy configuration are supported. searchTerms is rejected by the platform schema and runtime: this Actor does not pretend to implement search through X's top authentication wall.

Each dataset item follows OUTPUT_SCHEMA.json, including stable author, metrics, entities, media, source, UTC createdAt, and UTC-Z scrapedAt. Run-level tier, effective limit, and discovered, filtered, reserved, emitted, denied, and errors statistics are written to the persisted output metadata contract. Malformed X graph shapes are rejected rather than turned into partial output.

Supported HTTP-only surfaces are:

- author profile lookup and the author's tweet timeline;
- individual tweet lookup by REST ID;
- the profile lookup used to resolve an author ID before timeline paging.

Quote/reply/retweet metadata may be normalized when present in a returned tweet, but a separate search endpoint is not promised. X operation IDs are discovered from the public manifest and verified bootstrap IDs are retained as a fallback. A build-key change invalidates the cache; operation drift receives one discovery refresh and then fails closed.

## Entitlement and security model

Only Apify's platform-controlled Actor.getEnv() fields are trusted for identity and payer status: actorId, actorRunId, userId, and the documented userIsPaying value "1". Input fields, user environment, and a caller-provided override cannot assert a paid tier. The Vercel Function never reads a deployment-global payer bit. Missing identity, an unrecognized payer value, signer outage, invalid HMAC, replay, actor mismatch, invalid Ed25519 signature, expired grant, or Redis mutation failure freezes the run to free/unknown and prevents unreserved emission.

The first resolved limit for a run is sticky: free is capped at 10, paid is capped at the requested maximum, and a later request can never raise a frozen limit. The Actor verifies the subject, key ID, expiry, limit, and Ed25519 signature before accepting a resolution or reservation. The Lua reservation is the only concurrent cap authority. It grants each new hash at most once, grants duplicate retries idempotently, denies after the frozen cap, and preserves the seven-day TTL. Tweet IDs are not stored in Redis; only their SHA-256 hashes are stored. Subject keys are hashes of canonical {actorId,runId,userId} JSON, so delimiters or user-controlled characters cannot collide.

Forked or copied Actor runs do not inherit a grant: the signer binds every request and signature to the exact actor, run, and user subject. A copied local state file cannot grant output without a fresh signer decision. Sticky proxies preserve one transport identity for a run; proxy rotation is not used to evade limits, access controls, or rate limits.

## State and migration

Apify state is versioned and contains target cursors, visited cursors, seen IDs, pending tweets, and run statistics. Restored pending tweets are reconciled before new work. The entitlement repository accepts the current persisted run representation and migrates legacy grantedHashes arrays to the current granted map during initialization. Redis KEEPTTL is used for atomic reservations so a mutation cannot silently extend a grant. A state schema change must increment the version and add a migration before deployment; never hand-edit a production Redis key.

## Local checks and smoke commands

Use Node.js 24 (the repository pins >=24 <25 in package.json and .node-version, enforces engine-strict in .npmrc, and runs a preflight check):

~~~sh
npm ci
npm run preflight:node
npm run verify
npm run fixture:run
npm run signer:smoke
~~~

fixture:run uses deterministic in-memory X and entitlement fixtures and never contacts X. signer:smoke generates an ephemeral Ed25519 key, verifies a paid requested cap, and exercises duplicate reservations without printing key material. check:browser fails if a browser engine dependency enters the lockfile. validate:packaging checks the Dockerfile, Apify manifest, Vercel runtime, ESLint ignores, and that policy.

The live commands are opt-in and HTTP-only. They require explicit targets and confirmation, for example LIVE_SMOKE_CONFIRM=1 LIVE_X_USERNAME=... LIVE_X_TWEET_ID=... npm run smoke:live; an optional LIVE_X_PROXY_URL must be a permitted sticky proxy. They use real profile, author-timeline, and tweet responses and fail if a response is missing an ID; they never fabricate results. benchmark:live has the same explicit-target requirement and reports the honest status UNMEASURED_UNTIL_TASK6_PAID_RUN. No live smoke, paid behavior, or benchmark result is claimed by this repository.

## Deployment

The production Actor is built by Dockerfile from Node 24 and starts dist/index.js. .actor/actor.json points to that Dockerfile and the checked-in input/dataset schemas. The Vercel Functions in api/entitlements/ use the supported default Node.js runtime (with a 300-second limit) in vercel.json; its explicit null build and output settings keep this API-only project from being treated as a static site requiring `public`. package.json pins deployments to Node 24 and they are not Edge Functions.

The intended/provisioned names are Vercel project x-tweet-scraper-entitlements and Marketplace resource upstash-kv-cordovan-village. Connection of that resource, secret configuration, Vercel deployment, and Apify deployment remain Task 6 actions; this worktree makes no deployment claim. The Marketplace normally injects KV_REST_API_URL and KV_REST_API_TOKEN. The signer accepts those names and falls back to UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN; when both mappings exist, the UPSTASH_REDIS_REST_* aliases take precedence. The example contains names and harmless placeholders only; private keys, HMACs, REST tokens, and .env.local values must never be committed or printed. The Actor receives only its endpoint, HMAC, and pinned public key through the deployment secret mechanism; payer status continues to come from Apify runtime identity.

Task 6 operator checklist (authenticated operator only; not executed here):

1. In the Vercel dashboard, confirm project x-tweet-scraper-entitlements and attach the existing resource upstash-kv-cordovan-village; do not create a second Redis resource.
2. Link locally with `vercel link --project x-tweet-scraper-entitlements`, pull only to an ignored file with `vercel env pull .env.local`, and confirm the attached resource supplies KV_REST_API_URL/KV_REST_API_TOKEN (or explicitly configure the UPSTASH_REDIS_REST_* aliases). Do not place secret values in commands, logs, or commits.
3. Run `npm ci`, `npm run verify`, and `npm run docker:build` where Docker is available; inspect the generated deployment configuration.
4. After reviewing the pinned public key and canonical actor binding, an authorized operator may run `vercel deploy --prod` and the normal Apify Actor release command (`apify push`). These commands were not run for Task 5.

CI runs clean npm ci, browser-engine policy, packaging validation, lint, strict typecheck, the complete Vitest suite, build, and a Docker build on Node 24; both CI jobs that invoke npm use setup-node with Node 24. The workflow does not publish or deploy. A deployment gate should run these checks again and verify the configured signer public key and actor binding before accepting traffic.

## Limitations, cost, and authorization

X can change public manifests, operation IDs, guest access, response shapes, rate limits, or terms without notice. Public guest access can fail even when the code is healthy. Apify compute, dataset, proxy, Vercel Function, and Upstash request/storage costs are workload-dependent; this repository does not claim a cost benchmark. Search, authenticated/private content, login, browser automation, CAPTCHA solving, and access-wall evasion are out of scope.

Use is limited to an unlisted assessment or other workload for which the operator has authorization from the data owner and the relevant platform terms permit the requested collection. Review current X terms, developer policy, privacy obligations, retention requirements, and applicable law before operating the Actor. A successful HTTP response is not permission to collect or redistribute content.
