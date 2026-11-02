# Short-let AI Receptionist

A multi-tenant SaaS foundation for a WhatsApp-first AI receptionist for short-let operators.

## Requirements
- Node.js 22 or later
- PostgreSQL 15 or later

## Run locally
1. Copy `.env.example` to `.env` and set `DATABASE_URL` to your local PostgreSQL database. The example credentials are placeholders.
2. Install dependencies: `npm install`
3. Generate Prisma client: `npm run db:generate`
4. Create the local database and apply the committed migrations: `npm run db:deploy`. Use `npm run db:migrate` only when developing new schema changes.
5. Start the API: `npm run dev`
6. Visit `http://127.0.0.1:3000/api/health`

`npm run build` compiles TypeScript; `npm start` runs `dist/src/server.js`. PostgreSQL connects through Prisma when a database operation is needed. Shutdown disconnects the client cleanly.

On macOS, if installing Argon2 from source fails because Homebrew's GNU `libtool` shadows Apple's tool, install with `env PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin npm ci`. This selects the Apple build tools for that command only.

## Phase 1 API

All routes are under `/api`. Send JSON bodies with `Content-Type: application/json`. Unknown body/query fields are rejected. Authentication responses must not be cached.

| Method / path | Access | Purpose |
| --- | --- | --- |
| `GET /health` | Public | Application liveness; independent of the database |
| `GET /ready` | Public | `200` when PostgreSQL and required Phase 1–6B schema are reachable; otherwise `503` |
| `POST /auth/register` | Public, rate limited | Create a tenant and its OWNER atomically |
| `POST /auth/login` | Public, rate limited | Authenticate an active operator |
| `GET /auth/me` | Any authenticated role | Current operator and tenant ID |
| `POST /auth/logout` | Any authenticated role | Revoke the current session |
| `GET /tenant` | Any authenticated role | Current tenant's basic settings |
| `PATCH /tenant` | OWNER | Rename the current tenant with `{ "name": "New name" }` |
| `GET /team` | OWNER, MANAGER | First 100 team members in the current tenant |
| `GET /team/:userId` | OWNER, MANAGER | Read one team member in the current tenant |
| `POST /team` | OWNER | Create a MANAGER or RECEPTIONIST |
| `PATCH /team/:userId` | OWNER | Change a non-owner's `role` and/or `isActive` |
| `GET /audit-logs?limit=50` | OWNER, MANAGER | Recent tenant-scoped security events; maximum 100 |

Register using `{ "tenantName": "Lagos Lets", "name": "Operator", "email": "operator@example.com", "password": "a-long-unique-password" }`. Passwords must contain 12–128 characters and are hashed with [Argon2id](https://github.com/ranisalt/node-argon2) (64 MiB memory, three passes, a random salt). Passwords are never returned or written to audit records.

Login uses `{ "email": "operator@example.com", "password": "a-long-unique-password" }`. Email is trimmed and lowercased. Each email belongs to one operator and one tenant globally; operators in several tenants would require a future membership model. Registration always creates a new tenant and OWNER: it cannot join a client-specified tenant. Existing owners add staff through `POST /team` with `{ "name": "Staff", "email": "staff@example.com", "password": "another-long-password", "role": "RECEPTIONIST" }`. Secure invitations are a later step; do not share or reuse the example passwords.

Registration and login return `accessToken`, `tokenType`, `expiresAt`, and safe `user` fields. Send the token as `Authorization: Bearer <accessToken>` on protected requests. Tokens contain 256 random bits; PostgreSQL stores only their SHA-256 digests. `SESSION_TTL_HOURS` controls absolute expiry (default eight hours, maximum 24). Logout deletes the current session. Every request checks expiration, current role, and account activity against PostgreSQL. Deactivation also deletes all the user's sessions; reactivation requires a new login. There is no token in a URL or cookie and no refresh-token endpoint. A future browser client should keep bearer tokens in memory and use HTTPS.

Permissions use the server-side role matrix. Client role/tenant IDs never grant access. The tenant repository and booking service filter business queries by the tenant from the authenticated session. Foreign resource IDs return the same `404` as missing IDs. Composite foreign keys also prevent a child row from referring to a parent in a different tenant. Business routes must use these scoped services. Only OWNER and MANAGER can change properties, pricing or operator blocks. All three roles can handle routine booking requests, holds, extensions and eligible cancellations. Authenticated conversation simulations are implemented in Phase 5; Phase 6B adds inbound-only WhatsApp pilot recording. Guest replies remain future work.

Registration/login share `AUTH_RATE_LIMIT_MAX` requests per IP per minute, including invalid attempts. The general API limit is 120 requests per IP per minute. Health probes are excluded. Proxy forwarding headers are not trusted; deployment behind a proxy needs an explicitly configured trusted proxy list. Limits are currently in process memory and require a shared store before running several API instances.

## Phase 2: properties, pricing and availability

These routes inherit the existing session authentication. OWNER and MANAGER can manage properties, prices and blocks; RECEPTIONIST can use all GET routes. Mutations check permissions again inside the tenant repository. Property configuration changes, date overrides and block changes are committed with their audit records (actor, action, timestamp and relevant before/after values). Authorized audit readers can see those changes through `/audit-logs`.

| Method / path (under `/api`) | Purpose |
| --- | --- |
| `POST /properties` | Create a property; `201 { property }` |
| `GET /properties?status=active&limit=50&offset=0` | List current tenant's properties; status is `active`, `inactive` or `all` |
| `GET /properties/:propertyId` | Read one property, including configured fees and policies |
| `PATCH /properties/:propertyId` | Update supplied configuration fields; use `null` to clear nullable fields |
| `DELETE /properties/:propertyId` | Soft-deactivate; records, blocks and audit history remain. `PATCH { "isActive": true }` reactivates |
| `GET /properties/:propertyId/availability?checkIn=2026-11-10&checkOut=2026-11-12` | Read calendar availability, minimum-stay result and nightly rates |
| `GET /properties/:propertyId/blocks` | List operator-created blocks |
| `POST /properties/:propertyId/blocks` | Add an operator block; `201 { block }` |
| `DELETE /properties/:propertyId/blocks/:blockId` | Remove an operator block; `204` |
| `GET /properties/:propertyId/price-overrides` | List date-specific overrides |
| `POST /properties/:propertyId/price-overrides` | Add an override; `201 { priceOverride }` |
| `DELETE /properties/:propertyId/price-overrides/:ruleId` | Remove an override; `204`. Replace an override by removing it and creating its replacement |

List routes accept `limit` (1–100, default 50) and `offset` (default 0). Block/override lists optionally accept **both** `startDate` and `endDate` to return ranges that overlap that window. All lookups check both tenant and property, including child deletions. Only operator-source blocks can be removed through these endpoints. Availability checks all block sources. New blocks on inactive properties return `409 PROPERTY_INACTIVE`; removing their existing operator blocks is allowed.

Example property body:

```json
{
  "name": "Lekki apartment",
  "area": "Lekki Phase 1",
  "address": "Your property address",
  "description": "Two-bedroom apartment",
  "bedrooms": 2,
  "bathrooms": 2,
  "maxGuests": 4,
  "amenities": ["Wi-Fi", "Air conditioning"],
  "baseNightlyPriceKobo": 5000000,
  "weekendNightlyPriceKobo": 6000000,
  "cleaningFeeKobo": 500000,
  "otherFees": [{ "label": "Parking per stay", "amountKobo": 100000 }],
  "minimumStayNights": 2,
  "standardCheckIn": "14:00",
  "standardCheckOut": "11:00",
  "earlyCheckInAllowed": true,
  "earlyCheckInFrom": "09:00",
  "earlyCheckInFeeKobo": 1000000,
  "earlyCheckInRules": "Subject to operator approval",
  "lateCheckOutAllowed": true,
  "lateCheckOutUntil": "17:00",
  "lateCheckOutFeeKobo": 1500000,
  "lateCheckOutRules": "Subject to availability",
  "cancellationPolicy": "Your cancellation terms",
  "refundPolicy": "Your refund terms",
  "isActive": true
}
```

Required creation fields are `name`, `area`, `bedrooms`, `bathrooms`, `maxGuests` and `baseNightlyPriceKobo`. Status uses the existing `isActive` boolean. Weekday pricing uses the existing `baseNightlyPriceKobo` field. Weekend means **Friday and Saturday nights**; a null weekend rate falls back to the base rate. Date-specific overrides take precedence over these base/weekend rates. Existing legacy `PriceRule` priorities and weekday conditions are honored when reading nightly rates; the new override API creates priority-zero date-only rules and does not edit legacy recurring rules.

Money is an integer JSON number in **kobo**, stored as PostgreSQL `BIGINT`, with an upper bound of 100,000,000,000 kobo per amount. Nightly prices must be positive; fees can be zero. Currency is NGN and cannot be supplied by clients. `otherFees` is a replacement array of at most 20 uniquely named fees; supplying `[]` clears it. Amenities allow at most 50 unique names. Bedrooms/bathrooms allow 0–100; guest capacity is 1–1000. Minimum stay is 1–366 nights. Times are local `HH:mm`; an early arrival time must precede standard check-in, and a late departure time must follow standard check-out. Updates validate supplied fields and merged clock rules, preserving unrelated legacy text even when it exceeds current creation limits. Rules and policy text are stored configuration; this phase does not automatically approve early arrivals, charge fees, apply cancellation terms or issue refunds.

Block body: `{ "startDate": "2026-11-10", "endDate": "2026-11-12", "reason": "Maintenance" }`.
Override body: `{ "startDate": "2026-11-10", "endDate": "2026-11-12", "label": "Event rate", "nightlyPriceKobo": 7000000 }`.

Calendar requests accept real `YYYY-MM-DD` dates from 2000 through 2199, with positive ranges of at most 366 nights. They interpret dates in **Africa/Lagos** and persist their midnight boundaries as UTC instants (for example, `2026-11-10` starts at `2026-11-09T23:00:00Z`). All intervals are **[start, end)**: a block from the 10th to the 12th occupies the 10th and 11th, allowing check-in on the 12th. Standard check-in/out times remain separate local configuration. Block responses also include UTC `startAt`/`endAt`; existing legacy timed blocks are preserved and their actual windows continue to block availability.

Invalid inputs return `400 INVALID_REQUEST`; missing sessions return `401 UNAUTHORIZED`; permission failures return `403 FORBIDDEN`; missing/foreign records return `404 NOT_FOUND`. Overlapping blocks return `409 BLOCK_OVERLAP`; overlapping date-only price overrides return `409 PRICE_OVERRIDE_OVERLAP`. Adjacent intervals are allowed. PostgreSQL [range exclusion constraints](https://www.postgresql.org/docs/15/rangetypes.html#RANGETYPES-CONSTRAINT) enforce this even for simultaneous database writes. Transactions also lock the tenant-owned property row before calendar/configuration mutations, and a failed audit write rolls back its associated change.

Operator-block creation also checks existing occupying bookings/active holds using the same date and state policy as availability. Overlap returns `409 BOOKING_OVERLAP` with no block or audit mutation. It does not change or cancel the booking. Booking timestamps can span beyond public request-date limits; normalizing stored endpoints must not turn a valid availability request into an input error.

Availability returns `available`, `calendarAvailable`, `minimumStayMet`, `minimumStayNights`, `isActive`, `nights`, `timezone`, the requested dates and `nightlyPrices`. A property is available only if active, minimum stay is met and its calendar is clear. The read accounts for operator/existing external blocks, existing `CONFIRMED`, `PAYMENT_REVIEW`, `VERIFICATION_PENDING` bookings and unexpired `HELD` rows. Expired holds and non-occupying states do not block. Booking timestamps are interpreted as their Lagos calendar dates; guest details and booking IDs are not returned. Nightly rates exclude fees. Reading availability creates no reservation or hold and provides no guarantee of later availability. Hold creation rechecks the calendar under a property lock. A malformed HELD row without expiry now fails closed with `409 OCCUPANCY_REVIEW_REQUIRED` and an integrity audit alert.

## Phase 3: booking requests and holds

These operator APIs require a Bearer session. OWNER, MANAGER and RECEPTIONIST have routine booking access; property/pricing/block permissions are unchanged. The server derives the tenant, prices, state, expiry, currency and reference. Unknown fields, including client-supplied tenant, price, state and payment claims, are rejected.

| Method / path (under `/api`) | Contract |
| --- | --- |
| `POST /bookings` | Create a non-occupying REQUESTED inquiry with a protected quote; `201 { booking }` |
| `POST /holds` | Create an occupying HELD record for 60 minutes; `201 { booking }` |
| `GET /bookings?propertyId=...&status=HELD&limit=50&offset=0` | Tenant-scoped operational summaries; filters optional, no guest phones or full snapshots |
| `GET /bookings/:bookingId` | Full tenant-scoped booking, guest contact, terms and current expiry information |
| `POST /bookings/:bookingId/extend` | Empty body or `{}`; add exactly 15 minutes once to an unexpired hold |
| `POST /bookings/:bookingId/cancel` | `{ "reason": "Guest changed plans" }`; cancel an eligible REQUESTED or unexpired HELD record |

Both creation routes require `Idempotency-Key`, 8–128 characters from letters, digits, `.`, `_`, `:`, `-`, and this JSON body:

```json
{
  "propertyId": "the-property-cuid",
  "checkIn": "2027-01-10",
  "checkOut": "2027-01-12",
  "guestName": "Guest name",
  "guestPhone": "+2348012345678",
  "guestCount": 2
}
```

Property IDs use the actual ID returned by property creation. Guest names are trimmed, 1–120 characters; guest counts are integers within the property's capacity. Nigerian local 11-digit phones starting with `0` normalize to `+234...`; international phones require `+` followed by 8–15 digits. Spaces, parentheses and hyphens are removed. No phone-ownership verification is claimed. Dates follow the same Lagos, half-open and 366-night rules as the calendar. Minimum stay, activity, capacity and pricing are checked inside the transaction.

One active hold per normalized phone is allowed **across the authenticated tenant**, including different properties. The same phone may hold independently with another tenant. An expiry equal to the current timestamp is expired. Expired HELD rows stop occupying dates and stop counting against the phone limit immediately; no scheduled job is needed. Reads expose persisted `status` and derived `effectiveStatus`; filters use persisted status. Internal `expireHold` transitions only timestamp-expired HELD rows to EXPIRED with an audit record. There is no public expiry job endpoint. Cancellation releases occupancy atomically; expired holds must be expired rather than cancelled. Legacy records without an original quote/start time cannot be extended, and records with payment metadata require review before cancellation.

Quotes contain each occupied night's rate/source, all relevant pricing rules and their priorities, cleaning and every explicitly configured per-stay fee, totals, property pricing/configuration and policies at creation. Friday/Saturday are weekend nights; null weekend pricing uses the base rate. Arithmetic uses BigInt kobo; JSON amounts are converted only after exact safe-integer checks. Early/late arrival options and cancellation/refund policies are snapshotted configuration and are not automatically approved, charged or executed. A database trigger protects quote terms, guest/stay details and totals from later edits. Configuration changes do not reprice existing records. Legacy records retain their original totals and return `legacyQuote: true` with `quoteSnapshot: null`; very large legacy totals serialize as decimal strings to avoid precision loss.

Idempotency keys are unique per **tenant and creation operation**. Equivalent normalized inputs return the original creation response, including after cancellation/expiry; use GET to read current state. Changing input with the same key returns `409 IDEMPOTENCY_CONFLICT`. Concurrent duplicates serialize on a PostgreSQL transaction lock and create only one booking, audit event and replay record. Keys/responses are retained; no deletion/retention job is implemented yet. They contain guest data and require the same access/retention controls as bookings.

Phase 3 transitions are creation into REQUESTED/HELD, one HELD extension, REQUESTED/HELD → CANCELLED under the rules above, and expired HELD → EXPIRED internally. A request does not reserve dates; create a fresh hold with its own quote when ready. In-place REQUESTED → HELD conversion is not exposed. Phase 4 adds controlled verified confirmation and unpaid-review resolution below; no API accepts arbitrary states or guest payment claims. Only an actual CONFIRMED record returns `confirmed: true`. CONFIRMED/PAYMENT_REVIEW/VERIFICATION_PENDING occupy dates. PAID_CONFLICT records exceptions without occupying dates; refund states retain their existing non-occupying semantics. Confirmed cancellation and refund workflows remain unimplemented.

## Phase 4: payment foundation and test-mode verification

Payment attempts are separate from booking states. Amounts remain exact integer kobo, using PostgreSQL BigInt and safe JSON integer bounds; no currency conversion, rounding or percentage calculation is performed. Initiation uses the hold's immutable quote, including its nightly rates and configured fees. Bank instructions are snapshotted so changing bank settings does not redirect an already-created transfer. Payment creation requires a live HELD booking with an existing quote; REQUESTED, expired, inactive-property and unknown legacy quotes cannot start checkout.

All operator routes below require a Bearer session. The server derives tenant and actor from that session. OWNER/MANAGER configure bank details, verify and record review decisions. RECEPTIONIST may initiate and read payments for their own tenant, including the transfer instructions needed to assist a guest; they cannot change bank settings or verify money. There is no public guest payment-management API.

| Method / path (under `/api`) | Purpose |
| --- | --- |
| `GET /payment-settings/bank-transfer` | OWNER/MANAGER bank configuration, or `null` before setup |
| `PUT /payment-settings/bank-transfer` | `{ "enabled": true, "bankName": "Your bank", "accountName": "Your business", "accountNumber": "0123456789" }`; exactly ten account digits |
| `POST /payments` | Idempotency-Key required; manual `{ "bookingId": "...", "method": "MANUAL_TRANSFER" }`, or test checkout `{ "bookingId": "...", "method": "PAYSTACK_TEST", "email": "guest@example.com" }` |
| `GET /payments?bookingId=...&status=REVIEW&review=true&limit=50&offset=0` | Tenant summaries; filters optional; `review=true` also finds successful payments needing attention; omits bank instructions and checkout URLs |
| `GET /payments/:paymentId` | Current payment, instructions/checkout URL and whether it actually confirmed the booking |
| `POST /payments/:paymentId/verify-manual` | OWNER/MANAGER controlled bank-ledger attestation, described below |
| `POST /payments/:paymentId/verify` | OWNER/MANAGER server-side provider verification/retry; no payment status supplied by client |
| `POST /payments/:paymentId/review` | OWNER/MANAGER `{ "note": "..." }`, or the restricted unpaid resolution below |
| `POST /webhooks/paystack` | Public transport endpoint authenticated by the test-secret HMAC signature; no operator session |

Manual verification body: `{ "confirmedAmountKobo": 1000000, "receiptReference": "bank-transaction-reference", "receiptConfirmed": true, "note": "Checked receipt in the bank ledger" }`. An authorized human must actually check their bank ledger. A screenshot, chat claim or uploaded evidence is never processed as proof. The unique tenant receipt reference prevents a bank transaction from being applied to two attempts. Exact receipt records the verifier and timestamps, then attempts confirmation; repeated successful verification returns `409 PAYMENT_ALREADY_VERIFIED`. Wrong amounts return `409 AMOUNT_MISMATCH` **and commit** the actual amount and review audit without confirmation. After checking the ledger again, a permitted operator may correct a mistaken amount for that same bank reference with an explanatory note; earlier mismatch amounts remain in audit history. Once recorded, changing the receipt reference returns `409 RECEIPT_REFERENCE_IMMUTABLE`, so the original bank transaction stays claimed even during review. Multiple-transfer aggregation and replacement of a mistaken bank reference require separate manual reconciliation; this API does not implement them. Do not enter confidential bank data or unnecessary guest details in notes.

Review notes never force success. Online results can be reverified with `/verify`; manual receipts can be corrected through the controlled action. `POST /review` also accepts `{ "decision": "CLOSE_UNPAID", "noFundsConfirmed": true, "note": "Checked; no transfer received" }`. This closes an unreceived manual attempt, or an online attempt independently verified as failed/abandoned. It cancels eligible HELD/review bookings only when **all** their attempts are closed and none records money. Any receipt, successful payment, uncertain online result or other pending attempt rejects this decision and rolls everything back. A successful payment with an expired hold, duplicate payment or unavailable property remains reviewable; there is no force-confirm, refund or paid-cancellation endpoint.

### Test-mode setup and provider behavior

`PAYSTACK_TEST_ENABLED=false` is the default. Manual transfer works independently. To use Paystack locally, supply your own **test** secret through `PAYSTACK_TEST_SECRET_KEY=sk_test_...` and set `PAYSTACK_TEST_ENABLED=true`, then restart. Empty/missing credentials while enabled and every `sk_live_` value fail configuration without printing the secret. No dependencies were added. This is one platform test merchant account; tenant routing is metadata/database ownership, with no tenant merchant onboarding, split settlement or live charging.

The adapter uses the official [transaction initialize/verify API](https://paystack.com/docs/api/transaction/) on a fixed HTTPS origin, a five-second timeout and no redirects. It sends the exact kobo amount, unique `SLP-<32 hex>` reference, and server-generated tenant/booking/payment association. Only Paystack's HTTPS checkout origin is returned. Provider transaction IDs are strings to preserve large unsigned IDs; unsafe numeric IDs or amounts fail verification. Full provider responses, card/authorization data and customer details are never persisted or logged.

The webhook parser preserves raw bytes and checks [Paystack's HMAC-SHA512 signature](https://paystack.com/docs/payments/webhooks/) before JSON processing. Signed reference/event/transaction identifiers are persisted in the existing internal webhook ledger before verification; unknown references and unsupported event types are acknowledged without payment success. Successful notifications trigger an independent server GET: final `success`, test domain, amount, currency, reference, all association IDs, receipt timestamp and event transaction ID must match. Browser redirects and webhook amount fields cannot confirm bookings.

Duplicate events share one durable ledger record. Concurrent notifications/rechecks serialize effects and confirmation audit under property/payment locks; a provider-transaction advisory lock and unique index prevent cross-attempt reuse. Unavailable/pending verification records review, keeps review occupancy and returns webhook `503` for provider redelivery. Retrying an already-processed event returns `200` without applying it again. Mismatched or unsupported final results return `200` after recording review/ignored status; operator re-verification is explicit. There is no background queue or scheduled reconciliation: monitor RECEIVED/RETRY events and review payments, and use the authenticated verification route if provider redelivery is exhausted. Provider retries and actual sandbox-account connectivity have not been exercised by the fake-provider tests.

Initialization persists the stable attempt/reference before HTTP and does not hold database locks during network calls. A timeout can mean Paystack received the request, so it records `INITIALIZATION_UNCERTAIN` and never blindly creates another checkout on idempotent replay. An interruption between persistence and initialization/URL storage can leave INITIALIZING; check/reverify the same reference through the review process. Reusing a key with changed normalized input returns `409 IDEMPOTENCY_CONFLICT`; replay returns the same attempt's **current** state and never starts a second provider request.

### Atomic confirmation and remaining boundaries

Provider verification first moves a live hold to VERIFICATION_PENDING under the existing phone/property locks. Network failure, pending responses and delayed retries never expire or cancel that review occupancy. Ordinary HELD records still expire by their timestamp; a notification arriving after expiry records funds as PAID_CONFLICT/review and cannot reclaim occupied dates. Manual mismatches enter PAYMENT_REVIEW. These review states continue blocking until a permitted resolution; they do not mean confirmed.

The central booking service re-locks phone → tenant property → payment, rechecks current state, original expiry, active property/capacity/rules, quote amount/currency and all occupancy, then atomically writes verified proof, CONFIRMED, payment application and audits. Two paid attempts can produce only one applied payment; extra money remains SUCCEEDED with DUPLICATE_PAYMENT review. Paid late/conflicting attempts record receipts without overwriting another booking/block. Savepoints preserve verified receipts when an occupancy guard rejects confirmation; an audit/database failure rolls back receipt and confirmation together, leaving the durable webhook event retryable.

The new migration adds matching-tenant booking/verifier foreign keys; unique internal/provider references, provider transaction IDs, idempotency keys and manual receipt references; monetary/proof checks; and a partial unique applied-payment index. `payment_terms_immutable` / `protect_payment_terms()` protect agreed amounts, associations and successful receipt proof. `payment_confirmation_guard` / `guard_payment_confirmation()` require a matching verified receipt and unexpired eligible original state for a snapshot-backed transition to CONFIRMED. Both functions pin their search path like the existing five functions. Historical records and all Phase 1–3 SQL safeguards remain intact; no historical payment is fabricated. Database checks enforce proof shape and occupancy, while trusted services authenticate the actual bank/provider result and enforce permissions, lifecycle and audit. Privileged SQL is not an alternative payment API.

Phase 4 verification on 2026-10-25: client generation, TypeScript build, all 31 unit tests, all 108 integration tests (no skips), Prisma validation, six-migration deployment/status and an empty representable-schema diff passed using a disposable local cluster. An actual `migrate dev --name payment_guard_probe --skip-generate` against temporary schema/history copies and separate disposable development/shadow databases preserved the complete SQL function, constraint, enabled-trigger and index catalog. The probe column/migration exists only in that temporary copy. A final four-way unsupported-webhook regression then reproduced duplicate ledger insert errors; event insertion now uses atomic `ON CONFLICT DO NOTHING`, and ignored-event processing locks/rechecks its ledger row. The affected payment integration suite was rerun after that fix: all 23 tests passed. Earlier fixture key-length/status assertions were corrected to match existing APIs; no existing test was deleted or weakened. No real Paystack test credential or external request was used.

For the Phase 4 migration, back up valuable data and apply `npm run db:deploy` only through your normal reviewed workflow; this implementation ran migrations exclusively on disposable PostgreSQL. `20261025000300_payment_foundation` runs in one transaction. Failure testing injects a late DDL error and verifies all new tables/types/functions roll back with historical records/guards unchanged. After diagnosing and fixing a genuinely failed deployment and confirming rollback, use `npx prisma migrate resolve --rolled-back 20261025000300_payment_foundation`, then retry deployment and regenerate the client. Never resolve a successful migration as rolled back. Readiness now checks both new tables. The shadow-history/generated-follow-up test compares SQL functions, constraints, triggers and indexes before/after; retain those raw SQL safeguards in future migrations.

Business conflicts return `409`: `DATES_UNAVAILABLE`, `GUEST_ACTIVE_HOLD`, `PROPERTY_INACTIVE`, `MINIMUM_STAY_NOT_MET`, `GUEST_CAPACITY_EXCEEDED`, `PRICING_INVALID`, `HOLD_EXPIRED`, `HOLD_ALREADY_EXTENDED`, `INVALID_BOOKING_STATE`, `HOLD_NOT_EXTENDABLE`, `HOLD_NOT_EXPIRED`, `LEGACY_BOOKING_REVIEW_REQUIRED`, `BOOKING_REVIEW_REQUIRED` or `OCCUPANCY_REVIEW_REQUIRED` as applicable. Deadlock/serialization conflicts recognized by Prisma return `WRITE_CONFLICT_RETRY`; retry creation with the same idempotency key. Transactions have bounded waits/timeouts; other database outages/timeouts return a safe generic error and can be retried. Errors contain no guest contacts, foreign records or SQL. Successful booking mutations and audits commit together; a rejected malformed-hold operation instead records a separate integrity alert after rollback.

## Phase 5: simulated conversations

All simulation endpoints require an existing operator session. They are a staff testing interface, not a public guest API: OWNER, MANAGER and RECEPTIONIST inherit the existing `inbox:read`, `inbox:reply` and `inbox:takeover` permissions. Tenant identity comes from that session. Staff may read their tenant's inbox; there is no guest authentication/link-sharing mechanism in this phase. A conversation can use only its associated booking/payment for financial tools, including when other guests belong to the same tenant. Model output cannot select a booking, payment or tenant.

### Request flow and tools

The route validates input, records a redacted incoming message and claims a durable turn. A provider returns a small validated action plan; trusted services perform the operation and render the reply from backend results. Model-generated prose is never sent as booking/payment facts. This planning-only design keeps exact prices, consent and confirmation in code. Inquiry details reuse `Conversation`; there is no parallel lead, property, booking or payment store. Existing historical conversations/messages remain untouched and are excluded from simulations.

| Approved tool | Backend and boundary |
| --- | --- |
| `search_properties` | Tenant repository; at most 10 active properties matching area, capacity, bedrooms and amenities; search is not an availability check |
| `get_property_details` | Scoped property configuration; suspicious retrieved instructions/credentials fail closed; missing policies escalate |
| `check_availability` | Existing half-open Africa/Lagos calendar, capacity and minimum stay; dates are not reserved |
| `get_quote` | Existing booking quote calculation, every night/override/fee, integer kobo and policy snapshot; missing terms or invalid pricing escalate |
| `create_booking_hold` | Existing booking service; explicit agreement, contact details and current quote required; rechecks prices and occupancy under existing locks |
| `get_payment_instructions` | Existing manual-transfer payment service and configured bank snapshot, only for this conversation's eligible hold; inactive properties and expired holds require staff review |
| `check_payment_status` | Scoped backend records only; payment claims/screenshots cannot verify funds or confirm bookings |
| `request_human_assistance` | Durable structured escalation, context, timestamp/status and audit; switches to HUMAN handling |

No verification, confirmation, cancellation, refund, arbitrary HTTP/SQL or settings-write tool is exposed. Manual verification still requires OWNER/MANAGER through the existing payment API. The conversation tool never initializes Paystack. A backend-confirmed booking is the only state permitting affirmative confirmation language. Payment review and unverifiable claims preserve existing occupancy/payment rules and record an escalation. Fees/refund policies remain configured terms, not refund execution.

Quotes last five minutes and are not reservations. The guest must explicitly accept the current offer (`I agree`, another documented exact agreement phrase, or `acceptQuoteId`). A model cannot grant consent. The server compares a canonical hash of the entire quote except its calculation timestamp inside hold creation. Changed trip/terms invalidate consent; an expired offer is replaced and needs fresh agreement. Creation reuses the existing 60-minute hold engine and returns its current state. Repeating an agreement cannot create a second hold for that conversation.

### API and local mock walkthrough

| Method / path (under `/api`) | Request / behavior |
| --- | --- |
| `POST /simulations/conversations` | `{ "details": {} }`, `Idempotency-Key`; creates/resumes a simulation, returns `201 { conversation }` |
| `POST /simulations/conversations/:conversationId/messages` | `{ "text": "Hello", "details": {}, "acceptQuoteId": "optional current offer ID" }`, new `Idempotency-Key` per turn; returns persisted reply, action, authoritative `facts` or null, escalation flags |
| `GET /conversations?limit=50&offset=0` | Current tenant's simulations |
| `GET /conversations/:conversationId` | Saved inquiry, handling mode, attention flag and associated IDs; contact-presence flags only |
| `GET /conversations/:conversationId/messages?limit=50&before=<messageId>` | Persisted chronological page; same-conversation cursor, `nextBefore`, pending `activeTurn` key/lease |
| `GET /conversations/:conversationId/escalations` | Latest 100 structured escalation records in this conversation |
| `PATCH /conversations/:conversationId/handling` | `{ "mode": "HUMAN" }` takes over; `{ "mode": "AI" }` resumes after processing completes and resolves open escalations with actor/time |

Keep `AI_PROVIDER=mock`, run migrations/client generation and `npm run dev`, then register/login through Phase 1. Send the bearer token on every request above. The mock is deterministic code, **not a real AI model**; responses include `simulated: true` and `modelProvider: "mock"`. For repeatable testing use structured `details`, for example:

```json
{
  "text": "Please find an apartment",
  "details": { "area": "Lekki", "checkIn": "2027-02-05", "checkOut": "2027-02-08", "guestCount": 2 }
}
```

Create a conversation first, send the requirements, choose an option by number if needed, ask for property details/availability and a quote, then explicitly agree. Supply `guestName` and `guestPhone` in `details` when asked; these are required by the existing hold engine. Ask for payment instructions/status afterward. Configure real property rates, cancellation/refund policy text and permitted bank details through the existing OWNER/MANAGER routes before this walkthrough. Simulation **writes real records to the selected database**: messages, holds, manual payment attempts and audits. Use a disposable local database and synthetic contacts. It never moves funds or notifies a guest.

Unknown request fields and unsupported model/tool arguments are rejected. Text is limited to 2,000 characters and the existing 16 KiB body limit applies. Message submissions have a 30-per-IP-per-minute limit; other routes inherit the existing general limit. These limits remain per process, not shared across replicas or tenant-aware cost budgets.

Creation keys are tenant scoped; turn keys are tenant/conversation scoped. Identical completed turn retries return the stored original response; changed input returns `409 IDEMPOTENCY_CONFLICT`. A replay is historical: use a new status turn or GET for current state. Only one turn processes per conversation. `409 TURN_IN_PROGRESS` means retry the same request after its lease; `TURN_RECOVERY_REQUIRED` means recover the pending key/body shown by the history endpoint before sending a new turn. A two-minute lease fences stale workers. Clients must retain the original key and body for recovery.

Model network calls run outside database transactions and have a bounded timeout. Hold/payment creation, its audit and its conversation link commit together in the existing core transaction. Reply/escalation/message/turn completion commit in a subsequent transaction. If reply persistence fails after a hold commits, the durable link and stable core idempotency key allow recovery without another hold. Staff takeover is checked again inside any core mutation, and a stale worker cannot overwrite a completed turn or make a new mutation. A mutation already committed before takeover remains valid and visible to staff. No background recovery worker is implemented.

### Provider configuration and privacy

`.env.example` defines `AI_PROVIDER=mock|openai|disabled` (default mock), `AI_MODEL`, `OPENAI_API_KEY` and `AI_TIMEOUT_MS` (50–15,000 ms, default 5,000). Disabled/unavailable providers save the inquiry and escalate safely. OpenAI requires both a securely supplied key and an explicitly selected Responses/Structured Outputs-compatible model. Add credentials only to your ignored local environment or secret manager; do not paste them in chat or commit them. No new npm dependency or model SDK was added.

The optional OpenAI adapter follows the official [Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create) and [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses) format: fixed HTTPS origin, no redirects, strict JSON schema, bounded output, abort signal and `store: false`. It receives the current redacted text, validated inquiry requirements, contact/quote/hold presence flags and Lagos date. It receives no raw conversation history, stored contact fields, bank instructions, property descriptions, booking/payment IDs or application credentials. Provider failure, quota error, refusal, malformed output and timeout record human escalation; there is no automatic second provider or fabricated answer. A single failure escalates immediately rather than repeatedly charging/retrying.

Contact values needed for a hold stay in the existing tenant-scoped conversation/booking fields. History/request text redacts recognizable contacts, credentials and financial identifiers before storage/model use; audit/context records contain structured requirements and IDs rather than raw guest messages. Text redaction and suspicious-content detection are defense in depth, not a complete DLP guarantee. Staff-entered free text can contain personal data; review data retention, consent, provider processing terms and redaction quality before enabling an external model. `store: false` is not a claim of zero provider retention.

Escalations preserve a reason, relevant inquiry/record IDs, time, status and authenticated actor audit. They set HUMAN/needsAttention and say **no notification has been sent**. Staff must poll/read the inbox and take over/resume manually. There is no notification service, staff reply delivery, conversation cleanup job or autonomous booking recovery. Mock natural-language extraction is deliberately limited to ISO dates, simple area/guest/bedroom statements and contact patterns; structured details are more reliable. Broader language quality and the live OpenAI adapter have not been externally validated. No WhatsApp, frontend, real guest transport, live payment, refunds or Phase 6 work is included.

### Phase 5 migration and verification

Apply the additive `20261026000100_conversation_engine` migration using `npm run db:deploy`, then `npm run db:generate` against your reviewed local environment. It preserves all six historical migrations, historical channel/mode/message rows and all seven occupancy/payment SQL functions. New records reuse Conversation/Message; new ConversationTurn and ConversationEscalation tables store retry state and human handover. Readiness now requires conversation storage; liveness stays independent of PostgreSQL/provider availability.

The new migration runs inside BEGIN/COMMIT. Composite foreign keys scope turns, messages, escalation actors and booking/payment links to their tenant/conversation. A unique booking link prevents two conversations owning the same booking. `Conversation_simulation_values_check`, `ConversationTurn_values_check`, `ConversationEscalation_values_check` and `Message_turn_direction_check` validate new-record shape/state; `ConversationTurn_one_processing` and `ConversationEscalation_one_open_reason` are partial unique indexes. `conversation_links_guard` / `guard_conversation_links()` protect conversation identity, immutable established links and payment-to-booking matching. Its pinned search path and SECURITY INVOKER behavior match existing guards. SQL does not authenticate actors or prove consent; scoped services enforce those rules and audit semantics.

Tests inject a late migration failure, verify all new DDL rolls back without changing historical data/guards, mark only the genuinely failed migration rolled back and retry. Do not run failure/recovery testing against useful data. If a real deployment fails, diagnose its cause, confirm transaction rollback and back up/review the data before using `npx prisma migrate resolve --rolled-back 20261026000100_conversation_engine` and retrying. Never resolve a successful migration as rolled back. Preserve raw SQL checks/triggers/partial indexes in future migrations; Prisma schema diff alone cannot validate them. Use a maintenance window for schema locks and review generated SQL rather than replacing history with `db push`.

Phase 5 file inventory (no package/dependency or historical migration changes):

| Files | Purpose |
| --- | --- |
| `src/services/conversation-model.ts` | Provider interface, labelled deterministic mock, optional strict OpenAI planner |
| `src/services/conversation-validation.ts` | Requests, allowed actions/tools, consent, limited extraction and text redaction |
| `src/services/conversation-tools.ts` | Scoped backend tools and authoritative safe replies |
| `src/services/conversation-service.ts` | Persistent inquiry/messages, leased turns, idempotency, takeover and audited escalation |
| `src/routes/conversations.ts` | Authenticated simulation/inbox routes and message throttling |
| `src/app.ts`, `src/config.ts`, `src/routes/operator.ts` | Model configuration/injection and existing authentication wiring |
| `src/routes/health.ts` | New storage readiness checks |
| `src/services/booking-validation.ts`, `src/services/booking-quote.ts`, `src/services/booking-service.ts` | Reused quote input/calculation, canonical terms hash and internal transaction/link hooks |
| `src/services/property-validation.ts`, `src/services/tenant-repository.ts` | Validated bounded active-property search |
| `src/services/payment-service.ts` | Internal transaction/link hook for the existing payment creation path |
| `prisma/schema.prisma`, `prisma/migrations/20261026000100_conversation_engine/migration.sql` | Additive persistence, foreign keys, SQL checks/indexes/link guard |
| `test/conversation.test.ts` | Model, wire-format, validation, consent/privacy and exact-money fixtures |
| `test/integration/phase-five.test.ts`, `test/integration/phase-five-migrations.test.ts` | Real disposable-PostgreSQL conversation/security/recovery and migration tests |
| `test/integration/migrations.test.ts` | Historical Message select explicitly uses only Phase 1 columns; original assertions preserved |
| `test/integration/phase-two-migrations.test.ts` | Readiness now requires the seventh migration |
| `test/integration/phase-three-acceptance-migrations.test.ts` | Temporary generated probe sorts after the new migration |
| `.env.example`, `README.md`, `docs/BUILD_PLAN.md` | Safe configuration examples, usage, implementation status and limitations |

Run `npm test` for model/validation fixtures and `TEST_DATABASE_URL=<disposable-local-url> npm run test:integration` for all phases. Focused conversation integration: `TEST_DATABASE_URL=<disposable-local-url> npx tsx --test --test-concurrency=1 test/integration/phase-five*.test.ts`. Provider tests intercept HTTP in memory: no real model call, Paystack call, webhook, charge or external guest message occurred in Phase 5.

Phase 5 final verification — 2026-10-27, Node 22.20.0 / PostgreSQL 15.19 / Prisma 6.19.3:

| Command | Actual result |
| --- | --- |
| `npm run build` | Exit 0, TypeScript compiled |
| `npm test` | Exit 0, 39 passed, 0 failed/skipped |
| `TEST_DATABASE_URL='postgresql://phase5_test@127.0.0.1:55443/phase5_disposable?schema=public' npm run test:integration` | Exit 0, 132 passed, 0 failed/skipped; includes all earlier phases and 20 new conversation/migration checks (including parent test) |
| `DATABASE_URL='postgresql://phase5_test@127.0.0.1:55443/phase5_verified?schema=public' npm run db:generate` | Exit 0, Prisma client generated |
| `DATABASE_URL='postgresql://phase5_test@127.0.0.1:55443/phase5_verified?schema=public' npm run db:deploy` | Exit 0, all seven committed migrations applied to a fresh disposable database |
| `DATABASE_URL='postgresql://phase5_test@127.0.0.1:55443/phase5_verified?schema=public' npx prisma validate` | Exit 0, schema valid |
| `DATABASE_URL='postgresql://phase5_test@127.0.0.1:55443/phase5_verified?schema=public' npx prisma migrate status` | Exit 0, schema up to date |
| `DATABASE_URL='postgresql://phase5_test@127.0.0.1:55443/phase5_verified?schema=public' npx prisma migrate diff --from-url 'postgresql://phase5_test@127.0.0.1:55443/phase5_verified?schema=public' --to-schema-datamodel prisma/schema.prisma --exit-code` | Exit 0, no representable differences |

A separate actual development-migration probe used temporary schema/history copies and fresh disposable development/shadow databases:

```sh
DATABASE_URL='postgresql://phase5_test@127.0.0.1:55443/phase5_dev_probe?schema=public' SHADOW_DATABASE_URL='postgresql://phase5_test@127.0.0.1:55443/phase5_shadow_probe?schema=public' npx prisma migrate deploy --schema /tmp/shortlet-phase5.ohfv7nki/migration-probe/schema.prisma
DATABASE_URL='postgresql://phase5_test@127.0.0.1:55443/phase5_dev_probe?schema=public' SHADOW_DATABASE_URL='postgresql://phase5_test@127.0.0.1:55443/phase5_shadow_probe?schema=public' npx prisma migrate dev --schema /tmp/shortlet-phase5.ohfv7nki/migration-probe/schema.prisma --name conversation_guard_probe --skip-generate
```

Both exited 0. The probe added only a nullable temporary-copy ConversationTurn column. Before/after catalog snapshots matched all function definitions/settings (including extension functions), 69 constraints, six enabled application triggers and 78 indexes. All eight application functions retain pinned search paths; the seven earlier functions are unchanged. The normal committed migration path has no probe column. Old migration and package manifest/lock SHA-256 comparisons passed.

Development checks caught quote-hash instability after JSONB key reordering, an audit/reply failure recovery gap and a nullable SQL CHECK that could permit a missing simulated creation hash. Canonical terms hashing, atomic core mutation/link audits and an explicit non-null hash check address them; regression tests cover each boundary. Inactive-property instructions were also stopped and tested. The first complete regression had 128 passes and one historical Phase 1 fixture failure: a regenerated Prisma client implicitly selected the new Message column before that fixture applied later migrations. Selecting its original asserted columns fixes the historical-schema test without deleting assertions. Earlier focused fixture failures (mock action expectation and case-sensitive PostgreSQL error matching) were corrected. Final build/unit/integration results above have no failures or skips.

All database work used a newly initialized loopback-only disposable cluster; no application/production database was used. It was stopped and its test data removed after verification. Logs, the temporary probe and file manifest are retained at `/tmp/shortlet-phase5.ohfv7nki/`. Optional OpenAI tests use intercepted HTTP fixtures; no actual model, Paystack, paid sandbox completion, external webhook, live channel, notification or deployment was tested in Phase 5. Prior Phase 4.1 external acceptance limitations remain unchanged.

### Phase 5 audit remediation — 2026-10-27

Inspection began on a clean `main` at `1ecf04bf7534831f97e70a93bf813c4d148efb58` (`first commit`). Read-only GitHub inspection confirmed the same commit on `origin/main`. This remediation does not commit/push, deploy, add dependencies or start Phase 6.

Confirmed application defects and fixes:

- A new multi-result search retained the previous selected property; a single-result search retained its old quote/acceptance. Every search now clears selection, options and offer before querying, then selects only a sole result. Multiple results require a choice from the current options. Both request fields and model selections enforce that list; property-specific tools check it again. Numbered property changes invalidate the previous offer.
- Explicit acceptance of an expired quote was allowed even though the hold tool subsequently refused to use it. Acceptance now requires matching current property/dates/count and an unexpired offer. Final hold creation also checks the offer deadline inside the existing core transaction, after lock waits; expiry rolls back the hold. The existing exact-terms hash, occupancy locks, quote snapshots and idempotency remain authoritative.
- Guest text redaction missed common international numbers and introductions. Incoming messages and saved turn requests now minimize Nigerian/international phone formats, emails, common token/credential prefixes, card-like numbers and recognizable name introductions. Recovery minimizes pre-remediation pending requests again, including their incoming message, before planning. Model-facing area/amenity text is also minimized. Structured contact fields remain available to authorized booking operations and are excluded from model context.
- After staff takeover won the conversation lock, a late model result could still save inquiry/options/quote changes while its reply was suppressed. Completion now discards that late AI work and only records the safe takeover acknowledgement and turn/audit bookkeeping. Existing transaction guards still prevent holds/payments after takeover or lease loss.
- A failed search completion could leave the previous accepted quote in durable state. Replanning during lease recovery could then choose a hold for the old property: a regression reproduced an incorrect hold. The service now durably saves the validated action plan under its lease/takeover fence before tool execution and reuses it on recovery. A failed search repeats its search, not a new model-selected action. This uses the existing turn JSON; no schema change is required.

Regressions assert API replies and actual PostgreSQL state for reselection, single/multiple options, obsolete acceptance, forced stale holds, new quotes/consent, expiry across a mutation boundary, international contact privacy with successful backend booking, historical pending-text recovery, late takeover edits, competing lease owners, booking/payment audit rollback, exact replay counts and failed-search recovery. Existing payment suites still cover exact amounts/currency/references/transaction identity/associations, reused provider IDs, signatures, duplicate deliveries, uncertain verification and late funds. A valid duplicate webhook reuses its previously verified result without another confirmation; reused funds or ambiguous outcomes cannot confirm another booking.

Redaction remains heuristic. Unintroduced names, unusual formatting, obfuscation, other languages and some free-text personal information can be missed or misclassified. ISO dates, guest/bedroom counts and known booking/payment-reference formats have preservation tests; this is not a complete DLP guarantee. No mass rewrite of completed historical messages or useful databases was performed. Review existing retention, stored free-text/contact data and provider consent before external model use.

Files changed:

| File | Reason |
| --- | --- |
| `src/services/conversation-tools.ts` | Reset search state, enforce current selection and check offer expiry at mutation commit boundary |
| `src/services/conversation-service.ts` | Bind acceptance to the current offer, minimize recovery/model context, persist validated plans and discard late AI changes after takeover |
| `src/services/conversation-validation.ts` | Broader bounded contact/credential redaction and conservative contact extraction while preserving booking literals |
| `test/conversation.test.ts` | Representative phone/name/token/card redaction and ordinary-message/date/reference preservation |
| `test/integration/phase-five.test.ts` | Search/consent/privacy/recovery/takeover/lease/audit regressions against real disposable PostgreSQL |
| `README.md`, `docs/BUILD_PLAN.md` | Findings, verification, limitations and explicit pre-production gates |
| `.env` (ignored, local only) | Set `AI_PROVIDER=mock` and `PAYSTACK_TEST_ENABLED=false`; credential values are neither documented nor committed |

No Prisma schema, historical migration, booking/payment lifecycle service, role rule, package manifest or lockfile was changed. Fresh migration deployment, upgrade/failure/recovery suites and a separate actual `migrate dev` probe exercise the existing seven-migration history. Before/after probe snapshots preserved all function definitions/settings, 69 constraints, six enabled application triggers and 78 indexes. The probe column/history exists only in temporary copies/disposable databases. `db push` is not a replacement for this SQL history.

Dependency checks are **not clean**: both `npm audit --json` and `npm audit --omit=dev --json` returned exit 1 with three high entries (`prisma`, `@prisma/config`, `deepmerge-ts`) associated with one underlying recursive-merge stack-exhaustion advisory. The installed chain is Prisma 6.19.3 / @prisma/config 6.19.3 / deepmerge-ts 7.1.5. The [maintainer advisory](https://github.com/RebeccaStevens/deepmerge-ts/security/advisories/GHSA-ggr8-5vv4-36mx) describes recursive object graphs, rather than plain JSON, as the triggering input. A reachable application-route exploit was not established by this audit. npm proposes a major Prisma upgrade; no unreviewed major update/override was applied. Treat dependency remediation and deployment reachability review as an outstanding production gate.

No live AI request, payment-provider API request, real payment, external guest message, notification, deployment or production database mutation occurred. Registry auditing, official security-advisory reading and read-only GitHub inspection were the external checks. Real OpenAI model acceptance, paid Paystack checkout and external webhook delivery remain unverified. Tenant quotas, overages, monthly limits and model-pricing decisions were not implemented; their budget/product design requires a separate deliberate step. Staff notifications, public guest/channel identity, shared abuse controls and retained-data review remain pre-production work.

Final remediation verification (2026-10-27): build exit 0; **40 unit tests passed**; the final full integration run exited 0 with **143 tests passed, zero failures/cancellations/skips**. It includes 29 Phase 5 conversation checks (including the parent test), the two Phase 5 migration checks and every existing earlier-phase suite. The final source also passed `git diff --check`.

Exact principal verification commands (output redirected to the audit logs; all database URLs below were disposable loopback-only databases):

```sh
AI_PROVIDER=mock PAYSTACK_TEST_ENABLED=false npm run build
AI_PROVIDER=mock PAYSTACK_TEST_ENABLED=false npm test
AI_PROVIDER=mock PAYSTACK_TEST_ENABLED=false TEST_DATABASE_URL='postgresql://phase5_audit@127.0.0.1:55447/phase5_audit_test?schema=public' npm run test:integration
DATABASE_URL='postgresql://phase5_audit@127.0.0.1:55447/phase5_audit_verified?schema=public' npm run db:generate
DATABASE_URL='postgresql://phase5_audit@127.0.0.1:55447/phase5_audit_verified?schema=public' npm run db:deploy
DATABASE_URL='postgresql://phase5_audit@127.0.0.1:55447/phase5_audit_verified?schema=public' npx prisma validate
DATABASE_URL='postgresql://phase5_audit@127.0.0.1:55447/phase5_audit_verified?schema=public' npx prisma migrate status
DATABASE_URL='postgresql://phase5_audit@127.0.0.1:55447/phase5_audit_verified?schema=public' npx prisma migrate diff --from-url 'postgresql://phase5_audit@127.0.0.1:55447/phase5_audit_verified?schema=public' --to-schema-datamodel prisma/schema.prisma --exit-code
npm audit --json
AI_PROVIDER=mock PAYSTACK_TEST_ENABLED=false npm audit --omit=dev --json
npm ls prisma @prisma/config deepmerge-ts --all
```

Generation/deployment/validation/status/diff all exited 0: client generated, seven migrations applied, schema valid/up to date, and no representable differences. `npm ls` exited 0. Both audit commands exited 1 with the three high entries described above; security auditing is not reported as passing.

The separate migration probe exited 0 with these commands against a temporary schema/history copy:

```sh
DATABASE_URL='postgresql://phase5_audit@127.0.0.1:55447/phase5_audit_probe?schema=public' SHADOW_DATABASE_URL='postgresql://phase5_audit@127.0.0.1:55447/phase5_audit_shadow?schema=public' npx prisma migrate deploy --schema /tmp/shortlet-phase5-audit.dht4p207/migration-probe/schema.prisma
DATABASE_URL='postgresql://phase5_audit@127.0.0.1:55447/phase5_audit_probe?schema=public' SHADOW_DATABASE_URL='postgresql://phase5_audit@127.0.0.1:55447/phase5_audit_shadow?schema=public' npx prisma migrate dev --schema /tmp/shortlet-phase5-audit.dht4p207/migration-probe/schema.prisma --name phase5_remediation_guard_probe --skip-generate
```

Catalog comparisons verified unchanged function definitions/settings, constraints, enabled triggers and indexes after the generated nullable probe column. All seven historical migrations, Prisma schema and package files match their initial SHA-256 hashes. The existing populated-upgrade and injected-failure/resolve/retry tests passed in the full suite. No new migration or dependency installation is required for these application fixes.

Failure evidence is retained, not counted as success: the initial new focused integration regressions reported 19 passes/7 failures (six failed subtests plus their parent), and focused unit tests reported 8 passes/1 failure. An intermediate privacy test incorrectly expected a model call after a credential was detected; it now separately checks contact minimization and the intended credential escalation. A later failed-search recovery regression reported 27 passes/2 failures (one failed subtest plus parent) and actually created one incorrect old-property hold in its disposable fixture. Saving/replaying the validated plan fixed it. An intermediate full run passed 142 tests before that additional regression; the final full rerun passed 143. The first test-cluster initialization failed on the host's locale setting; retrying `LC_ALL=C initdb -D /tmp/shortlet-phase5-audit.dht4p207/data -A trust -U phase5_audit --encoding=UTF8 --locale=C` succeeded. No tests were skipped or omitted because of this setup issue.

Audit artifacts are retained at `/tmp/shortlet-phase5-audit.dht4p207/`, including pre-fix failures, final results, dependency JSON, catalog snapshots and file manifest. The disposable PostgreSQL cluster was stopped and its data removed after verification; these example URLs are not running services. The existing `.gitignore` excludes `docs/` and `.env`: the build-plan update is local unless explicitly included in a later documentation commit, and credentials must remain ignored. Remediation changes remain uncommitted for review. Production readiness is not declared, and Phase 6 was not started.

## Tests

### Phase 4.1 acceptance audit — 2026-10-26

The complete suite was rerun after the final Phase 4 webhook fix: 31 unit tests and 108 integration tests passed. The audit then reproduced one additional defect: correcting a mismatched manual receipt could replace its bank reference, releasing the original reference from the unique index so it could be claimed again. The service now rejects a changed reference with `409 RECEIPT_REFERENCE_IMMUTABLE` once recorded. A mistaken amount can still be corrected for the same bank transaction. The regression failed before the fix, and the focused payment suites passed all 27 tests afterward. The final complete rerun passed **31 unit tests and 112 integration tests**, with no skips. No existing Phase 1–3 file, Prisma schema, historical migration or dependency was changed.

New regressions also inject an actual manual-confirmation audit failure and verify that receipt proof, booking confirmation and audits roll back together, then retry successfully. Screenshot URLs, guest claims, missing receipt attestation and unauthorized actors cannot establish receipt proof. Existing API/database tests cover bank settings/instructions, pending and incorrect amounts, duplicate verification, roles/tenant isolation, immutable quotes, duplicate/concurrent signed events, mismatched amount/currency/reference/association, unavailable verification, late payment, occupied dates, property deactivation and safe review resolution. Those provider-event scenarios use local fixtures, not externally delivered Paystack events.

Real Paystack test-mode checks used the owner's supplied test secret through the existing adapter and synthetic data in a separate disposable database. `POST /transaction/initialize` returned HTTP 200; the application returned HTTP 201 with PENDING, 100000 kobo/NGN and a real hosted checkout URL. Checkout navigation returned **HTTP 403 / Cloudflare challenge**. Safari WebDriver could not create a session because Allow Remote Automation is disabled; no setting was changed. The owner also reported checkout unavailable. No test card was submitted and no successful payment was performed.

Real `GET /transaction/verify/:reference` returned HTTP 200 with `domain=test`, `status=abandoned`, the exact amount/currency/reference and all three server-generated metadata associations. The application returned HTTP 200 with payment FAILED, booking PAYMENT_REVIEW and `bookingConfirmed=false`. A deliberately nonexistent reference returned HTTP 400; the actual adapter exposed only `PROVIDER_UNAVAILABLE`. No secret, provider authorization/card payload or real guest data was logged.

The owner confirmed there is no existing public callback. **External Paystack webhook delivery/signature verification, external retries/delays/duplicates and a successful paid-to-confirmed sandbox checkout remain unverified.** Local HMAC, replay, mismatch and failure tests passed, but do not establish external delivery. There was no deployment, tunnel, merchant webhook-setting change, live charge, refund, new dependency or Phase 5 work. Current official [transaction](https://paystack.com/docs/api/transaction/), [webhook](https://paystack.com/docs/payments/webhooks/) and [test-payment](https://paystack.com/docs/payments/test-payments/) documentation was inspected again for this audit.

Both supplied keys were stored only in ignored local `.env` with permissions `0600`; test mode is enabled there. The backend uses `PAYSTACK_TEST_SECRET_KEY`; `PAYSTACK_TEST_PUBLIC_KEY` is retained for owner reference and has no backend/frontend implementation. The shared example contains only blank placeholders and keeps test mode disabled. The local `.env` was created from the example because it did not exist: configure its application `DATABASE_URL` yourself before running the API. The audit never connected to that example database URL.

Exact principal verification commands (all database URLs below refer exclusively to the newly created disposable cluster):

```sh
npm run build
npm test
TEST_DATABASE_URL=postgresql://phase41_test@127.0.0.1:55439/phase41_disposable npm run test:integration
TEST_DATABASE_URL=postgresql://phase41_test@127.0.0.1:55439/phase41_disposable npx tsx --test test/integration/phase-four-one.test.ts
TEST_DATABASE_URL=postgresql://phase41_test@127.0.0.1:55439/phase41_disposable npx tsx --test test/integration/phase-four-one.test.ts test/integration/phase-four.test.ts
DATABASE_URL=postgresql://phase41_test@127.0.0.1:55439/phase41_external npm run db:deploy
DATABASE_URL=postgresql://phase41_test@127.0.0.1:55439/phase41_external npx prisma validate
DATABASE_URL=postgresql://phase41_test@127.0.0.1:55439/phase41_external npx prisma migrate status
DATABASE_URL=postgresql://phase41_test@127.0.0.1:55439/phase41_external npx prisma migrate diff --from-url postgresql://phase41_test@127.0.0.1:55439/phase41_external --to-schema-datamodel prisma/schema.prisma --exit-code
node --input-type=module < /tmp/shortlet-phase41.rmk2dr3_/sandbox-init.mjs
node --input-type=module < /tmp/shortlet-phase41.rmk2dr3_/sandbox-verify.mjs
DATABASE_URL=postgresql://phase41_test@127.0.0.1:55439/phase41_dev_probe SHADOW_DATABASE_URL=postgresql://phase41_test@127.0.0.1:55439/phase41_dev_shadow npx prisma migrate deploy --schema /tmp/shortlet-phase41.rmk2dr3_/dev-probe/prisma/schema.prisma
DATABASE_URL=postgresql://phase41_test@127.0.0.1:55439/phase41_dev_probe SHADOW_DATABASE_URL=postgresql://phase41_test@127.0.0.1:55439/phase41_dev_shadow npx prisma migrate dev --schema /tmp/shortlet-phase41.rmk2dr3_/dev-probe/prisma/schema.prisma --name phase41_guard_probe --skip-generate
```

Build/validation passed, six migrations deployed, status was up to date and schema diff exited 0 with no differences. Existing migration failure/recovery and generated-follow-up safeguard tests passed in the full run. The separate actual migration-dev probe added only a temporary nullable Payment column. Catalog snapshots verified identical function definitions/search paths, constraints, enabled triggers and indexes afterward. No migration is required for this service fix, and all six committed migrations remain byte-for-byte unchanged. Audit artifacts are in `/tmp/shortlet-phase41.rmk2dr3_`; disposable database data and session tokens are removed after verification.

Receipt-reference retention during pre-success review is enforced by the scoped service; the unique index prevents simultaneous current claims, and the existing SQL trigger protects successful proof. Privileged raw SQL is still not a payment workflow. References already overwritten before this fix cannot be reconstructed automatically from the old audit payloads; reconcile any such historical cases manually. Multiple-transfer aggregation, uncertain initialization recovery, operational reconciliation/queues, paid cancellation/refunds and real external sandbox acceptance remain outside this audit.

`npm test` runs the existing helper tests plus password, property/pricing/calendar validation, role permissions, configuration, provider-adapter/signature fixtures and database-outage tests. It needs no database server or provider account.

Create a separate local test database, set `TEST_DATABASE_URL` in `.env`, then run `npm run test:integration`. The database user needs permission to create/drop schemas and install `btree_gist` in `public`, or a local database administrator must install that extension first. Integration tests apply all migrations in randomly named schemas, exercise the API against real PostgreSQL, and drop those schemas afterward. They fail clearly if `TEST_DATABASE_URL` is missing; they never silently skip the database tests or use `DATABASE_URL` as a fallback. An interrupted run may leave a `phase1_test_*` or `phase2_test_*` schema in the disposable database. The database-wide extension remains installed there.

Coverage includes cross-tenant reads and updates in both directions, role escalation attempts, current-role enforcement, session expiry/revocation/deactivation, password and token storage, registration rollback, input validation, IP throttling, database readiness, and database rejection of cross-tenant child relationships. Migration tests also check preservation/backfill of existing messages and atomic rejection of duplicate emails or inconsistent tenant relationships.

Phase 2 adds property CRUD/deactivation, pricing/fee persistence, Lagos/leap-year boundaries, adjacent/overlapping blocks and price overrides, simultaneous API/raw database writers, nested child ownership, repository-level permissions, existing booking/hold states, audit rollback, and populated-database upgrade tests. The earlier Phase 1 assertions remain; two block fixtures now use positive ranges to comply with the new integrity constraint.

The Phase 2 audit adds regression tests for legacy deactivation/partial updates, bookings spanning request-date limits, blocks against occupied bookings/holds, every existing occupancy state, exact expiry and 366-night boundaries, odd integer kobo amounts, consecutive bookings, read-only availability, real exclusion errors returned through HTTP, multi-operation audit rollback, and failed `migrate deploy` recovery. The three defect regressions were reproduced failing before their fixes. No schema or historical migration was changed by the audit.

Phase 3 adds deterministic full quotes, immutable terms, tenant-scoped CRUD workflow/permissions, concurrent hold/hold and hold/block writers, raw SQL cross-table guards, tenant-wide normalized guest-phone limits, concurrent idempotency replay/conflicts, exact expiry, one extension, malformed-hold alerts, confirmation safeguards, real database conflict responses and audit rollback. Populated Phase 2 upgrade tests cover legacy preservation, malformed/conflicting data rejection and failed-migration recovery. Earlier test assertions are preserved; one Phase 1 booking fixture now uses positive stay dates, readiness requires Phase 3, and the prior tests demonstrating missing database protections now assert the new guards reject those writes.

Phase 4 adds bank setting/payment isolation and roles, manual exact/mismatched/duplicate receipts, immutable payment terms, server-derived pricing, signed raw webhooks, server verification of all associations/amounts/currency, pending/unavailable results, concurrent event/receipt/provider-ID reuse, late funds against occupied dates, property changes during verification, unpaid review safeguards, audit-fault rollback and event retries. Migration tests preserve historical rows and SQL guards, inject atomic failure/recovery, and replay a generated follow-up migration. Two existing migration tests only gain the new readiness requirement and a later temporary-probe timestamp; all their prior integrity assertions remain.

Verification commands: `npm run build`, `npm test`, `npm run test:integration`, `npx prisma validate`, `npx prisma migrate status`, and `npx prisma migrate diff --from-url "$TEST_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code`. Supply the disposable URL explicitly for migration checks; do not run destructive checks on an application database. Prisma diff compares representable schema only; integration tests verify SQL triggers, checks, exclusions and failure atomicity separately.

## Occupancy integrity boundary

`AvailabilityBlock_no_overlap` protects block/block overlaps for the same tenant/property and every source. `PriceRule_dates_no_overlap` protects finite date-only overrides. Phase 3 adds `Booking_durable_no_overlap` for CONFIRMED, PAYMENT_REVIEW and VERIFICATION_PENDING rows, using normalized Lagos days and half-open ranges. Each exclusion is table-local; none independently compares bookings against blocks. Expiring holds cannot use a time-dependent partial exclusion predicate.

Application writers share a tenant-owned property `FOR UPDATE` lock. Creation first locks the idempotency key, then the normalized guest phone for holds, then the property. Hold mutations lock phone then property before rereading the booking. Blocks lock the property. READ COMMITTED transactions check current activity/configuration, current expiry, blocks and all occupying/review states before writing. PostgreSQL triggers independently use the same property/phone locks and recheck both tables, including direct INSERT/UPDATE writers. Trigger writes require READ COMMITTED so checks use fresh statement snapshots after waiting; unsupported isolation is rejected. SQL checks enforce positive Lagos date ranges, integer amounts, expiry for HELD and the one-extension limit. New snapshot-backed holds have exactly 60/75-minute expiry. Raw concurrent write tests cover the shared guards as well as API race tests.

Privileged database writers must not disable triggers/constraints, and API code must continue using scoped services. The triggers enforce occupancy rather than full pricing, authorization, audit or payment verification. Bulk privileged writes can still encounter deadlocks and must retry the whole transaction. Future confirmation, hold promotion, OTA imports or date changes must follow this protocol, preserve agreed terms, verify their source, recheck timestamp/state/version and atomically commit occupancy with audit/idempotency. A prior availability GET never grants a reservation or confirmation right. No live-load or deployed contention testing has been performed.

Potential risks remain distinct from confirmed bugs: a future unscoped query could bypass API tenant filtering because RLS is not enabled, and operational lock contention/privilege configurations have not been assessed on any deployed system. No cross-tenant API disclosure was reproduced in the audited paths. Base pricing is required/positive by schema and constraints; null weekend pricing is the documented fallback, and inactive properties return `available: false`. Availability rate responses exclude fees and reserve nothing; stored quotes itemize explicitly configured fees. Phase 4 uses those quotes for controlled payment verification, while refund/paid-cancellation behavior remains unimplemented.

## Phase 3 acceptance audit

Three defects were reproduced before their fixes: legacy phone whitespace bypassed the tenant-wide active-hold limit because SQL and API normalization differed; malformed holds found through another property's guest-phone check produced an alert against the requested property rather than the corrupt record's property; and schema-qualified SQL could redirect occupancy-trigger lookups through a caller's search path and bypass a block. The follow-up migration `20261025000200_booking_acceptance_guards` aligns SQL normalization with JavaScript boundary trimming and pins all five booking functions to `pg_catalog`, the protected schema, then `pg_temp`. Functions remain SECURITY INVOKER. The service carries the malformed record's actual property into the separate integrity alert. No routes, permissions or dependencies were added.

The actual integrity layers are:

| SQL object | What it protects |
| --- | --- |
| `Booking_values_check` | Positive Lagos stay dates, guest count, nonnegative integer total, NGN currency, extension count 0/1 and an expiry for HELD. New snapshot-backed records additionally require valid guest details, positive safely serializable totals, midnight boundaries, at most 366 nights and exact 60/75-minute holds |
| `Booking_durable_no_overlap` | Same-tenant/property half-open overlaps among CONFIRMED, PAYMENT_REVIEW and VERIFICATION_PENDING rows; does not cover expiring holds or other tables |
| `AvailabilityBlock_dates_check`, `AvailabilityBlock_no_overlap` | Positive timestamp intervals and block/block exclusion for every source |
| `PriceRule_values_check`, `PriceRule_dates_no_overlap` | Price/weekday/date bounds and exclusion among finite date-only overrides; recurring/open-ended legacy rules use application priority rules |
| `Property_capacity_check`, `Property_money_check`, `Property_times_check`, `PropertyFee_amount_check`, `PropertyFee_label_case_key` | Valid property configuration, bounded money, local clocks and case-insensitive unique fee labels |
| `Booking_reference_key`, `Booking_tenantId_id_key` | Unique references and composite booking identity |
| `BookingOperation_tenantId_operation_key_key` | At most one stored creation response per tenant/operation/key; input equivalence and replay behavior are enforced in the service |
| `Booking_tenantId_propertyId_fkey`, `BookingOperation_tenantId_bookingId_fkey`, `AuditLog_tenantId_actorId_fkey` | Same-tenant property, replay-record parent and authenticated audit-actor relationships; these are relationship checks rather than authorization |
| `booking_occupancy_guard` → `guard_booking_occupancy()` | READ COMMITTED active writes; phone/property locks; active-property, malformed-hold, guest-phone, booking and block checks |
| `block_occupancy_guard` → `guard_block_occupancy()` | Property lock, fixed block ownership, READ COMMITTED writes, malformed holds and booking occupancy |
| `booking_terms_immutable` → `protect_booking_terms()` | Immutable identity and snapshot-backed terms; one exact unexpired 15-minute extension; rejection of early HELD → EXPIRED updates |

The database does **not** enforce the complete state-transition graph, financial verification, quote arithmetic, audit creation or idempotency input hashes for arbitrary privileged SQL. API cancellation/expiry lock the property and reject confirmed/review records; raw updates to non-occupying states and raw deletions do not follow that entire application protocol. Keep administrative SQL privileged and all application mutations in the scoped services. Legacy rows without snapshots remain explicitly unknown; their terms are not silently reconstructed. Readiness and Prisma schema diff do not prove that every trigger/CHECK is still installed.

Acceptance tests compare actual function definitions/settings, enabled triggers, constraints and indexes before/after Prisma shadow replay and an appended generated nullable-column migration in temporary schema copies. This checks the current workflow, not every possible future destructive DDL change. Review generated SQL before applying it, preserve the committed history and rerun catalog/concurrency checks when changing protected tables. Do not replace migrations with `db push` or regenerate the database from the Prisma model alone. Moving/renaming a protected schema also requires reviewing function search-path settings. Unmeasured load/lock contention, application/database clock skew, replay-record/guest-data retention, monitoring and deployment privileges remain operational follow-up work.

Local acceptance verification on 2026-10-25: `npm run build` passed; `npm test` passed 27 tests; `npm run test:integration` passed 83 tests with no skips. Date/pricing tests passed 12 tests each under UTC and America/Los_Angeles. Prisma validation, deployment of all five migrations, migration status and representable-schema diff passed. A separate actual `prisma migrate dev --name acceptance_dev_probe --skip-generate` run against a temporary schema copy and disposable development/shadow databases created/applied a test-only nullable column; function definitions/settings, constraints, enabled triggers and indexes were identical before/after. No product schema field was added. The new regressions reproduced four failing assertions across the three confirmed defects before fixes; the earlier baseline integration suite passed 73 tests. All database checks used a newly initialized disposable local PostgreSQL cluster.

## Existing database caution

The first migration records the original starter schema; the second adds Phase 1; `20261024000300_properties_availability` adds Phase 2; `20261025000100_booking_engine` adds Phase 3; `20261025000200_booking_acceptance_guards` fixes acceptance defects; `20261025000300_payment_foundation` adds Phase 4; `20261026000100_conversation_engine` adds Phase 5. Apply pending committed migrations with `npm run db:deploy`, then regenerate with `npm run db:generate`. If you previously created tables with `prisma db push`, back up your local database and review/baseline the initial migration first; do not reset a database containing useful data.

The second migration lowercases existing email addresses and requires global email uniqueness. It also backfills each message's tenant from its conversation. Duplicate normalized emails or existing cross-tenant parent links intentionally stop the migration and must be resolved manually. It does not silently merge accounts or reassign business records.

Phase 2 needs the PostgreSQL `btree_gist` extension in `public`. The migration installs it if permitted; otherwise ask your **local database administrator** to run `CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;` in the application and test databases before migration. No new npm dependencies or environment variables are needed. The migration runs atomically, adds fields/fees and SQL constraints, preserves existing block timestamps, and enables early/late flags when corresponding legacy fees exist. Legacy bathrooms default to 0, amenities/fees to empty, cleaning fee to zero, and weekend price to null (base-rate fallback); review these values for each real property. Invalid legacy dimensions/prices/times, empty or overlapping blocks, and overlapping date-only overrides stop migration for manual resolution. SQL CHECK/exclusion constraints and the functional fee-label index are maintained in the migration because Prisma 6 cannot fully express them; preserve them in future schema changes. Readiness now requires Phase 2 property columns and the fee table.

If `migrate deploy` records this third migration as failed, first fix the reported local data/extension issue and confirm its transaction rolled back. Then run `npx prisma migrate resolve --rolled-back 20261024000300_properties_availability` and retry `npm run db:deploy`. This command only updates migration history; use it for the failed migration, never an already successful upgrade. Keep a backup before repairing existing data.

Prisma 6 can report only `current transaction is aborted` while recording a failed SQL transaction, masking the originating CHECK error. Inspect local PostgreSQL logs and migration history to identify the original failure before repairing data. Audit tests verify that this failure leaves prior data/schema intact and that the documented resolve-and-retry procedure succeeds after fixing the disposable fixture.

The Phase 3 migration locks the relevant tables and runs atomically. It preserves historical booking amounts, dates, states and phone text; adds `LEGACY-<id>` references without inventing snapshots; and rejects malformed dates/amounts/currency/capacity, HELD rows without expiry, active booking overlaps, duplicate active tenant-wide normalized guest holds, and booking/block conflicts. Expired holds do not cause overlap failures. Review and resolve ambiguous legacy data manually before applying it; the migration never cancels or deletes reservations. Allow a maintenance window for table locks and new indexes. On failure confirm rollback, repair the cause from a backup/reviewed records, run `npx prisma migrate resolve --rolled-back 20261025000100_booking_engine` only for that failed migration, then retry `npm run db:deploy`. Tests exercise populated upgrades, rejection without partial schema/data changes, and resolve/retry recovery exclusively in disposable databases. SQL functions, checks, exclusions and triggers must survive future migrations; Prisma cannot represent all of them. Readiness requires the new booking columns and replay table. No new dependencies or environment variables are required.

The acceptance follow-up also takes transactional table locks. It changes function normalization/search paths and preserves all booking, replay, quote and audit data. If the corrected normalization reveals duplicate active holds for a phone in one tenant, it stops and rolls back both function bodies and settings. Review those holds manually; expired duplicates are allowed. Only after resolving the cause and confirming rollback, use `npx prisma migrate resolve --rolled-back 20261025000200_booking_acceptance_guards` for a failed deployment and retry `npm run db:deploy`. Use a maintenance window for migration locks. No Prisma-model, environment-variable or dependency changes are needed for this fix.

## Important
This phase is a local development foundation. Before production: configure HTTPS and a database account with limited privileges, add email verification, password reset/change, secure staff invitations, MFA as appropriate, shared/account-aware abuse controls, expired-session cleanup, and an operational security review. Duplicate registration returns a generic `409 ACCOUNT_UNAVAILABLE`; this still permits email-existence inference. PostgreSQL row-level security is not enabled: API isolation relies on the scoped repository and server permission checks, with composite foreign keys protecting relationships. Raw administrative Prisma/SQL access is privileged and must never be exposed to clients. Webhook events with no resolved tenant remain internal and have no API route. Future migrations/privileged database operations require the same care.

See `docs/BUILD_PLAN.md` for remaining phases. Requests, quotes, holds, controlled verification/confirmation, manual transfers, Paystack test-mode code and authenticated conversation simulations with a mock/optional planning adapter are implemented locally. Paid sandbox checkout, external webhook delivery, live model operation, live charging/settlement, refunds, paid cancellation, automated reconciliation, WhatsApp, frontend and deployment remain unverified or unimplemented as described above. Operational security work listed above still applies.

Dependency audit: the resolved Prisma 6 tooling chain currently reports three high-severity findings associated with [GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx) in `deepmerge-ts` (also flagged through `@prisma/config` and `prisma`). The advisory requires recursive JavaScript objects; plain JSON alone cannot trigger that condition. This API does not pass requests into Prisma's configuration merger. A supported fix for this dependency chain requires a reviewed Prisma major upgrade; `npm audit fix --force` was not applied. Reassess this before production and after dependency updates.

## Phase 6A — tenant usage and AI cost ledger

Phase 6A keeps the planner mock-only. `AI_PROVIDER=mock` remains the default; selecting the retained optional `openai` adapter cannot invoke it through conversations in this phase. No WhatsApp transport, guest ingress route, subscription charge, paid overage, or live AI acceptance is implemented. Booking/payment authority and Phase 5 lease, takeover, consent and saved-plan recovery remain in their existing services.

The additive `20261028000100_usage_ledger` migration creates `UsagePolicy`, `UsageGlobalPolicy`, `UsageEvent`, `UsageWindow`, `UsageInbound`, and `UsageAlert`. Apply it through the normal reviewed `npm run db:deploy` workflow and regenerate the client with `npm run db:generate`. The implementation and all migration experiments use disposable PostgreSQL only. Liveness is independent of the database; readiness now checks all six usage tables as well as the previous schema.

### Accounting and concurrency

Costs are integer **micro-USD** (one USD = 1,000,000 units), represented by PostgreSQL BIGINT/JavaScript bigint and decimal strings over JSON. No floating currency arithmetic or conversion to booking/payment NGN amounts occurs. Every event snapshots the provider/model, pricing version, per-token rates, token upper bounds, maximum reserved amount, billing month, correlation ID, idempotency digest and lifecycle timestamps. The ledger stores no raw messages, prompt bodies, phone numbers, keys or payment secrets.

Simulation pricing `UNVERIFIED-TEST-USD-v1` uses **fictional** rates of 2 micro-USD per input token and 5 per output token. This table is versioned test data, not an actual provider rate or charge. Multiplication uses integers with no rounding. Fixture counts must fit reserved bounds; excess counts cannot silently release budget. The full serialized minimized context is bounded using UTF-8 byte length as a conservative input-token bound. Output has a configured limit and the mock's returned plan is also size-checked. Real provider tokenization, verified pricing, output limits and external acceptance remain gated future work.

Accounting/configuration writes acquire one transaction-scoped PostgreSQL advisory lock per mode, then any required conversation lock, in READ COMMITTED transactions. This deliberately serializes short budget transactions across instances. The model executes **outside** the lock. Each reservation sums `accountedMicroUsd` for the tenant and globally in the current period, checks both caps, then writes the reservation and audit atomically. Pending and unknown calls count at the full reserved maximum; completed calls count at reconciled fixture cost. Cap reductions affect subsequent reservations and never erase existing commitments. The global policy is never exposed through tenant APIs.

`UsageEvent` has a tenant/mode/key uniqueness constraint, tenant/conversation/turn composite foreign keys, amount/state checks and an immutable-terms/terminal-state trigger. The same normalized reservation input replays its record; changed input conflicts. Dispatch is a separate audited one-time transition; expired reservations and prior-month reservations cannot dispatch. Completed conversation turns and stored Phase 5 plans replay without another model call. A recovered turn without a saved plan may use another separately reserved attempt only within both the call and retry limits; previous uncertain attempts remain fully accounted. Zero retries means at most one attempt.

A known zero-usage mock failure releases the reservation. A timeout, unreported usage, failed settlement, or abandoned dispatched call retains its full amount (`RESERVED` or `REVIEW`). Recovery releases only provably undispatched expired work. Late trusted fixture results can reconcile a review once; conflicting terminal results are rejected. Ledger/audit failure before dispatch prevents the call; failure after dispatch cannot undo possible consumption and does not permit unrecorded tool execution. A database outage may return a safe 500 when even fallback persistence is unavailable. Never interpret missing ledger completion as zero spend.

The global advisory lock, cap summation, authorization, honest outcome classification and audit insertion are application transaction invariants. SQL constraints independently protect links, unique accounting identities, monetary/state consistency, immutable snapshots and terminal events. Privileged raw SQL is not a supported accounting API and can bypass cap/allowance policy; production access must preserve this service boundary. The global lock is intentionally conservative and requires contention/load testing before scaling.

### Provisional conversation allowance

Calendar billing periods are half-open months in **Africa/Lagos**, including the UTC+01:00 month boundary. There is no finalized subscription pricing. STARTER/GROWTH/PRO supply provisional allowances of **300/1,000/3,000**; OWNER/MANAGER can explicitly set another allowance with an audited policy change.

`UsageService.recordInbound` is a trusted server-only accounting boundary, not a webhook integration. Its production path requires an existing tenant-owned, non-simulated WHATSAPP conversation whose normalized phone matches. No public production ingress route calls it yet. Windows use a tenant/channel/normalized-phone digest and a rolling 24-hour inactivity deadline. A new eligible inbound event starts a window only when the allowance permits; each subsequent eligible inbound extends the window. Exactly-at-expiry starts a new window. Concurrent starts serialize, and a PostgreSQL exclusion constraint prevents overlapping windows for the same identity.

Duplicate delivery IDs replay the original receipt without counting or extending inactivity, even after renewal. Denied receipts also remain denied on replay; a subsequent new eligible message can start after renewal/authorized plan change. Staff/AI replies, property changes, multiple booking opportunities and takeover do not call this accounting boundary. The same guest in another tenant is a distinct identity. An existing window may continue when the new-conversation allowance is exhausted or reduced, subject to financial/request limits. Allowance belongs to the window's start month; AI usage belongs to the dispatch month. Runtime clocks must be synchronized; timestamp injection exists for deterministic tests.

Ordinary `/simulations/conversations` messages **never create production billable windows**. They still reserve and account simulated AI usage. The dedicated inbound fixture endpoint exercises counting in the separate SIMULATION namespace; it does not deliver a WhatsApp message. Production AI calls remain disabled even if caps are configured.

### Configuration and staff API

All paths are under `/api`; authentication derives the tenant. All usage inspection and financial configuration routes require OWNER or MANAGER, checked again by the service. Guests, receptionists and model tools cannot change budgets. Unknown fields, including client tenant IDs, are rejected.

| Method/path | Purpose |
| --- | --- |
| `GET /usage?mode=SIMULATION` | Current tenant/month policy, accounted micro-USD and conversation count |
| `GET /usage/events?mode=SIMULATION&limit=50` | Current tenant's ledger, at most 100 records |
| `GET /usage/events/:eventId` | Tenant-scoped event; foreign/missing IDs both return 404 |
| `GET /usage/alerts?mode=SIMULATION&limit=50` | Durable staff-visible warnings/review/blocking events |
| `PUT /usage/policy/:mode` | Audited tenant financial/request configuration; SIMULATION or PRODUCTION |
| `POST /usage/simulations` | Deterministic completion/failure/unknown usage fixture; requires Idempotency-Key |
| `POST /usage/simulations/inbound` | SIMULATION-only eligible-inbound counting fixture |
| `POST /usage/simulations/:eventId/reconcile` | Reconcile a simulated uncertain event using fixture counts |
| `POST /usage/recover` | Recover at most 100 expired reservations per mode for this tenant |

Example policy body (all monetary figures below are **non-production test fixtures**, not recommendations):

```json
{"plan":"STARTER","conversationAllowance":300,"monthlyCapMicroUsd":"10000000","minimumReservationMicroUsd":"1000","maxRequestMicroUsd":"100000","maxInputBytes":16384,"maxOutputTokens":1500,"maxCallsPerTurn":2,"maxRetries":1}
```

`conversationAllowance` may be omitted to use the provisional plan allowance. Configuration bounds reject negative/fractional monetary values, unsafe integer ranges, inconsistent reservation limits and retry counts at or above the call count. A zero monthly cap or zero allowance intentionally blocks the corresponding new work. Warnings at 70%, 85% and 100%, cap denials and unknown outcomes create deduplicated `UsageAlert` plus audit entries. Staff must poll these endpoints; no email, WhatsApp or other automatic notification is sent. Cap/allowance fallback cannot confirm a booking or verify payment.

Outside production only, missing SIMULATION policy is initialized to the example policy; its global fixture cap is 100000000 micro-USD, optionally set with `USAGE_SIMULATION_GLOBAL_CAP_MICRO_USD`. Production does not initialize these development defaults. `USAGE_PRODUCTION_GLOBAL_CAP_MICRO_USD` has no default and can provision an initially absent production global policy. Existing global policy rows are authoritative and never overwritten by instance startup/environment changes; later platform-level global changes require an explicit reviewed database operation using the same accounting lock. No tenant route can set a global cap. Missing production policy fails closed, and no production provider pricing is invented.

Usage fixture body: `{"inputTokens":100,"outputTokens":50,"outcome":"complete"}`; outcomes also include `known_failure` and `unknown`. Optional `conversationId` must belong to the authenticated tenant. Inbound fixture body: `{"phone":"+2348090000000","eventId":"synthetic-inbound-001"}`. Reconciliation body: `{"inputTokens":100,"outputTokens":50}`. Use synthetic contacts and disposable data. The phone is normalized and hashed before storing a counting identity; hashes are pseudonymous, not a guarantee of anonymization.

The previously reviewed `deepmerge-ts` **8.0.2** override and lockfile are preserved. No new dependency is required for Phase 6A. Operational follow-ups include retention, monitoring, scheduled reservation recovery, real-provider pricing/acceptance, distributed ingress authentication and load testing. No real AI, WhatsApp, live payment, frontend or deployment was added.

### Phase 6A verification — 2026-10-28

Final verification used Node 22.20.0, Prisma/client 6.19.3 and a newly initialized loopback-only PostgreSQL 15.19 cluster. The final build passed; **43 unit tests and 161 integration tests passed with zero failures/skips**. All original Phase 1–5 assertions remain. A further final targeted conversation/usage run passed 46 tests. No new dependencies were installed, and both npm audits report zero vulnerabilities with the existing deepmerge-ts 8.0.2 override.

All test commands ran with `AI_PROVIDER=mock` and `PAYSTACK_TEST_ENABLED=false`. `DATABASE_URL`, `TEST_DATABASE_URL` and the probe's `SHADOW_DATABASE_URL` were explicitly set to newly created disposable databases; `.env` values were not used as database targets. Exact argument lists/exit codes and persistent logs are retained at `/Users/apple/.codex/audit-artifacts/shortlet-phase6a-3npy53xk/commands.jsonl` and adjacent log files.

| Command | Actual final result |
| --- | --- |
| `npm run build` | Exit 0 |
| `npm test` | Exit 0; 43 passed |
| `npm run test:integration` | Exit 0; 161 passed |
| `npx tsx --test --test-concurrency=1 test/integration/phase-five.test.ts test/integration/phase-six-a.test.ts` | Exit 0; 46 passed |
| `npx prisma validate` | Exit 0 |
| `npx prisma generate` | Exit 0; client 6.19.3 |
| `npx prisma migrate deploy` | Exit 0; all eight migrations applied to a fresh disposable database |
| `npx prisma migrate status` | Exit 0; up to date |
| `npx prisma migrate diff --from-url "$DISPOSABLE_DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` | Exit 0; no difference |
| `npx prisma migrate deploy --schema "$PROBE_SCHEMA"` | Exit 0; temporary schema/history copy, separate disposable probe database |
| `npx prisma migrate dev --schema "$PROBE_SCHEMA" --name usage_ledger_probe --skip-generate` | Exit 0; only a nullable temporary probe column added |
| `npx prisma migrate status --schema "$PROBE_SCHEMA"` | Exit 0 |
| `npm audit --json` and `npm audit --omit=dev --json` | Both exit 0; zero vulnerabilities |
| `git diff --check` | Exit 0 |

The actual development-migration probe preserved all **197 functions** (nine application functions), function ownership/security/search-path settings, **90 constraints, seven enabled triggers and 97 indexes**. All eight pre-probe migration-history records remained identical; only the temporary probe migration was appended. The usage migration's populated-upgrade/failure/resolve/retry test separately preserves historical records and all previous function/constraint/trigger/index definitions. The seven historical migration files, existing dependency changes, booking/payment services, conversation tools and `.env` match their baseline hashes.

Development failures are retained in the logs: initial TypeScript type errors were corrected; an accidentally repeated new exclusion definition caused transactional migration rejection and was fixed before successful replay. The first full integration run had 158 passes and three reported failures (two underlying fixture assumptions plus a parent failure): the exclusion inventory expected only the old property guards, and readiness expected success before the new migration. Tests now retain all old property checks, additionally verify the usage exclusion, and require the usage migration before readiness becomes 200. The temporary appended-migration timestamp also moves after Phase 6A. No test was deleted or weakened. The complete suite was rerun successfully afterward.

Task changes are confined to the usage schema/migration/services/routes/tests, planner accounting integration, role/config/readiness wiring, three existing migration/security test fixtures, `.env.example`, README and `docs/BUILD_PLAN.md`. The package manifest and lockfile remain exactly as they were at task start. The build-plan file is locally updated but remains ignored by the existing `.gitignore`. Nothing was committed or pushed. The disposable cluster is stopped and its data removed; audit logs and probe artifacts remain outside the repository. Production readiness and real-provider pricing/transport acceptance are not claimed.

## Phase 6B: inbound WhatsApp pilot

The backend now receives signed Meta WhatsApp Cloud API webhooks and records text messages for staff review. It does **not** call a model, send replies, mark messages read, create holds or change payments. Existing simulation processing remains separate. Inbound conversations have `channel=WHATSAPP`, `simulation=false`, `handlingMode=HUMAN` and `modelProvider=disabled` in staff responses. Here `simulation=false` distinguishes external channel ingress from staff simulation turns; **all Phase 6B number mappings use SIMULATION usage accounting**, never production billing. Live customer activation remains outside this phase.

### Endpoints and setup

| Endpoint | Access / behavior |
| --- | --- |
| `GET /api/webhooks/whatsapp` | Meta subscription handshake: `hub.mode=subscribe`, matching `hub.verify_token`, numeric `hub.challenge`; returns the challenge unchanged as plain text |
| `POST /api/webhooks/whatsapp` | Meta HMAC-SHA256 signature in `X-Hub-Signature-256`; JSON body up to 131,072 bytes |
| `GET /api/whatsapp/connections?limit=50&offset=0` | OWNER/MANAGER: list only their tenant's mappings; no credentials |
| `POST /api/whatsapp/connections` | OWNER/MANAGER: create `{ "businessId": "<WABA_ID>", "phoneNumberId": "<PHONE_NUMBER_ID>", "displayName": "Pilot number", "isActive": false }`; replace placeholders with Meta's numeric IDs |
| `PATCH /api/whatsapp/connections/:connectionId` | OWNER/MANAGER: change `isActive` and/or `displayName`; tenant, channel and number identity cannot be reassigned |
| Existing `GET /api/conversations`, `/:conversationId`, `/:conversationId/messages`, `/:conversationId/escalations` | All authenticated staff roles: includes their tenant's inbound WhatsApp conversations; foreign IDs return `404` |

After reviewing/applying the migration in your **local disposable development database**, generate the client with `npx prisma generate`. Configure `META_WEBHOOK_ENABLED=true`, `META_APP_SECRET` from your test Meta app, and `META_VERIFY_TOKEN` with a random value you choose (32–512 letters, digits, underscores or hyphens). The app secret accepts 16–512 characters in that alphabet. Set the same verify token in Meta. Both secrets are required when enabling the webhook; configuration also requires `AI_PROVIDER=mock` and `PAYSTACK_TEST_ENABLED=false`. Disabled or missing runtime configuration returns `503 WHATSAPP_WEBHOOK_UNAVAILABLE`. Application liveness remains independent of the database; readiness now requires the Phase 6B table as well.

Through an authenticated OWNER/MANAGER account, register the test number's **phone number ID** and **WhatsApp Business Account ID**, not its displayed phone number. Mappings default to inactive. Independently verify the operator's ownership before activating a pilot mapping with `PATCH { "isActive": true }`. This administrative API does not prove Meta ownership, implement Embedded Signup or discover numbers. Several numbers may share a business ID and tenant. A number already assigned to any tenant, even inactive, cannot be claimed again; there is no deletion/reassignment API.

Configure the existing Phase 6A SIMULATION usage policy through `PUT /api/usage/policy/SIMULATION` before testing. No additional quotas, pricing or budgets are introduced. Without a policy or when the conversation allowance is exhausted, the incoming message remains available for staff review with a BLOCKED usage receipt and the existing usage alert. It does not create a new usage window or model call. Existing development defaults remain available through the existing usage service, but webhook ingestion does not silently provision them.

When you later supply a reachable HTTPS callback, use `https://<your-test-host>/api/webhooks/whatsapp` for the Meta app's WhatsApp webhooks and subscribe to `messages`. No Graph access token or API version is required merely to receive signed events. No callback, tunnel, Meta account setting or deployment was created during implementation. External handshake/delivery is **unverified**. Meta's [official archived SDK webhook reference](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/) describes the challenge and signature handshake; current [messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages) and [echo](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/smb_message_echoes) pages returned HTTP 429 during review. Automated fixtures verify the implemented contract, not current external delivery.

### Validation, privacy and transaction behavior

The route's encapsulated Fastify buffer parser preserves exactly the original signed bytes. HMAC comparison is constant-time, and signature validation occurs before JSON parsing or trusting payload fields. Verification tokens are compared through equal-length SHA-256 digests. Request logging omits query strings, headers and bodies so Meta's verification token cannot enter access logs. Existing Paystack parsing and authenticated JSON routes remain separate.

The payload must identify `whatsapp_business_account`. Each text message needs a bounded Meta message ID, numeric international sender identity, valid Unix timestamp and nonempty text of at most **2,000 JavaScript string units** (the existing conversation privacy limit). There are at most 100 normalized events per request. UTC timestamps before 2000 or more than five minutes ahead of receipt are rejected. Delayed events are accepted; usage windows use server processing time, not guest-supplied timestamps. Clock synchronization remains operationally necessary. Earlier processing times cannot move an existing window's deadline backwards.

Tenant identity comes from the uniquely registered `metadata.phone_number_id`; the envelope business ID must match that mapping. Payload tenant IDs and profile/contact names are ignored. Senders normalize to the existing `+<country code><number>` identity. Numeric phone identities only are supported; username/business-scoped identities are not guessed. Text passes through existing heuristic redaction before `Message` storage. The normalized guest phone remains in the tenant-owned `Conversation`; the original Meta message ID and UTC event/receipt timestamps are stored in `WhatsAppInbound`. Names are not inferred. Redaction is heuristic, not a guarantee of complete removal of personal information.

`WebhookEvent` stores a SHA-256 body digest and bounded outcome counts, **never the raw payload**, despite the historical JSON column name `rawBody`. Distinct outcomes include `RECORDED`, `RECORDED_USAGE_BLOCKED`, `DUPLICATE`, `MESSAGE_ID_CONFLICT`, `UNKNOWN_NUMBER`, `INACTIVE_NUMBER`, `BUSINESS_MISMATCH`, `CONVERSATION_CONFLICT`, `STATUS`, `ECHO`, `UNSUPPORTED` and `MALFORMED`. Statuses, media, outbound echoes (`smb_message_echoes` or `is_echo`) and other unsupported changes do not create conversations or usage. Unknown/inactive/mismatched mappings are safely quarantined as receipt outcomes, without retaining guest payloads or assigning a guessed tenant.

A valid signature is required even for malformed JSON. Missing/invalid signatures return `401`; malformed signed payloads return `400` with a durable safe receipt; oversized requests return `413`. Supported messages and safe ignored/quarantined outcomes return `200 { "received": true }` only after persistence. This acknowledgement means receipt, not a reply, reservation or confirmed booking.

Receipt insertion uses PostgreSQL `ON CONFLICT DO NOTHING`. Processing acquires the existing usage-mode advisory transaction lock, then receipt and connection row locks. The entire batch's conversations, messages, deduplication rows, usage receipts/windows and audit records commit together. A database/audit failure rolls those business writes back, leaves a safe RETRY marker when the database permits, and returns `503 WEBHOOK_RETRY_REQUIRED`. If even receipt persistence fails, no success is acknowledged. The provider must redeliver the signed payload; there is no background worker or locally retained raw payload for autonomous replay. Quarantined terminal deliveries are not automatically replayed after mapping corrections.

Deduplication uses `(tenantId, phoneNumberId, metaMessageId)`. Repackaging the same message in a different webhook envelope cannot add a message, usage receipt or window, or extend the 24-hour inactivity deadline. Reuse with changed content is quarantined without overwriting history. The existing Phase 6A counting primitive is shared; there is no second conversation counter. Distinct numbers for the same tenant and guest retain separate message histories but share Phase 6A's tenant/channel/guest usage identity. Authenticated actors audit mapping changes; system actors audit inbound processing and accounting, with the resolved tenant and without message bodies or contact values.

### Migration and operational boundaries

New migration: `20261102000100_whatsapp_inbound`. It adds `WhatsAppInbound`, composite foreign keys to the exact tenant/connection/number and tenant/conversation/message, a tenant/time index, and scoped message-ID uniqueness. Existing `Message.providerId` global uniqueness is preserved; inbound uses a tenant/number/message-derived provider key and separately retains the original Meta ID. Additional composite unique indexes support the new foreign keys.

The old `(channel, externalBusinessId)` unique index becomes a normal lookup index so one WhatsApp business can have several numbers. SQL-only `ChannelConnection_other_business_key` preserves the old business-ID uniqueness for other channels. `(channel, externalPhoneNumberId)` is unique across both active and inactive mappings. `ChannelConnection_whatsapp_values` rejects active mappings without a valid number/business ID; inactive legacy rows with a null number remain preserved. `WhatsAppInbound_values` validates hashes, message type, usage status and timestamp bounds. The `whatsapp_connection_guard` trigger calls `protect_whatsapp_connection()` to prevent reassignment of existing WhatsApp identity/ownership; its search path is pinned to `pg_catalog`, the protected schema, then `pg_temp`, and it remains SECURITY INVOKER.

The migration runs inside `BEGIN/COMMIT`. Duplicate legacy phone mappings, malformed non-null IDs, or active mappings without a number cause a complete rollback. Do not automatically delete/reassign valuable mappings. Inspect and resolve ownership offline, then follow the documented Prisma failed-migration recovery workflow (`migrate resolve --rolled-back` only after verified rollback/repair, then `migrate deploy`). Tests perform this solely on synthetic disposable data. Never use `db push` as a substitute for migration history: Prisma does not describe the CHECK constraints, partial indexes or trigger functions. Preserve those SQL safeguards in future migrations and rerun the temporary-copy migration probe.

Database constraints protect ownership links, uniqueness and row shape; the application's transaction protocol protects shared counting, active-mapping checks, channel semantics and audit atomicity. A privileged raw SQL writer can bypass application authorization/accounting. Other limitations: no production mapping mode, external transport acceptance, automated replay/alerts, media handling, retention policy, distributed rate limiting or throughput/load acceptance. The existing in-process 120 requests/minute limiter remains in force, including webhook delivery. Staff must poll the existing inbox; no guest or staff notifications are sent. Do not enable live customers or Phase 6C processing based only on fixture tests.

### Phase 6B verification record — 2026-11-02

Pre-implementation state: `main`, commit `5ee928f`, with existing uncommitted Phase 6A and dependency-override work. That work was preserved. No dependency was installed or upgraded. SHA-256 checks confirm all eight pre-existing SQL migrations, `package.json`, `package-lock.json`, `.env`, booking/payment services and conversation tools remain byte-for-byte unchanged from this task's start. `deepmerge-ts@8.0.2` remains overridden; Prisma/client/config remain `6.19.3`. Phase 5 selection/consent, saved-plan replay, redaction, lease and takeover regressions remain present and passed.

Verification used a newly initialized disposable PostgreSQL cluster bound only to `127.0.0.1:55454`, never the application database URL from `.env`. Test commands explicitly used `AI_PROVIDER=mock`, `PAYSTACK_TEST_ENABLED=false`, `LC_ALL=C` and these local test URLs:

```text
DATABASE_URL=postgresql://override_test@127.0.0.1:55454/override_verified?schema=public
TEST_DATABASE_URL=postgresql://override_test@127.0.0.1:55454/override_test?schema=public
SHADOW_DATABASE_URL=postgresql://override_test@127.0.0.1:55454/override_shadow?schema=public
```

The integration helper creates/removes randomly named schemas within the disposable database. The migration-dev probe used the separate `override_probe` database and a schema/migration copy outside the repository. All verification logs, exact argument arrays/exit codes, source-preservation hashes and catalog snapshots are retained in `/Users/apple/.codex/audit-artifacts/shortlet-phase6b-3rasfasy/`; `commands.jsonl` is the command ledger and `changed-files.json` lists this task's 24 changed files.

| Command | Actual result |
| --- | --- |
| `npm run build` | Exit 0, including a final build after timestamp review |
| `npm test` | Exit 0: **49 passed, 0 failed, 0 skipped, 0 cancelled** |
| `npm run test:integration` | Exit 0: **183 passed, 0 failed, 0 skipped, 0 cancelled**; 510.651 seconds |
| `npx tsx --test --test-concurrency=1 test/integration/phase-five.test.ts test/integration/phase-six-a.test.ts test/integration/phase-six-b.test.ts` | Exit 0: **67 passed, 0 failed, 0 skipped, 0 cancelled**, after final timestamp guards |
| `npx prisma validate` | Exit 0, valid schema |
| `npx prisma generate` | Exit 0, Prisma Client 6.19.3 generated |
| `npx prisma migrate deploy` | Exit 0, fresh nine-migration deployment and final no-pending check |
| `npx prisma migrate status` | Exit 0, up to date |
| `npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code` | Exit 0, no difference detected |
| `git diff --check` | Exit 0 |
| `npm audit` | Exit 0, **0 vulnerabilities** |
| `npm audit --omit=dev` | Exit 0, **0 vulnerabilities** |
| `npm ls prisma @prisma/client @prisma/config deepmerge-ts` | Exit 0, existing versions/override preserved |

The temporary-copy probe ran `npx prisma migrate deploy --schema <artifact>/migration-probe/schema.prisma`, followed by `npx prisma migrate dev --schema <artifact>/migration-probe/schema.prisma --name whatsapp_inbound_probe --skip-generate` and `npx prisma migrate status --schema <artifact>/migration-probe/schema.prisma`; all exited 0. A harmless nullable column existed only in that copy. Before/after catalog comparisons preserved **198 functions (including 10 application functions), their owners/ACLs/security/search paths, 96 constraints, eight enabled triggers, 105 indexes and all nine existing migration-history records**, with one additional successful temporary migration. Source migration bytes were unchanged. The migration integration test additionally proved that duplicate legacy numbers and an active null-number mapping reject the upgrade atomically, leave the earlier schema/data intact, and recover successfully after explicit fixture repair and `migrate resolve --rolled-back`.

Development failures were retained and fixed rather than hidden:

| Initial command / log | Result and resolution |
| --- | --- |
| `npx tsx --test --test-concurrency=1 test/integration/phase-six-b.test.ts test/integration/phase-six-a.test.ts` (`focused-initial.log`) | Exit 1: **31 passed, 3 failed, 0 skipped**. Two child failures plus their parent exposed earlier ingress clocks moving a usage window backwards and violating its SQL check. The shared primitive now keeps its timestamp/deadline monotonic. |
| `npx tsx --test --test-concurrency=1 test/integration/phase-six-b.test.ts test/integration/phase-six-a.test.ts test/integration/phase-six-b-migrations.test.ts test/integration/phase-six-a-migrations.test.ts` (`focused-second.log`) | Exit 1: **37 passed, 2 failed, 0 skipped**. One new expiry test selected an unrelated receipt when timestamps tied, plus its parent failure. The fixture now selects the exact guest identity; migration tests passed. |
| `npx tsx --test --test-concurrency=1 test/integration/phase-six-b.test.ts` (`focused-third.log`) | Exit 1: **18 passed, 2 failed, 0 skipped**. The concurrent-delivery child test and parent exposed Prisma's empty-update upsert racing on initial receipt insertion. PostgreSQL confirmed `WebhookEvent_provider_eventId_key` rejection. Replaced with atomic insert-on-conflict; the test now runs five separate rounds of three competing deliveries. |
| Same focused command (`focused-fourth.log`) | Exit 0: **20 passed, 0 failed, 0 skipped**. Later month-boundary coverage and conversation timestamp assertions also passed in the final 67-test regression run. |

The six new unit tests cover exact-byte signatures, safe token comparison, normalization/redaction, date/size limits, explicit status/media/echo handling, configuration gates and access-log privacy. The new PostgreSQL tests cover tenant resolution/spoofing, roles, all read routes, unknown/inactive mappings, duplicate/repackaged/conflicting/concurrent delivery, blocked accounting, timestamps/expiry, failed transaction/batch rollback and redelivery, database unavailability, SQL constraints and migration failure/recovery. Earlier tests were retained: the Phase 2 readiness test now requires the new migration, the appended migration probe sorts after it, and the Phase 6A migration test uses a temporary history copy ending at its own phase so its original preservation assertions remain intact.

Files changed in this task (separate from the pre-existing dirty tree):

| Files | Purpose |
| --- | --- |
| `.env.example`, `src/config.ts`, `src/app.ts` | Disabled-by-default webhook configuration, safe request logs and plugin registration |
| `src/routes/whatsapp-webhook.ts`, `src/services/whatsapp-validation.ts`, `src/services/whatsapp-webhook.ts` | Verification, raw-byte authentication, normalization and durable transactional ingestion |
| `src/routes/whatsapp-connections.ts`, `src/services/whatsapp-connections.ts`, `src/services/authorization.ts`, `src/routes/operator.ts` | Tenant-scoped OWNER/MANAGER mapping administration and audited changes |
| `src/services/usage-inbound.ts`, `src/services/usage-service.ts` | Shared Phase 6A accounting/locking primitive and monotonic inactivity timestamps |
| `src/services/conversation-service.ts` | Read-only inbound history alongside existing simulations; mutation boundaries retained |
| `prisma/schema.prisma`, `prisma/migrations/20261102000100_whatsapp_inbound/migration.sql`, `src/routes/health.ts` | Inbound persistence, mapping integrity and schema readiness |
| `test/whatsapp.test.ts`, `test/integration/phase-six-b.test.ts`, `test/integration/phase-six-b-migrations.test.ts` | New security, normalization, concurrency, accounting and migration regressions |
| `test/integration/phase-two-migrations.test.ts`, `test/integration/phase-three-acceptance-migrations.test.ts`, `test/integration/phase-six-a-migrations.test.ts` | Preserve earlier assertions across the new migration boundary |
| `README.md`, `docs/BUILD_PLAN.md` | Implemented scope, API/setup instructions, limitations and actual results; build plan remains ignored by the existing `.gitignore` |

No real AI calls, outbound WhatsApp messages, live payments, valuable/production database mutations, commits, pushes or deployments occurred. No real credentials or guest messages were used as test fixtures. External Meta delivery, live ownership verification and production activation remain untested. Phase 6C has not started.
