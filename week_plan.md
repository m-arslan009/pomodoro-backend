# Evergrove Backend — 7-Day Execution Plan (Demo Week)

> **Goal:** by end of Day 7, run a live demonstration in which a person signs up in a browser,
> logs in, creates a task, runs a focus session, watches points and a title unlock, sees history
> populate, refreshes, and logs in from a *second* browser to find the same data waiting.
>
> **Technology-agnostic on purpose.** This plan specifies *capabilities, contracts and acceptance
> criteria*, never a framework, database engine, or library. Stack selection is a separate decision
> (see [`../backend_architecture.md`](../backend_architecture.md)); this plan is executable against
> any competent choice made on Day 1.
>
> **Current state:** `backend/` is empty. `frontend/pomodoro/` is a finished, tested React SPA that
> persists everything in browser `localStorage` behind one module (`services/storage.js`) and
> "authenticates" against a hardcoded account (`services/auth.js`). Nothing has been built yet.

---

## 0. What the analysis found (read this before Day 1)

### 0.1 What the application does today

Seven pages — Landing, Sign Up, Log In, Timer (the dashboard), History, Profile, Settings. A user
adds tasks, focuses one, runs a countdown (default 25/5, adjustable 1–120 / 1–60 minutes), and the
session is recorded as `completed` or `terminated`. Points accrue (+100 per completion, +50 on every
third consecutive completion, −200 on termination), lifetime points unlock five titles at
1000/2000/4000/8000/16000, and each title unlocks a previewable feature. History shows summary KPIs,
a daily/weekly/monthly timeline, and task outcomes.

### 0.2 Backend responsibilities this implies

The backend exists to own five things the browser provably cannot:

| # | Responsibility | Evidence in the current code |
|---|---|---|
| R1 | **Real accounts** | `auth.js` recognises one hardcoded user; `verifyCredentials` (`auth.js:96`) never reads the registered-user list, so **every account created by Sign Up can never log in** |
| R2 | **Credential security** | The password is stored in `localStorage` **in plaintext** (`auth.js:87`); the "session" is a plain profile object, forgeable from devtools (`auth.js:104-113`) |
| R3 | **Durable, cross-device data** | Lifetime points — the product's core promise — live in the most volatile store in the browser, with no export and no recovery |
| R4 | **Authoritative scoring** | `applyCompletion` / `applyTermination` run in the client (`TimerPage.jsx:175,247`), so devtools is an infinite-points cheat |
| R5 | **Real history and aggregation** | `pruneSessions` deletes anything older than 7 days (`TimerPage.jsx:92`) while `buildTimeline` builds **6 weekly and 6 monthly buckets** (`history.js:82-101`) — the Weekly and Monthly charts are structurally incapable of ever showing data |

### 0.3 The integration seam already exists

`services/storage.js` and `services/auth.js` are the *only* modules in the SPA that touch
persistence. Every page, hook and component goes through them. **Day 5 is a body-swap of those two
files, not a UI rewrite** — provided the API returns the record shapes the UI already renders.

**Record shapes that must be preserved at the API boundary** (changing them turns a 1-day
integration into a 3-day one):

```
task     { id, title, status: 'todo'|'completed'|'terminated'|'expired', createdAt, endedAt? }
session  { id, taskTitle, durationMs, endedAt, status: 'completed'|'terminated' }
points   { balance, currentStreak, lifetimePoints, unlockedTitles[] }
settings { workMinutes, breakMinutes, theme, customTheme?, background?, customLabels?, schedule? }
profile  { id, firstName, lastName, email, username, createdAt }
```

**One known impedance mismatch, to be resolved on Day 1:** the frontend saves *whole arrays*
(`saveTasks(items)`, `saveSessions(items)`). A REST-shaped API works per item. Day 1 decides the
mapping; Risk R-2 carries the fallback.

### 0.4 Scope calls made from this analysis

| Decision | Rationale |
|---|---|
| **Server computes all points.** The client sends what happened; the server replies with the new totals | R4 — the alternative is an unenforceable economy |
| **No data pruning, no 24h task expiry** | R5 — the charts the demo shows need history to exist. Drop both client rules on Day 5 |
| **`terminationReason` field exists, nullable, unused by the UI in week 1** | Costs one column now; retrofitting it into recorded history later is impossible |
| **The −200 penalty stays for week 1** | It is the specified behaviour and the demo shows it. Changing product rules mid-build week is scope creep; `product_analysis.md` owns that debate |
| **Day-streaks, freezes, reason capture UI, estimation, export/import, reminders → P2** | None is needed for the demo spine, each is a multi-day feature |

---

## 1. Demo scope (frozen — everything below serves this)

**The demo script, in order.** Every P0 task exists to make one of these steps work:

1. Open the deployed site. Sign up a brand-new account.
2. Log in with those credentials. *(This is the flow that is broken today — showing it work is the headline.)*
3. Land on the dashboard, add a task, focus it, start a **1-minute** session (durations are user-editable down to 1 minute, so this is a real session, not a mock).
4. Session completes → points increase **by an amount the server decided** → **"The Anchor" unlocks live** (the demo account is seeded 100 points short of the threshold).
5. Terminate a second session → points decrease, streak resets, the record appears as `terminated`.
6. Open History → summary KPIs, and the **Weekly and Monthly charts populated with real history** (impossible in the current app).
7. Change work duration in Settings, edit the profile name → both persist.
8. Refresh the page → everything is still there. Open a **second browser**, log in → the same data appears. *(The proof that the backend is real.)*
9. Log out → protected pages are inaccessible.

**Explicitly out of scope for the demo:** password reset, email verification, social login, offline
support, notifications, scheduling execution, data export/import, admin tooling, any feature not on
that list.

---

## 2. Priority definitions

| Level | Meaning |
|---|---|
| **P0 — Demo-Critical** | A step in §1 fails without it. Non-negotiable |
| **P1 — Important** | The demo survives without it, but the result is insecure, unmaintainable, or embarrassing under a question |
| **P2 — Delayable** | Real value, no demo impact. Listed in §14 with the trigger for picking it up |

**Daily discipline:** finish every P0 for the day before starting any P1. If a day's P0 work
slips, cut P1 from that day, not P0 from the next.

---

# Day 1 — Requirements, contracts, and a running skeleton

*Outcome: a service that starts, reports health, reads config, returns a consistent error, and a
written API contract both sides agree on. No business logic yet.*

### D1-T1 — Freeze the demo scope · **P0**
- **What:** copy §1 into a one-page scope note; get explicit agreement; anything not in it is P2 for this week.
- **Why:** a demo week fails from scope drift, not from difficulty. This is the artefact that makes "no" cheap on Day 4.
- **Depends on:** nothing. **Blocks:** every other task — they are all justified by reference to it.
- **Done when:** the note exists, is agreed, and each Day 2–4 task traces to a numbered demo step.

### D1-T2 — Choose the stack and record it · **P0**
- **What:** pick language/framework, datastore, migration tool, test runner, hosting target, and password-hashing algorithm. One paragraph of reasoning each; the ADR already contains the analysis.
- **Why:** every subsequent task is blocked on this and on nothing else. It is the only decision that cannot be deferred.
- **Depends on:** D1-T1. **Blocks:** D1-T4 onward.
- **Done when:** choices recorded; a "hello world" runs locally; the datastore is reachable from it.
- **Constraint:** choose boring, well-documented tools. This week has no budget for learning a new paradigm.

### D1-T3 — Design the data model · **P0**
- **What:** entities, fields, types, nullability, relationships, and constraints for: **user, auth session, task, focus session, gamification state, user settings.** Written as a schema document before any code.
- **Why:** the current model has three defects that must not reach a database — sessions store a task *title string* with no reference (renaming orphans history), sessions record `endedAt` and a duration but **no `startedAt`** (making time-of-day analysis and overlap detection impossible), and breaks are never recorded at all.
- **Required corrections to today's shape:**
  - focus session gains `startedAt`, a **task reference**, a **task title snapshot** (so history survives task deletion), and a `type` discriminator (`focus` | `break`).
  - user gains `timezone` (day bucketing is wrong without it) and a nullable `emailVerifiedAt` (so verification is a later addition, not a migration).
  - task gains nothing; the `expired` status is retained for display compatibility but is **never set automatically**.
  - gamification state keeps the `balance` / `lifetimePoints` split exactly as today — `lifetimePoints` must be monotonic and drives titles.
- **Depends on:** D1-T1. **Blocks:** D2-T1.
- **Done when:** every field in §0.3 has a home; every relationship has a defined delete behaviour; a peer can read it without asking questions.

### D1-T4 — Write the API contract · **P0**
- **What:** a written contract covering every endpoint below — method, path, request shape, response shape, status codes, and error cases. Publish it where the frontend work can read it.
- **Why:** it lets backend and frontend integration be planned in parallel and turns Day 5 into wiring rather than discovery.
- **Minimum endpoint set (the whole demo, nothing more):**

| Area | Endpoints |
|---|---|
| Auth | register · login · logout · current user · change password |
| Profile | read · update (first name, last name, username) |
| Settings | read · update |
| Tasks | list · create · update (status/title) |
| Sessions | **record one session** (the only endpoint with real logic) · list |
| Gamification | read current totals |
| Stats | summary · timeline (daily/weekly/monthly) · task outcomes |
| Ops | health |

- **The one contract that matters** — recording a session. The client reports what happened; the response carries the recomputed totals so the client never calculates anything and never needs a second request:

```jsonc
// request
{ "taskId": "…|null", "type": "focus", "status": "completed",
  "startedAt": "<ISO>", "endedAt": "<ISO>",
  "plannedDurationMs": 60000, "terminationReason": null }

// response
{ "session":      { "id": "…", "taskTitle": "…", "durationMs": 60000,
                    "endedAt": "<ISO>", "status": "completed" },
  "gamification": { "balance": 1050, "lifetimePoints": 1050, "currentStreak": 3,
                    "unlockedTitles": ["anchor"], "pointsDelta": 150,
                    "newlyUnlocked": ["anchor"] } }
```

- **Also decide here:** the array-save mapping from §0.3 (per-item calls vs. one bulk replace), and the ISO-8601 UTC convention for every timestamp on the wire.
- **Depends on:** D1-T3. **Blocks:** D2-T3, D3-*, D5-T1.
- **Done when:** every step of the §1 demo script maps to specific endpoints, and the response field names match §0.3.

### D1-T5 — Project skeleton, configuration and secrets · **P0**
- **What:** repository structure, dependency manifest, environment-variable configuration **validated at startup** (fail fast with a clear message when a required value is missing), `.env` git-ignored with a committed `.env.example`, and a documented local run command.
- **Why:** a missing secret must break startup, not request four thousand. Committed credentials are the single most common way a demo project leaks.
- **Config surface:** datastore connection, session/cookie secret, allowed frontend origin, port, log level, environment name.
- **Depends on:** D1-T2. **Blocks:** everything.
- **Done when:** the service starts locally; deleting a required variable produces a named startup failure; `git status` shows no secret files.

### D1-T6 — Health endpoint and structured logging · **P0**
- **What:** a health endpoint (process alive, plus a datastore connectivity check) and one structured log line per request — method, path, status, duration, user id when known, and a correlation id. Redact credentials and cookies at the logger config level.
- **Why:** on Day 6 the only tool for diagnosing a deployment is a log line; on Day 7 the health check is how you confirm the service is up before starting the demo.
- **Depends on:** D1-T5. **Blocks:** D6-T1.
- **Done when:** health returns healthy locally and *unhealthy* when the datastore is stopped; a request produces one parseable log line; no password or cookie value ever appears in output.

### D1-T7 — Error and validation contract · **P0**
- **What:** one error response shape used by every endpoint, and one place that produces it. Fields: a machine-readable code, a human-readable message, and an optional per-field error map. Map internal failures to it; **never return a stack trace or raw datastore error**.
- **Why:** the SPA already renders per-field validation errors on Sign Up, Log In, Profile and Settings. A consistent shape means the frontend writes one error handler on Day 5 instead of seven.
- **Depends on:** D1-T4. **Blocks:** D4-T3.
- **Done when:** a forced internal error returns the standard shape with no internals; a malformed body returns the same shape with field errors.

### D1-T8 — Version control and branch hygiene · **P1**
- **What:** the repository is **not currently under git**. Initialise it, add ignore rules for dependencies, build output, environment files and local database volumes, and make the first commit.
- **Why:** without it there is no rollback on Day 7, when rollback is the only safety net that matters.
- **Done when:** a clean `status`, a first commit, and a verified fresh clone that installs and starts.

---

# Day 2 — Schema, migrations, seed, and the first end-to-end flow

*Outcome: a real user can register and log in against a real database, with a hashed password and a
credential that cannot be forged. This is the flow that is broken today.*

> **Why the auth flow is Day 2's vertical slice rather than Day 4's:** every other endpoint is
> scoped to "the current user", so identity is a hard dependency of Day 3. Day 4 then *hardens*
> what Day 2 stood up — that is the deliberate reading of the brief, not a departure from it.

### D2-T1 — Schema and migrations · **P0**
- **What:** implement D1-T3 as versioned, repeatable migrations. Constraints in the database, not only in code: unique email, unique username, required fields, valid-status checks, foreign keys with explicit delete behaviour.
- **Why:** constraints catch the bugs the application forgets, and migrations are what make the Day 6 deployment reproducible instead of hand-made.
- **Depends on:** D1-T3, D1-T5. **Blocks:** all of Day 3.
- **Done when:** migrations apply cleanly to an **empty** database from a single command; re-running is a no-op; a duplicate email insert is rejected *by the database*.

### D2-T2 — Password storage and verification · **P0**
- **What:** a strong, salted, adaptive password hash (algorithm chosen D1-T2) behind a small internal interface so it can be swapped. Registration hashes; login verifies; **plaintext is never stored, logged, or returned.**
- **Why:** replaces the plaintext password of `auth.js:87`. This is the single highest-severity defect in the product.
- **Depends on:** D2-T1. **Blocks:** D2-T3.
- **Done when:** the stored value is a hash with a visible cost parameter; the same password hashed twice yields different values; a wrong password fails; no log line or API response ever contains the password.

### D2-T3 — Registration, login, logout, current user · **P0**
- **What:** the four endpoints, with server-side validation that **exactly mirrors** `services/validation.js` (names ≥2 characters and free of digits; email syntactically valid; username 3–20 characters, letters/numbers/underscore only; password ≥8 with at least one letter, one digit and one special character). Duplicate email and duplicate username are rejected with per-field errors.
- **Why:** the demo's headline is that sign-up → login finally works. Mirroring the client rules means the SPA's existing messages stay accurate and no user can bypass them by calling the API directly.
- **Credential handling:** issue an opaque, high-entropy session credential stored **hashed** server-side, delivered in an HTTP-only cookie with an expiry. It carries no user data, so it cannot be forged or read by scripts, and it can be revoked instantly. Login responses must return **no** token in the body.
- **Depends on:** D2-T1, D2-T2, D1-T4, D1-T7. **Blocks:** every user-scoped endpoint.
- **Done when — and this is the anti-regression test that matters:** register a new account → log out → **log in with those exact credentials** → the current-user endpoint returns that profile. The existing frontend suite passes today *while this exact flow is broken*, because it asserts each half separately and never the join. **Write the joined test.**
- **Also test:** wrong password → generic failure (no hint about which field was wrong, no account enumeration); duplicate email → per-field error; missing cookie → unauthorised; logged-out cookie → rejected.

### D2-T4 — Seed and demo data · **P0**
- **What:** a repeatable seed command creating a demo account with **8 weeks of realistic history** — tasks in mixed states, focus sessions spread across days with plausible durations and a realistic completion rate, and matching gamification totals.
- **Why:** three reasons, all demo-critical. (a) The Weekly and Monthly charts need more than 7 days of data — with today's client-side pruning they can *never* be populated, so this is the first time they will ever render. (b) A live demo cannot spend 20 minutes generating history. (c) It is the fastest way to test aggregation correctness.
- **Tune it for the demo:** seed lifetime points to **900** and the streak to **2**, so the first completed session on stage awards 100 + a 50 streak bonus = **+150**, crosses 1000, and **unlocks "The Anchor" live**. That is demo step 4, and it should be arranged, not hoped for.
- **Depends on:** D2-T1. **Blocks:** D3-T5, D7-T3.
- **Done when:** one command produces the account from an empty database; it is idempotent or safely re-runnable; the seeded totals are exactly consistent with the seeded sessions.

### D2-T5 — First integration tests against a real datastore · **P1**
- **What:** an automated test setup that runs against a **real** datastore instance (not a mock) with per-test isolation, covering D2-T3's flows.
- **Why:** unique constraints, foreign keys and transaction behaviour are exactly what will break on Day 6, and a mock cannot see any of it.
- **Depends on:** D2-T3. **Blocks:** D5-T3.
- **Done when:** the suite runs from one command on a clean machine and passes twice consecutively.

---

# Day 3 — Core APIs and business rules

*Outcome: every piece of data the dashboard renders is served by the backend, and the points economy
is enforced server-side.*

### D3-T1 — Task CRUD · **P0**
- **What:** list the current user's tasks, create one (title required, trimmed, length-bounded), and update status (`todo` → `completed` | `terminated`) and title. Setting a terminal status stamps `endedAt`.
- **Why:** demo step 3. The Timer dashboard cannot start a session without a focused task.
- **Not implemented:** automatic 24-hour expiry. Real work spans days, and silently expiring a user's task overnight is a mechanic that annoys without serving the demo. The `expired` status remains valid for display only.
- **Depends on:** D2-T3. **Blocks:** D3-T3, D5-T1.
- **Done when:** create → list returns it; complete → status and `endedAt` update; an empty or oversized title is rejected with a field error; the list contains **only** the caller's tasks.

### D3-T2 — Settings read and update · **P0**
- **What:** read and update `workMinutes` (1–120), `breakMinutes` (1–60), `theme` (`system`|`light`|`dark`), plus an open preferences blob carrying `customTheme`, `background`, `customLabels` and `schedule` unchanged.
- **Why:** demo step 7, and the timer's durations come from here — including the **1-minute focus block the demo depends on**.
- **Note:** clamp durations server-side to the same limits the client enforces; unknown preference keys are stored and returned verbatim so the gated Settings sections keep working untouched.
- **Depends on:** D2-T3. **Blocks:** D5-T1.
- **Done when:** defaults are returned for a new account; an update round-trips; an out-of-range duration is clamped or rejected consistently with the client; unknown preference keys survive a round trip.

### D3-T3 — Record a session · **P0** · *the core of the backend*
- **What:** the endpoint from D1-T4. In **one transaction**: validate, persist an immutable session record, recompute gamification state, persist it, and return both.
- **Why:** demo steps 3–5. This is the only endpoint with real domain weight, and R4 — the whole reason points cannot stay in the client.
- **Business rules, implemented server-side and nowhere else:**
  - completed focus session: **+100**; plus **+50** when the resulting consecutive-completion count is a multiple of 3.
  - terminated focus session: **−200** from balance, **floored at zero**; consecutive count resets to zero.
  - `lifetimePoints` **only ever increases** — penalties never touch it, so an earned title can never be lost. Titles derive from lifetime points at 1000 / 2000 / 4000 / 8000 / 16000.
  - completed **break** sessions are recorded for history but score nothing.
  - the response reports `pointsDelta` and any `newlyUnlocked` titles, so the client can show the toast without recomputing.
- **Validation (the client is not trustworthy):** reject `endedAt` before `startedAt`; reject a future `endedAt`; reject an implausible duration (longer than planned, or over 4 hours); record the true elapsed duration for terminations, not the nominal one.
- **Depends on:** D3-T1, D2-T3. **Blocks:** D3-T4, D3-T5, D5-T1.
- **Done when:** three consecutive completions award 100, 100, 150; a termination deducts 200 and resets the streak; a balance at 100 terminating lands at **0, never negative**; lifetime points do not move on termination; crossing 1000 reports `anchor` in `newlyUnlocked` exactly once; totals survive a restart; an invalid time range is rejected.

### D3-T4 — Gamification read endpoint · **P0**
- **What:** return balance, lifetime points, current streak and unlocked titles for the current user.
- **Why:** the dashboard's points tile and the layout's title badge render on page load, before any session exists.
- **Depends on:** D3-T3. **Blocks:** D5-T1.
- **Done when:** a fresh account returns zeros and an empty title list; the seeded account returns its seeded totals.

### D3-T5 — Stats and history endpoints · **P0**
- **What:** three read endpoints matching the shapes `services/history.js` already produces:
  - **summary** — points, streak, completed/terminated session counts, completed/incomplete task counts, total sessions, completion rate (%), total focus minutes.
  - **timeline** — outcome counts bucketed by `daily` (last 7 days), `weekly` (last 6 weeks) or `monthly` (last 6 months), each bucket labelled and returned oldest → newest, **including empty buckets**.
  - **task outcomes** — counts by status in the fixed display order completed / in-progress / expired / terminated.
- **Why:** demo step 6, and R5 — with pruning removed and seed data present, the weekly and monthly views render real data for the first time.
- **Two correctness notes:** bucket by the **user's local day**, not UTC, or every evening session west of Greenwich lands in the wrong bucket; and the summary's headline points figure must be the one the caption claims — the current client labels `balance` as "lifetime points earned" (`history.js:58`), which is the wrong number. Return both, explicitly named.
- **Depends on:** D3-T3, D2-T4. **Blocks:** D5-T1.
- **Done when:** each shape matches what the History components consume; seeded data populates all three intervals; a new account returns zeroed summaries and empty (not missing) buckets; totals reconcile against a direct count of the seeded sessions.

### D3-T6 — Profile read and update · **P1**
- **What:** read the profile; update first name, last name and username (username uniqueness enforced). Email and id are immutable.
- **Why:** demo step 7. P1 rather than P0 only because the demo survives if the name edit is skipped.
- **Depends on:** D2-T3.
- **Done when:** an update round-trips and is visible after re-login; taking another user's username is rejected with a field error.

### D3-T7 — Change password · **P1**
- **What:** change password, requiring the current password. On success, invalidate all *other* active sessions for that user.
- **Why:** the Profile page already offers it; shipping a change-password that does not verify the current password is worse than not shipping it.
- **Depends on:** D2-T2, D2-T3.
- **Done when:** a wrong current password is rejected; after a successful change the old password fails and the new one works; other sessions are logged out.

---

# Day 4 — Authorization, validation, hardening, integration plumbing

*Outcome: the API is safe to point a browser at from another origin, and no endpoint leaks or accepts
anything it shouldn't.*

### D4-T1 — Enforce ownership on every endpoint · **P0**
- **What:** every read and write is scoped to the authenticated user **as part of the data query**, not as an `if` check after fetching. Requesting another user's record returns **not-found**, never forbidden.
- **Why:** the single highest-severity risk in a multi-user demo is user A seeing user B's data — and someone *will* ask about it during questions. Scoping in the query makes the check impossible to forget, and not-found avoids confirming that another user's record exists.
- **Depends on:** all of Day 3. **Blocks:** D6-T2.
- **Done when:** for **every** resource, user A authenticated with user A's credential requesting user B's identifier receives not-found. One test per resource — no exceptions.

### D4-T2 — Authentication guard on every protected route · **P0**
- **What:** a single mechanism that rejects unauthenticated requests, applied by default, with public routes (register, login, health) as the explicit exceptions.
- **Why:** default-open with per-route opt-in leaks the moment someone adds an endpoint on Day 5.
- **Depends on:** D2-T3.
- **Done when:** every non-public endpoint returns unauthorised with no cookie, an expired cookie, a tampered cookie, and a logged-out cookie.

### D4-T3 — Input validation on every endpoint · **P0**
- **What:** validate and normalise every request body and query parameter at the boundary — types, ranges, enums, string lengths, timestamp formats. Unknown fields are rejected or stripped, consistently. Normalise email and username (trim, lowercase) in exactly one place.
- **Why:** the client validates for UX; the server validates for correctness. Anyone can call the API directly.
- **Depends on:** D1-T7, Day 3.
- **Done when:** every endpoint has at least one rejection test; errors use the D1-T7 shape with per-field detail; oversized bodies are rejected.

### D4-T4 — Session cookie hardening and CORS/proxy wiring · **P0**
- **What:** HTTP-only, secure, restrictive same-site, path-scoped, with a defined expiry and server-side revocation on logout. Configure cross-origin access for the deployed frontend origin **only**.
- **Why — and this will bite on Day 6 if skipped:** the SPA is hosted separately from the API, which makes the cookie cross-site by default and means **it will simply not be sent**, producing a login that appears to succeed and then behaves as logged-out. **Resolve it by proxying `/api/*` from the frontend host to the API host**, which makes the cookie first-party, removes most CORS surface, and needs no weakening of the cookie's same-site policy. `frontend/netlify.toml` currently has only an SPA fallback redirect and **needs this rule added**.
- **Depends on:** D2-T3. **Blocks:** D5-T1, D6-T1.
- **Done when:** the cookie carries every attribute; logout revokes server-side (a captured cookie stops working); an untrusted origin is refused; the proxy rule is committed and verified against the deployed API.

### D4-T5 — Login rate limiting · **P1**
- **What:** cap failed attempts per account and per source address over a short window; return a clear throttled response.
- **Why:** a public sign-up form with unlimited password attempts is indefensible, and this is roughly an hour of work.
- **Depends on:** D2-T3.
- **Done when:** N+1 rapid failures are throttled; a successful login is unaffected; the limit is configurable.

### D4-T6 — Consistent status codes and error mapping audit · **P1**
- **What:** walk every endpoint and confirm the status code and error body match the contract — validation, unauthenticated, not-found, conflict, and internal.
- **Why:** Day 5's frontend error handling is written once against the contract; inconsistency here becomes scattered special cases there.
- **Depends on:** D4-T3.
- **Done when:** a table of endpoint × status × body is verified by test.

---

# Day 5 — Frontend integration, tests, documentation, demo data

*Outcome: the deployed SPA talks to the API for everything. This is the highest-risk day; protect it.*

### D5-T1 — Replace the two persistence modules · **P0**
- **What:** rewrite the **bodies** of `services/storage.js` and `services/auth.js` to call the API, keeping their **exported function names and signatures**. Every page, hook and component keeps working unchanged.
- **Why:** these are the only two modules in the SPA that touch persistence — §0.3. Preserving the surface converts a rewrite into a swap.
- **Necessary consequences to handle, not discover:**
  - **Every reader becomes asynchronous.** Pages that call `getTasks()` during render initialisation must move to an effect with loading and error states. `TimerPage.jsx`, `HistoryPage.jsx`, `SettingPage.jsx` and `ProfilePage.jsx` all do this today.
  - **`services/gamification.js` stops being the authority.** `TimerPage.jsx` currently calls `applyCompletion` / `applyTermination` locally (lines 175, 247); it must instead send the session and render the totals from the response. The module survives for **display only** — thresholds, title names, progress bars.
  - **Delete the client retention rules:** `reconcileTasks` (24h expiry) and `pruneSessions` (7-day window) in `TimerPage.jsx:80-94`. They exist only to work around a storage quota that no longer applies, and they are what makes the weekly/monthly charts unpopulatable.
  - **Whole-array saves become per-item calls** per the D1-T4 mapping.
- **Depends on:** all of Days 2–4, D4-T4. **Blocks:** D6-T2, D7-T3.
- **Done when:** the full demo script (§1) runs locally end to end against the API; a hard refresh preserves all state; a second browser profile sees the same data; **no page reads `localStorage` for domain data** (a UI-only preference cache is acceptable).

### D5-T2 — Loading, empty and error states for every async surface · **P0**
- **What:** each page that now fetches shows a loading state, a usable empty state, and a recoverable error state with a retry. No indefinite spinners; no raw error text from the server.
- **Why:** the network can fail during the demo. An app that shows a blank screen on a slow response reads as broken even when the backend is fine — and the project's own frontend rules require these states.
- **Depends on:** D5-T1.
- **Done when:** with the API stopped, every page renders a clear error with a retry that recovers once the API returns; a brand-new account renders sensible empty states everywhere.

### D5-T3 — Automated test pass · **P0**
- **What:** backend — the joined register → login → authenticated read flow, the points rules table from D3-T3, ownership isolation from D4-T1, and one test per stats shape. Frontend — repair the existing suite against the new async modules.
- **Why:** the existing frontend suite passes today while the primary funnel is dead. Every seam gets one test that crosses it, or this repeats.
- **Depends on:** D5-T1, D2-T5.
- **Done when:** both suites pass from a clean checkout with one command each; the joined auth test exists and fails if either half regresses.

### D5-T4 — API documentation · **P1**
- **What:** browsable, accurate documentation of every endpoint — request, response, status codes, and an example. Generated from the code or its validation schemas where possible, so it cannot drift.
- **Why:** it is the artefact that survives the week, and a reasonable thing to show during questions.
- **Depends on:** Day 3, Day 4.
- **Done when:** every endpoint appears with a working example; a curl copied from it succeeds.

### D5-T5 — Refresh the demo dataset · **P1**
- **What:** re-run and verify the seed against the final schema; confirm the 900-point / streak-2 arrangement still produces the live title unlock; confirm all three timeline intervals populate.
- **Depends on:** D2-T4, D3-T5.
- **Done when:** a fresh seed reproduces demo steps 4 and 6 exactly.

---

# Day 6 — Deploy, end-to-end and failure-path testing

*Outcome: the demo runs against deployed infrastructure, not a laptop.*

### D6-T1 — Deploy the backend and database · **P0**
- **What:** deploy the service and a managed datastore instance. Secrets set through the platform, never committed. Migrations run as an explicit deployment step, not on application boot. Deploy the frontend with the `/api/*` proxy rule from D4-T4 pointing at the live API.
- **Why:** "it works locally" is not a demo. Deploying on Day 6 leaves a full day to fix what deployment breaks — and deployment always breaks something (environment variables, cookie attributes, cross-origin, migrations).
- **Depends on:** D5-T1, D1-T5, D1-T6.
- **Done when:** the health endpoint responds over HTTPS on the public URL; migrations have applied to the production datastore; the deployed SPA completes a real login; **a redeploy does not destroy data**.

### D6-T2 — Full end-to-end run on the deployed environment · **P0**
- **What:** execute §1's nine steps against production, from a browser, with a brand-new account. Then repeat with the seeded demo account.
- **Why:** this is the actual acceptance test for the week.
- **Depends on:** D6-T1.
- **Done when:** all nine steps pass, twice, in two different browsers.

### D6-T3 — Failure-path testing · **P0**
- **What:** deliberately break things and confirm the system degrades legibly: stop the datastore (health reports unhealthy; endpoints return the standard error, not a stack trace); submit malformed and hostile payloads (oversized strings, wrong types, negative durations, `endedAt` before `startedAt`, a future timestamp); replay a session submission twice; call every endpoint with no credential, an expired credential and another user's identifier; log out in one tab and act in another.
- **Why:** the questions after a demo are about the edges, and one uncaught stack trace on screen undoes the whole impression.
- **Depends on:** D6-T2.
- **Done when:** every case above returns a controlled, documented response; nothing 500s uncaught; no internal detail is exposed; the log shows a correlated entry for each.

### D6-T4 — Fix critical issues · **P0**
- **What:** reserve the rest of the day. Fix only demo-blocking defects; everything else goes to a list.
- **Why:** Day 6 exists to absorb the surprises from D6-T1 to D6-T3. If it is scheduled full, there is no slack and Day 7 becomes the fix day.
- **Done when:** no known defect blocks any step of §1.

### D6-T5 — Backup and restore verification · **P1**
- **What:** confirm the datastore has automated backups, then **restore one** into a scratch instance and confirm it is readable.
- **Why:** an untested backup is not a backup — and this product's headline promise is that progress is never lost. This is also the honest answer to "what if it breaks during the demo".
- **Done when:** a restore has actually been performed once and documented.

---

# Day 7 — Freeze, rehearse, verify recovery

*Outcome: a rehearsed demo and a tested way to reset it.*

### D7-T1 — Feature freeze · **P0**
- **What:** no new endpoints, no new fields, no refactors. Bug fixes for demo-blocking defects only, each verified by re-running the affected step.
- **Why:** every change on the last day carries more risk than the defect it fixes.
- **Done when:** the branch is tagged, deployed, and matches what will be demonstrated.

### D7-T2 — Fix remaining demo blockers · **P0**
- **What:** work only the list from D6-T4, in demo-script order. Anything not on the script is deferred.
- **Done when:** every step of §1 passes on the deployed environment.

### D7-T3 — Demo reset and recovery procedure · **P0**
- **What:** a **single documented command** that resets the demo account to its exact pre-demo state (900 lifetime points, streak 2, 8 weeks of history, no leftover tasks or sessions). Plus a written recovery procedure: what to do if the API is asleep or unreachable, if login fails, if the datastore is unavailable.
- **Why:** the demo will be run more than once — a rehearsal and the real thing — and step 4 (the live title unlock) only works from a precise starting state. Without a reset, the second run is silently wrong.
- **Depends on:** D2-T4.
- **Done when:** reset has been run at least twice, each time reproducing an identical starting state verified through the UI; the recovery notes fit on one page.

### D7-T4 — Rehearse the exact demo · **P0**
- **What:** run §1 end to end, on the deployed environment, on the machine and network that will be used, at least twice — once as a fresh sign-up and once with the seeded account. Time it. Note every pause.
- **Why:** rehearsal is what surfaces the 8-second cold start, the autofilled password, the browser that remembered a stale session.
- **Depends on:** D7-T3.
- **Done when:** two clean consecutive run-throughs with no unexpected pause and no improvisation; the flow fits the available time with margin.
- **Warm-up note:** if the hosting tier sleeps when idle, the first request after inactivity is slow. **Load the health endpoint immediately before the demo** and keep the tab open.

### D7-T5 — Final readiness sweep · **P1**
- **What:** work §17.
- **Done when:** every box is ticked.

---

# Closing sections

## 11. Exact demo-critical backend scope

The complete P0 list. Nothing outside it is required for the demonstration.

**Capabilities**
1. Account registration with server-side validation mirroring the client's rules.
2. Login and logout with a revocable, non-forgeable, HTTP-only credential.
3. Current-user lookup.
4. Task list, create, and status update, scoped to the owner.
5. Settings read and update, including the focus/break durations the timer reads.
6. Session recording with **server-computed** points, streak, penalty flooring, monotonic lifetime points, and title unlocking.
7. Gamification totals read.
8. Stats: summary, timeline (daily/weekly/monthly), task outcomes.
9. Health endpoint.

**Cross-cutting**
10. Startup-validated configuration and uncommitted secrets.
11. One consistent error shape; no stack traces or internal details in responses.
12. Structured request logging with credential redaction.
13. Ownership enforced on every user-scoped endpoint, returning not-found for another user's data.
14. Authentication required by default; public routes explicitly listed.
15. Versioned migrations that apply to an empty database from one command.
16. A seeded demo account with 8 weeks of history, positioned for a live title unlock.
17. Deployed backend, database and frontend, connected through the `/api/*` proxy.
18. A one-command demo reset.

## 12. Daily checklist

**Day 1 — foundation**
- [ ] D1-T1 Demo scope frozen and agreed · P0
- [ ] D1-T2 Stack chosen and recorded; hello-world runs · P0
- [ ] D1-T3 Data model documented, including `startedAt`, task reference, title snapshot, timezone · P0
- [ ] D1-T4 API contract written; session-recording contract agreed; array-save mapping decided · P0
- [ ] D1-T5 Skeleton, startup-validated config, `.env.example`, secrets ignored · P0
- [ ] D1-T6 Health endpoint and structured logging with redaction · P0
- [ ] D1-T7 Error and validation response contract · P0
- [ ] D1-T8 Repository initialised and first commit · P1

**Day 2 — schema and the auth spine**
- [ ] D2-T1 Migrations apply to an empty database; constraints enforced in the database · P0
- [ ] D2-T2 Password hashing; plaintext never stored, logged or returned · P0
- [ ] D2-T3 Register / login / logout / current user, validation mirrored · P0
- [ ] D2-T3a **The joined test: register → logout → log in → authenticated read** · P0
- [ ] D2-T4 Seed: demo account, 8 weeks of history, 900 points, streak 2 · P0
- [ ] D2-T5 Integration tests against a real datastore · P1

**Day 3 — core APIs**
- [ ] D3-T1 Task list / create / update; no auto-expiry · P0
- [ ] D3-T2 Settings read / update, including durations and the preferences blob · P0
- [ ] D3-T3 Session recording, transactional, with all points rules server-side · P0
- [ ] D3-T4 Gamification read · P0
- [ ] D3-T5 Stats: summary, timeline, task outcomes; local-day bucketing · P0
- [ ] D3-T6 Profile read / update · P1
- [ ] D3-T7 Change password with current-password check · P1

**Day 4 — hardening**
- [ ] D4-T1 Ownership scoped in-query on every endpoint; not-found for others' data · P0
- [ ] D4-T2 Authentication required by default · P0
- [ ] D4-T3 Input validation on every endpoint · P0
- [ ] D4-T4 Cookie hardening + `/api/*` proxy rule added to `frontend/netlify.toml` · P0
- [ ] D4-T5 Login rate limiting · P1
- [ ] D4-T6 Status-code and error-mapping audit · P1

**Day 5 — integration**
- [ ] D5-T1 `storage.js` and `auth.js` bodies replaced; client retention rules deleted; scoring moved server-side · P0
- [ ] D5-T2 Loading / empty / error states on every async surface · P0
- [ ] D5-T3 Backend and frontend suites green · P0
- [ ] D5-T4 API documentation published · P1
- [ ] D5-T5 Demo dataset refreshed and verified · P1

**Day 6 — deploy and break it**
- [ ] D6-T1 Backend, database and frontend deployed; migrations applied; health green over HTTPS · P0
- [ ] D6-T2 Full nine-step run on production, twice, two browsers · P0
- [ ] D6-T3 Failure paths verified; nothing 500s uncaught · P0
- [ ] D6-T4 Critical fixes applied · P0
- [ ] D6-T5 Backup restored once and verified · P1

**Day 7 — freeze and rehearse**
- [ ] D7-T1 Feature freeze; tagged and deployed · P0
- [ ] D7-T2 Demo blockers cleared · P0
- [ ] D7-T3 One-command reset, run twice, identical state · P0
- [ ] D7-T4 Two clean rehearsals on the demo machine and network · P0
- [ ] D7-T5 Final readiness sweep · P1

## 13. API and frontend dependency checklist

Each frontend surface, what it needs, and where the change lands.

| Frontend surface | Backend capability | Frontend change | Priority |
|---|---|---|---|
| `SignUpPage` | register | `saveUser` → API; duplicate checks server-side | P0 |
| `LogInPage` | login | `verifyCredentials` + `startSession` → API (**this is the broken flow**) | P0 |
| `RequireAuth` / `RequireGuest` | current user | `getSession` → API; must handle the async gap without flashing protected content | P0 |
| `AppLayout`, `TitleBadge` | gamification read | async totals; `gamification.js` for display only | P0 |
| `TimerPage` — tasks tile | task list / create / update | `getTasks`/`saveTasks` → API; delete `reconcileTasks` | P0 |
| `TimerPage` — timer engine | settings read | durations fetched, not read synchronously at mount | P0 |
| `TimerPage` — session end | record session | **stop calling `applyCompletion`/`applyTermination`**; render the response | P0 |
| `TimerPage` — points tile | session response + gamification read | totals come from the server | P0 |
| `TimerPage` — history tile | session list (today) | `getSessions` → API; delete `pruneSessions` | P0 |
| `HistoryPage` — summary tile | stats summary | `summarize` → API; fix the balance/lifetime caption | P0 |
| `HistoryPage` — trend / comparison | stats timeline | `buildTimeline` → API; weekly and monthly finally populate | P0 |
| `HistoryPage` — outcome tile | task outcomes | `taskOutcomes` → API | P0 |
| `SettingPage` | settings update | `saveSettings` → API; preferences blob preserved | P0 |
| `ProfilePage` — details | profile update | `updateProfile` → API | P1 |
| `ProfilePage` — password | change password | `verifyPassword`/`changePassword` → API | P1 |
| `useFeatureGate` | gamification read | thresholds stay client-side; **lifetime points come from the server** | P1 |
| `Scheduling` settings section | settings preferences blob | persists only; nothing reads it (unchanged behaviour) | P2 |

**Deployment dependency:** `frontend/netlify.toml` currently contains only a build block and an SPA
fallback redirect. It **must** gain the `/api/*` proxy rule (D4-T4) before D6-T1, and the proxy rule
must be ordered before the catch-all SPA redirect or every API call will return the HTML shell.

## 14. Testing matrix

| Area | What is tested | How | Day | Priority |
|---|---|---|---|---|
| Auth join | register → logout → login → authenticated read | Integration | 2 | P0 |
| Auth negatives | wrong password; duplicate email; duplicate username; missing/expired/tampered/logged-out credential | Integration | 2, 4 | P0 |
| Password storage | never plaintext; never logged; never returned | Integration + log inspection | 2 | P0 |
| Validation parity | server rejects everything `validation.js` rejects | Integration, table-driven | 4 | P0 |
| Points rules | 100 / 100 / 150 across three completions; −200 with a zero floor; lifetime never decreases; title crossing reported once | Unit + integration | 3 | P0 |
| Session validation | `endedAt` < `startedAt`; future timestamp; duration > planned; duration > 4h; duplicate submission | Integration | 3, 6 | P0 |
| Ownership | user A cannot read or write user B's tasks, sessions, settings, profile — one test per resource | Integration | 4 | P0 |
| Stats shapes | summary fields; all three timeline intervals with empty buckets; outcome ordering; local-day bucketing | Integration against seed | 3 | P0 |
| Empty account | every endpoint returns a sensible zero/empty result, not an error | Integration | 3 | P0 |
| Migrations | apply cleanly to an empty database; re-run is a no-op | CI | 2 | P0 |
| Frontend flows | existing suites repaired against async modules | Component | 5 | P0 |
| End-to-end | the nine demo steps on production, two browsers | Manual, scripted | 6, 7 | P0 |
| Failure paths | datastore down; malformed payloads; hostile payloads; expired credential; cross-tab logout | Manual + integration | 6 | P0 |
| Rate limiting | N+1 failures throttled; success unaffected | Integration | 4 | P1 |
| Backup | one real restore | Manual | 6 | P1 |

## 15. Risks and fallbacks

| # | Risk | Likelihood | Impact | Mitigation | Fallback if it happens |
|---|---|---|---|---|---|
| R-1 | **Day 5 integration overruns** — the async conversion touches four pages and is the single largest change of the week | High | Demo fails | Contract frozen Day 1; module signatures preserved; start with `TimerPage` (the demo spine) and leave `ProfilePage` last | Demo with `TimerPage` + `HistoryPage` on the API and Profile/Settings still local; state it plainly rather than hiding it |
| R-2 | **Array-save mapping is messier than expected** (`saveTasks(items)` → REST) | Medium | Half a day | Decide the mapping on Day 1, not Day 5 | Ship one bulk-replace endpoint per collection for week 1; note it as debt |
| R-3 | **Cross-site cookie not sent** after deploying to two hosts — login appears to succeed then behaves as logged-out | High if unplanned | Blocks everything | The `/api/*` proxy in D4-T4, verified against the deployed API on Day 6 | Same-origin proxy is already the fallback; if it fails, host the API behind the same domain |
| R-4 | **Cold start on a sleeping tier** makes the first demo request take several seconds | Medium | Looks broken | Warm the health endpoint immediately before the demo (D7-T4) | Keep a tab open on the API; or pay for a warm instance for demo week |
| R-5 | **Timezone bugs in the timeline** put evening sessions in the wrong day bucket | Medium | Charts look wrong on stage | Bucket by the user's local day (D3-T5) and test with a non-UTC timezone | Demo the daily view only; fix after |
| R-6 | **Seed data does not reproduce the live title unlock** | Medium | Loses the best demo moment | Verify on Day 5 (D5-T5) and after every reset (D7-T3) | Adjust the seeded total; worst case, demo the unlock from the seeded account's existing titles |
| R-7 | **Scope creep from `product_analysis.md`** — removing the penalty, reason capture, day-streaks | High | Days lost | Frozen on Day 1; explicitly P2 in §16 | Say no. The analysis is next week's work |
| R-8 | **Stack learning curve** consumes Days 2–3 | Medium | Cascading slip | D1-T2 mandates familiar, boring tools | Fall back to the stack with the least unfamiliarity, even if it is second-best on paper |
| R-9 | **Deployment discovers a blocker on Day 6** | Medium | One day lost | Day 6 exists for exactly this and is deliberately under-scheduled | Demo from a laptop against the deployed database; disclose it |
| R-10 | **Data loss during a redeploy** (ephemeral storage, or a migration that drops) | Low | Catastrophic on stage | Managed datastore; migrations as an explicit step; restore verified (D6-T5) | Re-seed with D7-T3 and continue |

## 16. Deferred P2 work

Not in this week. Each line carries the trigger for picking it up.

| Item | Why deferred | Pick up when |
|---|---|---|
| Password reset by email | Needs an email provider and a token flow; no demo step touches it | Immediately after demo week — a forgotten password currently means permanent account loss, which is unacceptable for a product promising permanence |
| Email verification | The field exists nullable from Day 1; nothing depends on it | Before any email-based feature |
| Termination-reason capture UI + insights | The field is recorded from Day 1; the UI and analysis are a feature, not plumbing | When `product_analysis.md`'s repositioning is adopted |
| Day-streaks and streak freezes | Replacing the session-streak is a product change mid-build week | Right after demo week; it is the highest-leverage retention mechanic available |
| Removing the −200 penalty | A product decision the demo currently showcases | With the reason-capture work; they are one change |
| Data export / import | No demo step; important for trust | Before any real user relies on the app |
| Offline session queueing | A 25-minute interaction will meet a network drop, but the demo is online | When real users appear |
| Session-end notifications and sound | Frontend work, not backend | Same time as day-streaks |
| Scheduling execution (reminders) | The settings blob persists a schedule that nothing reads — unchanged this week | After notifications exist |
| Task estimation calibration | New field, new UI, no demo step | Post-demo feature work |
| File uploads (avatars, custom backgrounds) | Backgrounds are already curated presets; nothing needs storage | Only when a user can actually upload something |
| Caching, queues, background jobs, read replicas | No measured need at any plausible near-term scale | When something is measurably slow |
| Admin tooling, social features, teams | Far outside current scope | When the product decides to go there |

## 17. Final demo-readiness checklist

Run this the morning of the demo.

**Infrastructure**
- [ ] Health endpoint returns healthy over HTTPS on the public URL
- [ ] Frontend loads on the public URL; `/api/*` proxy resolves to the live API
- [ ] Database reachable; migrations at the expected version
- [ ] Backend warmed (health endpoint hit within the last few minutes)

**Data**
- [ ] Demo reset run; demo account at exactly 900 lifetime points, streak 2
- [ ] 8 weeks of history present; daily, weekly and monthly views all populate
- [ ] No leftover tasks or sessions from rehearsal
- [ ] The sign-up email intended for the live demo is **not** already registered

**Functionality — walk the nine steps**
- [ ] Sign up succeeds with a fresh account
- [ ] Log in with those credentials succeeds
- [ ] Task creates and appears
- [ ] A 1-minute session completes; points increase by the server-decided amount
- [ ] "The Anchor" unlocks live with a visible notification
- [ ] Termination deducts points, floors at zero, resets the streak, records `terminated`
- [ ] History summary, timeline and outcomes all render real data
- [ ] Settings and profile changes persist
- [ ] Refresh preserves state; a second browser shows the same data
- [ ] Log out blocks protected pages

**Safety**
- [ ] No console errors on any page in the demo path
- [ ] No stack trace or internal detail reachable from the UI
- [ ] Another user's data is not reachable (spot-check one identifier)
- [ ] Recovery notes to hand; reset command tested and ready
- [ ] Deployed build matches the tagged frozen commit
