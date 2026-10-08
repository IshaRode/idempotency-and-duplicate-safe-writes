# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when same logical request arrives more than once.

## Why This Repository Exists

Current starter inserts incident on every request. It has no idempotency record, duplicate claim, stored replay result, or durable paging job. Supplied tests describe required contract.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents table; add idempotency and paging tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # broken handler to repair
├── tests/
│   └── idempotency.test.js     # 14 supplied contract tests
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

## Prerequisites

- Git
- Node.js 18 or newer
- npm
- Docker with Docker Compose
- GitHub account

## Setup

1. Fork repository to your GitHub account.
2. Clone your fork:

```bash
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents
```

3. Start PostgreSQL and install dependencies:

```bash
docker compose up -d
npm install
```

4. Reset database and run tests:

```bash
npm run db:reset
npm test
```

Starter tests fail until required schema and handler are implemented. This is expected.

## What to Implement

### Database

Add:

- scoped idempotency record with key, request hash, state, replay metadata, and expiry;
- unique ownership for authenticated tenant + operation + key;
- durable paging-job table.

### Handler

Implement:

- required `Idempotency-Key` validation;
- authenticated tenant scope;
- canonical request hash;
- atomic key claim before incident creation;
- completed replay, changed-request conflict, and processing response;
- one transaction for key, incident, paging job, and completed response.

Do not call external queue/provider inside database transaction.

### README Decisions

#### 1. Why database uniqueness is needed
In distributed, multi-threaded, or multi-instance application servers, duplicate requests often arrive concurrently (due to network retries, client timeouts, or race conditions). Application-level read-then-write checks (e.g., `SELECT` followed by `INSERT`) are vulnerable to Time-Of-Check to Time-Of-Use (TOCTOU) race conditions. A database-level unique constraint on `(tenant_id, operation, key)` enforces atomic mutual exclusion at the storage engine level. When concurrent requests attempt to insert the same key, PostgreSQL's index locks serialize the operations: exactly one transaction acquires the claim while concurrent competitors block until the winner commits, preventing duplicate incident and paging job creation.

#### 2. How request contents are canonicalized and compared
JSON objects are unordered key-value collections; two semantically identical payloads may differ in key ordering (e.g. `{"severity":"P1","title":"x"}` vs `{"title":"x","severity":"P1"}`). A raw string comparison or naive hash would falsely detect changes and produce incorrect conflicts. To guarantee determinism:
- The request body is recursively traversed: object keys are sorted lexicographically at every nesting level, while array elements preserve order.
- The resulting canonical JSON string is hashed using SHA-256 (`crypto.createHash('sha256')`).
- If an existing key is presented, its stored `request_hash` is compared against the incoming canonical hash. If they do not match, the request is rejected with `409` and `{ error: 'idempotency_key_conflict' }`.

#### 3. What 24-hour expiry means
The `expires_at` column defines the retention window for the idempotency guarantee (defaulting to `now() + interval '24 hours'`):
- **Client semantics:** Within this 24-hour window, clients can safely retry failed or timed-out requests and receive the guaranteed cached result without triggering side effects.
- **Storage lifecycle:** Unbounded retention of idempotency records and response payloads would lead to table bloat and degraded database index performance. Setting an explicit expiration boundary allows background pruning or TTL maintenance jobs to delete expired records safely once the retry window has passed.

#### 4. Why paging job is stored in same transaction
Creating an incident and notifying on-call engineers via an external paging provider represents a dual-write problem. Calling an external paging service inside the transaction risks distributed inconsistencies if the database rolls back, and holding external HTTP/network connections open inside a database transaction causes connection pool exhaustion. Conversely, calling the external service after the commit risks lost alerts if the application crashes before dispatching.
Storing the paging job in the `paging_jobs` table inside the exact same database transaction implements the **Transactional Outbox Pattern**. The incident and the paging obligation commit atomically (`all-or-nothing`). An outbox worker can then asynchronously read `pending` jobs and dispatch them reliably with at-least-once delivery guarantees.

#### 5. Privacy and size risks of stored responses
- **Privacy and Compliance:** Persisting full API response payloads (`response_body JSONB`) duplicates sensitive customer data, PII, and service details. This creates additional exposure in database audits and complicates regulatory compliance (e.g., GDPR "Right to be Forgotten", CCPA, and HIPAA) where data deletion or redaction requests would need to purge historical idempotency records as well.
- **Storage and Performance Bloat:** Storing full arbitrary JSON responses leads to rapid table bloat, increased Write-Ahead Log (WAL) volume, and cache eviction pressure in shared buffers. Very large response payloads can force PostgreSQL into out-of-line TOAST storage, introducing I/O overhead. In production, risk can be mitigated by stripping or hashing sensitive fields, storing only minimal reference IDs (e.g. `{ id: incident.id }`), or enforcing payload size caps.

## Test Coverage

Supplied tests check:

- missing key;
- first request;
- sequential replay;
- replay response header;
- changed payload conflict;
- tenant isolation;
- 20 concurrent duplicates;
- exactly one incident and paging job;
- lost response retry;
- processing and failed states;
- transaction rollback;
- canonical hash;
- stored scope and operation.

Do not change tests.

## Submit Pull Request

```bash
git add .
git commit -m "Implement duplicate-safe incident creation"
git push -u origin idempotent-incidents
```

Open pull request from `idempotent-incidents` into your fork's `main` branch. Include:

- summary of approach;
- design decisions;
- passing test output.

Submit pull-request URL, not repository homepage, branch, commit, or PDF link.

## Troubleshooting

**Docker port conflict:** stop process using port 54329 or change port consistently in Compose and `DATABASE_URL`.

**Database connection failed:** wait until PostgreSQL is healthy, then run `npm run db:reset` again.

**Tests say idempotency table is missing:** implement schema TODOs and rerun reset before tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.
