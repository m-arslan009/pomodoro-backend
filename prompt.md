# Prompt Log — Backend

Significant prompts affecting the direction, requirements, workflow, or implementation of the
Evergrove backend repository. Frontend prompts are logged separately in the frontend repository.

---

`Title`: Configure a backend pre-commit workflow

`User prompt`: Analyse this backend repository and design a production-ready pre-commit workflow. Do not implement anything until the analysis and plan are complete.

Project context: this is the backend repository of a larger application. The frontend exists in a separate Git repository with its own pre-commit hooks, tests, and CI/CD pipeline. The backend must remain independent and must not run frontend tests or depend on frontend tooling. Changes to backend APIs may require frontend updates, so maintain a stable and well-defined API contract.

Tasks: (1) analyse the current backend structure, architecture, tooling, scripts, tests, and existing quality checks; (2) recommend the best pre-commit architecture, explaining why each tool is appropriate; (3) design a fast workflow that executes only the necessary checks for staged backend files (formatting, linting, type checking, unit tests, integration tests where appropriate, security checks); (4) list every configuration file that should be created or modified, with its purpose; (5) recommend which checks belong in pre-commit, pre-push, and CI/CD, with reasons; (6) explain how backend API changes should be managed to minimise breaking changes for the frontend repository without introducing direct repository dependencies; (7) identify performance optimisations, common pitfalls, and best practices; (8) produce an implementation roadmap ordered by dependency with clear completion criteria.

Expected output: a Markdown document covering current project analysis, recommended tooling and architecture, backend pre-commit workflow, configuration and file plan, backend testing strategy, API contract considerations, CI/CD responsibilities, risks/best practices/performance recommendations, and a step-by-step implementation roadmap. Do not generate configuration files or implementation code until the planning phase has been completed and approved.

---

`Title`: Backend prompts logged in the backend repository

`User prompt`: create prompt.md inside backend as each prompt of backend will be separated and written in backend/prompt.md

---

`Title`: Husky pre-push validation gate

`User prompt`: Configure automatic backend validation before every `git push` in this existing NestJS repository. Use a Husky `pre-push` hook, not a full `pre-commit` test suite. Commit-message validation is already configured, so do not modify commitlint, `.husky/commit-msg`, commit scopes, or existing commit rules.

First inspect the repository's `package.json`, existing Husky hooks, test scripts, TypeScript config, Vitest config, and CI workflow. Reuse the existing setup instead of replacing it.

The pre-push flow must run sequentially: `npm run typecheck`, `npm test`, `npm run build`. Use the actual existing unit-test script if it differs from `npm test`. Add a reusable script such as `"verify": "npm run typecheck && npm test && npm run build"`, then configure `.husky/pre-push` to run it, echoing "Running pre-push validation...", cancelling the push on failure, and echoing "Pre-push validation passed." on success.

Requirements: stop immediately when type checking, tests, or build fails; block the push with a non-zero exit code; preserve the original error output; do not run watch-mode tests; do not run file-modifying commands such as `eslint --fix` or `prettier --write`; keep the hook compatible with POSIX `sh` and Git Bash on Windows; do not require globally installed tools; do not run `npm install` inside the hook; do not make PostgreSQL, Docker, integration tests, or E2E tests mandatory; if an existing E2E script is available, it may optionally run only when `EVERGROVE_PREPUSH_E2E=1`; preserve all existing hooks and package scripts unless a minimal change is necessary; if CI already exists, make it run the same `npm run verify` command because hooks can be bypassed with `git push --no-verify`.

---

`Title`: Design the User model and authentication data structure

`User prompt`: Design the User model and authentication-related data structure. Do not start coding
or modifying any files yet — first analyse the existing project requirements and design the correct
model based on actual application needs. Review only the relevant frontend files (user profile
information, login/signup flows, authentication state, user-related UI components, features that
depend on user data, existing assumptions about user information) plus the product idea and
requirements. Then: design the User model required for authentication; identify required fields and
why each exists; identify optional fields and their purpose; identify fields that should not exist
and why; check whether the frontend expects data that should not belong in the User model; and
identify anything missing for a production-ready authentication system. Consider future requirements
— authentication, user profiles, roles and permissions, feature unlocking, progression, statistics,
achievements, account security — and decide what belongs in the user entity, what belongs
separately, whether additional entities are required, and how the model supports future expansion.
Stop after presenting the design and wait for approval before implementing anything.

**Outcome — the boundary this established.** `users` holds *identity and credentials only*: fields
the user asserts that the system cannot derive. Everything derived, high-frequency, or rebuildable
lives elsewhere — live sessions in `auth_sessions`, preferences in `user_settings`, progression in
the `user_gamification` projection, history in the `focus_sessions` event log. Explicitly rejected
as `users` columns: points/streaks/titles, roles, settings, session tokens, failed-login counters,
avatar assets, and denormalised counts. Rationale and the full field-by-field justification are in
[`../backend_architecture.md`](../backend_architecture.md) §21 and ADR-006/008/010/015.

---

`Title`: Approved authentication and User model refinements

`User prompt`: Implement the approved authentication and User model refinements from the previous
analysis. Review the backend structure, frontend authentication assumptions, architecture documents,
and existing decisions first, for consistency. Approved decisions: (1) **Login identifier** — allow
login with either email or username through a single identifier field; the backend detects the
identifier type securely and prevents user enumeration through response differences.
(2) **Username casing** — preserve the original username for display, add a normalised lowercase
field for case-insensitive uniqueness, and update validation, the database model, and related logic.
(3) **Email verification preparation** — add the model/database support for future email
verification without implementing the full workflow, keeping later implementation possible without
redesign. (4) **Password policy** — replace composition-based rules with a length-first policy with
defined minimum and maximum limits, keeping frontend and backend validation aligned. Update all
affected layers (models, migrations, DTOs, validation, services, APIs, and frontend assumptions
where necessary) while maintaining separation of concerns: the User entity stores identity
information only; authentication/session data stays separate; progression, points, titles and
statistics stay separate from the User entity. Avoid unnecessary complexity and follow the approved
architecture decisions. Show the files to be changed, the purpose of each change, and any migration
or compatibility concerns before modifying code, and wait for approval.

**Reasoning behind each decision.**

1. **Login identifier.** `LogInPage.jsx` authenticates by *username*, while account recovery
   (ADR-009) is keyed on *email* — so a user who forgets their username has no way back in. One
   `identifier` field removes that dead end. Type detection is unambiguous rather than heuristic:
   usernames are constrained to `[A-Za-z0-9_]`, so a value containing `@` can only be an email.
2. **Username casing.** §21 normalised usernames to lowercase at the boundary, which destroys the
   casing of a handle the UI renders publicly as `@username` (`ProfilePage.jsx:252`). Storing the
   username as typed alongside a normalised `username_lower` preserves the handle while keeping
   uniqueness case-insensitive — and avoids the `citext` extension that ADR-003 already rejected.
3. **Email verification preparation.** `email_verified_at` ships nullable and unused from day one so
   verification later is a pure addition rather than a behavioural migration. Nothing may gate on it
   until the flow exists.
4. **Password policy.** Composition rules (letter + digit + special) push users toward predictable
   substitutions without adding real entropy; current guidance favours length. A **maximum** is not
   cosmetic: it bounds Argon2 CPU per request, and ADR-008 names bcrypt as the fallback hasher,
   which silently truncates at 72 bytes.

**Constraints for future backend development.**

- The User entity stays identity-only. Adding a derived, per-session, or per-request-written column
  to `users` is a design regression — see the boundary in the previous entry.
- `username_lower` is an invariant, not a convenience field: it is maintained in the repository
  layer *and* enforced by a database `CHECK`, so no writer can desynchronise it.
- Authentication responses must not vary by failure cause. One generic message for a bad identifier
  and a bad password, and the password verify must run even when no user matches, so response
  timing does not enumerate accounts either.
- Password rules live in one place per side and must stay numerically identical across the
  boundary: `PASSWORD_MIN_LENGTH` / `PASSWORD_MAX_LENGTH` on both. The same applies to the username
  charset and length. A client rule looser than the server's produces a form that passes and then
  fails.
- Entitlements (titles, unlocked features) are a product rule computed in the gamification domain
  and returned for display. They must never be evaluated in a guard or otherwise become an
  authorization boundary (ADR-010).

---

`Title`: Design the complete database schema before implementation

`User prompt`: The analysis phase is complete — move to the database design phase. Design the
complete data model and schema for the backend based on the approved architecture, product
requirements, frontend behaviour, and previous design decisions. Treat the database schema as the
foundation of the application, prioritising correctness, maintainability, scalability, performance
and future extensibility over simply supporting the current feature set. Design the domain first,
then the schema; give each model a single well-defined responsibility; keep it normalised unless
denormalisation has a clear measurable benefit; clearly separate identity, authentication,
authorization, preferences, business data, projections and analytics; store only authoritative
data and avoid persisting derivable values without a justified performance requirement; design
relationships that represent business rules while maintaining referential integrity; choose
appropriate primary keys, foreign keys, unique constraints, indexes, cascade behaviours, defaults
and nullable fields; design for expected query patterns, reporting needs and future growth; avoid
premature optimisation and unnecessary abstractions; and minimise future breaking migrations while
keeping today's design simple. For every model give its responsibility, why it exists, every field
with justification, relationships, constraints and indexes with reasoning, database-level business
rules, and rejected alternatives. Review the schema as a whole for redundant models or fields,
missing entities, incorrect relationships, normalisation violations, performance bottlenecks,
future migration risks, and opportunities to simplify. Challenge the design before finalising it.
Do not optimise only for authentication — design a cohesive schema for the complete product vision
that stays practical for the current phase. Present the whole schema with reasoning and trade-offs,
then wait for approval before generating migrations or writing implementation code.

**Rules this phase established for the schema.**

- **The event log is the only authority for progression.** `user_gamification` is a projection and
  must be reproducible by replaying the interval log. Any column that cannot be recomputed from the
  log is a design defect.
- **Derived values are not stored** unless they are either (a) in a hot `GROUP BY`, or (b) dependent
  on a mutable input whose later change must not silently rewrite history. `streak_day` on the log
  is the only field admitted under (b); `unlocked_titles` was removed for failing both.
- **Timezone is an interpretation key, not a preference.** It lives on `users` because every stored
  timestamp for that account is read through it, and changing it requires rebuilding day
  attribution.
- **Enums are native Postgres enums**, not `text` + `CHECK`: with Prisma the former generates typed
  unions while the latter degrades to `string` plus migration SQL the ORM cannot see. Adding a value
  is a non-blocking `ALTER TYPE ADD VALUE`; removing one is not, so values are retired, not deleted.
- **Every table carries `user_id` directly** rather than reaching its owner through a join chain, so
  ADR-010's ownership predicate stays a single `WHERE` clause and a future `workspace_id`
  generalisation touches one layer.
- **In-flight timer state stays on the client** in v1. The server records only finished intervals;
  cross-device resume is a named future feature, not an accidental omission.

## Switch authentication from opaque session tokens to JWT

`Title`: Reopen ADR-008 and implement JWT-based login on the backend

`User prompt`: Implement the complete end-to-end authentication login flow by first analysing both
the frontend and backend codebases, existing architecture, API contracts, folder structure,
environment configuration, and current authentication implementation before making any changes. On
the backend, verify and complete all login-related functionality, including authentication service,
validation, password verification, JWT generation, secure error handling, CORS, and response
format. Ensure the application remains type-safe, modular, and maintainable. Preserve the existing
UI, styling, tests, and architecture wherever possible, update only what is necessary, verify the
complete login flow from submission to authenticated navigation, fix any integration issues
discovered during implementation, document all changes, and ensure both frontend and backend remain
synchronised with no hardcoded values or duplicate logic.

**Decision this prompt settled.** The analysis surfaced that the login flow was already complete
and used opaque session tokens in an httpOnly cookie, with ADR-008 recording "No JWT". Presented
with that conflict and a recommendation to keep cookies, the user chose to **switch to JWT**,
accepting the loss of instant revocation and the XSS exposure of a JS-reachable token.

**Design that followed.** Two tokens: a short-lived HS256 access token (15 min) in the response
body and sent as `Authorization: Bearer`, plus the existing opaque token retained as a rotating
refresh credential in the httpOnly cookie. No Prisma schema change and no migration — `auth_sessions`
is reused as-is. A rotated session inherits its predecessor's `absolute_expires_at`, so refreshing
cannot extend the 30-day hard ceiling. `JWT_SECRET` has no default and is rejected below 32
characters.

---

`Title`: Remove the refresh-token mechanism — single stateless JWT

`User prompt`: Simplify the backend authentication by removing the refresh token mechanism
completely. Use a single JWT access token with a reasonable expiration time. When the access token
expires, the user must log in again — do not implement token refresh, silent re-authentication,
token rotation, or any background renewal logic. Update the authentication flow, middleware,
endpoints, services, configuration, and tests accordingly while keeping the existing login
functionality intact. Keep the architecture clean, maintainable, and production-ready, but
prioritise simplicity over unnecessary complexity. Before making changes, analyse the current
authentication flow and provide a concise implementation plan for approval. After approval,
implement the changes, remove obsolete refresh-token code and configuration, provide a summary of
modified files, behavioural changes, and any breaking changes.

**Decisions this prompt settled.** This reverses the refresh half of the entry above, on the same
day. Three follow-up choices were put to the user and answered:

1. **Token lifetime → 8 hours.** 15 minutes existed only because refresh did; without it that
   value would log users out mid-session. The same dial governs how long a stolen token stays
   usable, and there is no setting good at both.
2. **`POST /auth/logout` kept, `POST /auth/logout-all` removed.** Logout is now a client-side
   discard the server only acknowledges; keeping it avoids a frontend break. `logout-all` was
   deleted rather than left advertising a guarantee a stateless design cannot keep.
3. **No `iat` vs `password_changed_at` check** — offered as a three-line, zero-extra-query way to
   keep "changing your password signs out other devices", and explicitly declined in favour of a
   pure stateless design. Consequence: a password change does not invalidate tokens already issued
   elsewhere, for up to the full 8 hours.

**Scope.** `auth_sessions` dropped by a destructive migration; refresh endpoint, rotation, cookie
service, cookie parser, session token hashing and the session-lifetime domain module all deleted.

---

`Title`: Align backend auth test coverage with the verified frontend flows

`User prompt`: The backend uses pre-push test enforcement, so do not run the backend test suite.
Review the existing backend authentication tests and verify that coverage aligns with the core
authentication functionalities implemented and verified on the frontend. Focus test coverage on:
user registration, user login, logout/session invalidation (if implemented on backend), request
validation, authentication success responses, authentication failure responses, error handling, and
loading/state-related API behaviour where backend responses affect frontend states. Identify any
missing, outdated, duplicate, or irrelevant tests. Add or update only the necessary tests required
to cover these core authentication flows. Do not add advanced scenarios or unnecessary edge cases
outside the current authentication scope. Do not modify production code unless tests reveal a
genuine implementation issue.

**Outcome.** Three layers had no coverage at all: the request DTOs (`registerSchema`, `loginSchema`,
`changePasswordSchema`), the `ZodValidationPipe` that turns a schema failure into the 422 the
sign-up form renders, and the `ProblemDetailsFilter` that produces the RFC 9457 body the frontend's
`toApiError()` parses. Specs added for all three. No production code changed and no test executed —
the suite is left for the pre-push hook, so the new specs are typechecked and linted but unrun.

---

`Title`: Establish CONTRACT.md as the shared profile contract and define a phased, frontend-first workflow

`User prompt`: The profile analysis and implementation roadmap have already been completed and approved. Do not repeat the analysis or create another implementation plan. Instead, use the existing plan as the basis for execution.

Before implementing any profile changes, update CONTRACT.md to become the shared contract for the profile feature across both the frontend and backend repositories. Record all agreed profile decisions, including the data model, supported profile fields (including timezone), validation rules, API request/response contracts, authentication and ownership rules, error handling, frontend/backend responsibilities, state synchronisation expectations, implementation constraints, deferred features, and any relevant ADR references. This document should define the expected behaviour so both repositories remain consistent throughout development.

Also add an Implementation Strategy section describing how profile work will be executed: implement one phase at a time; complete the frontend portion first, then update the backend only as required to satisfy the agreed contract; after each phase, verify the complete flow before moving to the next; do not implement future phases until the current phase is complete and approved; any change to a feature, function, API, model, validation rule, or behaviour must be reflected in CONTRACT.md before implementation so both repositories stay aligned.

Do not implement any code in this step. Only update CONTRACT.md so it serves as the authoritative reference for all subsequent profile development.

---

`Title`: Implement the backend profile feature enhancement from CONTRACT.md

`User prompt`: Implement the Backend Profile Feature Enhancement according to the specifications defined in CONTRACT.md. The contract document is the single source of truth for all profile-related requirements, API behaviour, data models, validation rules, and architectural decisions. Do not analyse or modify frontend code. Do not redesign existing behaviour.

Implement the required backend profile enhancements, including: existing profile update functionality alignment; required profile fields and validation; timezone support if defined in the contract; profile image upload/update functionality if defined in the contract; secure ownership handling using the authenticated user identity; and correct API responses and error handling according to existing project conventions.

For profile image functionality: follow only the storage and architecture decisions defined in CONTRACT.md; implement upload/update handling as specified; validate image input according to the contract; ensure users can only modify their own profile image; maintain existing behaviour when no image exists.

Implementation rules: keep the existing authentication flow unchanged; do not add refresh tokens or unrelated authentication features; do not introduce unnecessary endpoints or abstractions; do not refactor unrelated modules; do not create test cases in this phase; keep the implementation simple and consistent with the current backend architecture.

## Phase 4 (backend) — core profile test cases

`Title`: Write backend test cases for the implemented profile feature

`User prompt`: Write backend test cases only for the implemented Profile feature. The backend already has pre-push test enforcement configured, so do not run the test suite and do not modify any pre-push configuration.

Focus exclusively on the profile module and its directly related files. Do not analyse, modify, or refactor unrelated modules, features, or authentication functionality unless a profile test has a direct dependency on them.

Review the existing profile implementation and CONTRACT.md, then create or update only the tests required to cover the implemented profile behaviour. Cover the core profile functionality: fetch authenticated user's profile; update supported profile fields; profile image upload/update; profile image retrieval behaviour; timezone update; request validation; authentication and ownership checks; successful profile updates; error responses for invalid input; error responses for unauthorised or forbidden access; image validation (size/type); existing behaviour when no profile image exists.

Do not write tests for: the authentication module (login, registration, logout); future or deferred profile features; unrelated controllers, services, or repositories; performance, load, or end-to-end tests.

Reuse the existing backend testing patterns and utilities. Keep the test suite simple, maintainable, and aligned with the current implementation. Avoid duplicate tests, unnecessary abstractions, excessive comments, or production code changes unless a genuine defect preventing the implemented profile behaviour is discovered.

## Settings phase — feature analysis and planning

`Title`: Analyse and plan the Settings feature against CONTRACT.md

`User prompt`: Analyse `product_analysis.md`, `backend_architecture.md`, and `CONTRACT.md` to create the implementation plan for the Settings feature.

`CONTRACT.md` is the single source of truth for frontend-backend communication. Any feature behaviour, API contract, data model, validation rule, endpoint definition, or implementation decision must follow `CONTRACT.md`. If `product_analysis.md` or `backend_architecture.md` conflicts with `CONTRACT.md`, identify the conflict and recommend the required update instead of silently choosing an approach.

Do not implement any code, modify files, or create tests in this phase. The objective is only analysis, architectural review, and planning.

Do not blindly follow the existing implementation. Evaluate the best approach based on product requirements, current architecture, maintainability, simplicity, scalability where required, and consistency between frontend and backend. Identify what should be kept, updated, replaced, removed, and added.

Determine: what belongs inside Settings and what should remain part of Profile, Authentication, or other modules; which features are required for the current product version and which should be deferred; correct architectural decisions that should remain unchanged; decisions needing improvement; over-engineered or unnecessary functionality; missing requirements; conflicting requirements.

Define the backend design plan, including for every Settings operation: HTTP method, complete endpoint URL, purpose, authentication requirement, request body/query parameters, response structure, validation rules, and possible error responses. Review the data model for required entities, fields, relationships, reusable models, and fields that should be removed or avoided.

Identify all required updates to `CONTRACT.md` before implementation: new endpoints, request/response contracts, data models, validation rules, frontend/backend responsibilities, error handling rules, and deferred features.

Create a phased execution plan where each phase includes goal, frontend tasks, backend tasks, contract updates required, files expected to change, dependencies, manual verification steps, and completion criteria. Implement one phase at a time; keep frontend and backend synchronized through `CONTRACT.md`; do not implement functionality that is already complete and correctly aligned; reuse existing functions, components, services, and patterns; only update code when it is incomplete, inconsistent, or violates the agreed architecture; do not create tests during implementation planning; avoid unnecessary complexity, abstractions, comments, or unrelated refactoring; do not introduce features outside the agreed scope.

## Settings phase — record the contract

`Title`: Write the Settings contract as the shared reference

`User prompt`: write/update CONTRACT.md as a source of reference for both frontend and backend

## Reusable Claude Skills — analysis and first increment

`Title`: Introduce reusable Claude Skills for repetitive workflows

`User prompt`: Analyze our previous conversations and identify repetitive workflows that are performed frequently throughout this project. The goal is to reduce prompt size, improve consistency, and eliminate repeated instructions by introducing reusable Claude Skills.

Phase 1 — Analysis: identify recurring tasks that are performed repeatedly across multiple conversations, follow a predictable sequence of steps, require similar instructions every time, would significantly reduce tokens if encapsulated into a reusable skill, and are generic enough to work for future features. Do not propose skills for one-off or highly specific tasks. For each repetitive workflow provide: workflow name, why it is repetitive, typical sequence of actions, estimated frequency, estimated token savings, and priority (High / Medium / Low).

Phase 2 — Draft Skills: for each proposed skill include skill name, purpose, when Claude should invoke it, inputs, outputs, scope, responsibilities, things explicitly out of scope, dependencies on other `.claude` resources, and estimated prompt reduction. Keep every draft single-responsibility, token-efficient, generic, easy to compose with other skills, and independent whenever possible.

Candidate areas to recommend only if the conversation history justifies them: feature analysis and planning; contract-first development; frontend implementation workflow; backend implementation workflow; frontend/backend synchronization; verification before completion; cleanup and dead-code removal; architecture consistency review; test implementation workflow; documentation updates; prompt recording; phase-based implementation planning; manual verification checklist generation.

Deliverables: repetitive workflows; recommended skill hierarchy; draft specification for each skill; skills that should be merged; skills that should not be created because they would duplicate existing instructions; recommended implementation order (highest ROI first).

Do not create any skills yet. Do not create the `.claude/skills` directory yet. Do not create any skill files. Do not modify project code or documentation. Wait for explicit approval before implementing any skill.

Then, on approval: implement first increment (i.e. create skills that have priority: High).

## Settings phase — S2 backend implementation

`Title`: Implement the Settings feature backend, auditing existing code first

`User prompt`: Implement the backend for the Settings feature by first analyzing the existing codebase to identify whether any part of this feature has already been implemented. If existing implementation, models, APIs, services, or related logic are present, review and update them according to the current requirements and project architecture; otherwise, implement the complete backend functionality from scratch following the existing coding standards, patterns, and best practices used in the project.

Ensure all required backend components such as database models, migrations/schema changes, DTOs, services, controllers, validation, authentication/authorization handling, and API endpoints are properly integrated. Do not create any test cases at this stage; only focus on complete and production-ready implementation of the Settings feature backend.

## Settings phase — S4 backend coverage

`Title`: Verify existing Settings backend coverage before creating any tests

`User prompt`: Verify whether test cases for the backend Settings feature have already been created. First, inspect the existing backend test suite and identify any tests that cover the Settings feature. If such tests exist, do not create new ones; instead, provide a concise summary of each test case, including the functionality it validates (e.g., GET settings, PATCH settings, validation, authentication/authorization, persistence, error handling, etc.), along with any important gaps or missing coverage. If no Settings feature tests exist, create a comprehensive test suite following the project's existing testing patterns and standards, covering all backend functionality, success and failure scenarios, validation, authorization. Before creating any tests, ensure they do not duplicate existing coverage, and implement only the missing test cases required for complete coverage.

## Timer phase — T0 feature planning

`Title`: Design the Timer's backend surface as part of one authoritative cross-project plan

`User prompt`: Where backend support is required, design or refine the necessary API endpoints, request/response contracts, validation rules, authentication requirements, and data models, ensuring they align with the overall project architecture. Verify that the frontend and backend can be fully synchronized using this plan, eliminate any contract mismatches, and define the source of truth for timer state, synchronization, persistence, recovery, and conflict resolution. The final output should serve as the implementation blueprint that both frontend and backend will follow, ensuring feature parity, consistency, scalability, and long-term maintainability before any implementation begins.

## Timer phase — T0 backend scope narrowed to Timer's core responsibilities

`User prompt`: The backend should only support the Timer's core responsibilities (such as persistence, synchronization, recovery, and user-specific state), while History should derive its information from Timer-generated session records rather than communicating with the backend directly. If backend changes or new endpoints are required to support this architecture, design them with the goal of keeping History completely backend-agnostic.

## Timer phase — T2 scope expanded to Task CRUD

`Title`: Design the task management endpoints and model changes CRUD requires

`User prompt`: Update the approved Timer feature implementation plan to incorporate Task CRUD operations. If the current plan requires architectural, data model, API contract, or synchronization changes to support task management, update the plan accordingly while preserving the previously approved design decisions. The result should clearly define frontend responsibilities, backend responsibilities, data flow, and any required endpoints or model changes before implementation begins.

## Timer phase — T2/T3 backend implementation

`Title`: Build the Timer backend as the source of truth for persisted sessions

`User prompt`: Implement the backend for the Timer feature according to the approved architecture and implementation plan, treating the backend as the source of truth for persisted timer sessions, not for real-time timer execution. Before implementation, analyze the existing backend to identify any Timer-related code and refactor or reuse it where appropriate instead of creating duplicate implementations. Design the backend so that it handles only meaningful persistence and business logic, including completed sessions, terminated sessions (with termination reason when applicable), active session recovery if required, cross-device synchronization where beneficial, task-session association, session validation, analytics-ready data, and any other persistence required by the approved architecture. Implement the necessary database models, migrations, repositories, services, DTOs, controllers, validation, authentication/authorization, and API endpoints to support this design. Ensure every completed or terminated session produces a canonical session record that becomes the single source of truth for History and Analytics, allowing those features to derive their data without requiring additional History-specific backend logic. Where architectural decisions are not explicitly defined in the approved plan, choose the approach that minimizes network traffic, reduces backend complexity, improves scalability, and preserves a responsive user experience. Remove obsolete or incomplete implementations, avoid duplicate business logic, and update shared API contracts and models so the frontend and backend remain fully synchronized. Do not create or run any test cases unless explicitly requested by the user.

## Timer phase — T5 backend coverage

`Title`: Create the backend test suite for the Timer feature

`User prompt`: Create a comprehensive backend test suite for the Timer feature based on the approved architecture, API contract, and final implementation.

## Test execution policy

`Title`: Tests are never run by the agent; the pre-push hook owns execution

`User prompt`: You are not supposed to run test cases. It will be handled when pushing the code. I have already configured pre-push testing. Just write test cases as per the rules and skills.

## History phase — backend verification

`Title`: Verify whether History requires any backend work

`User prompt`: Inspect the backend implementation to determine whether the History feature requires any backend changes based on the approved architecture, implementation plan, and updated CONTRACT.md. Do not assume additional backend work is needed. Instead, verify whether the existing Timer backend already provides all the data and APIs required by the History feature. Since the approved design states that History is primarily a frontend concern that derives its data from persisted Timer sessions, confirm that the backend already exposes sufficient session data, filtering, pagination, sorting, and related metadata for the frontend to function correctly. If the backend fully satisfies the approved design, do not introduce new History-specific business logic, services, models, or endpoints; confirm that no backend implementation is required and document the verification results. If any gaps are discovered that prevent the frontend from implementing the approved History functionality, implement only the minimal backend changes necessary to support the approved architecture. Do not duplicate Timer business logic or create a separate persistence layer for History. Any backend updates must keep Timer as the single source of truth for session data with History as a read-only consumer, reusing existing repositories, services, DTOs, controllers, and database models. If changes are made, update the API contract accordingly.

## Avatar removal — DELETE /me/avatar

`Title`: Remove the avatar through the correct API, handling no existing avatar and failures

`User prompt`: implement avatar removal feature by using existing avatart and profile architecture. … on confirm, remove the avatar by calling the correct API. handle all states such as success, loading, error, no existing avatar. … on error keep the avatar untouch. there is new file you can also refer about this feature which is Implementation_gap_report.md

## Streak Freeze — backend

`Title`: Implement the Streak Freeze backend on the existing gamification and lazy day-streak resolution architecture

`User prompt`: Now implement backend of Streak Freeze feature, using existing gamification and lazy
day-streak resolution architecture. Use the existing gamification fields already present in the
schema. Do not introduce duplicate freeze state unless the existing model is insufficient for a
required behavior.

## Streak Freeze — backend test coverage

`Title`: Cover the Streak Freeze streak rules with high-value tests derived from the contract

`User prompt`: Create backend tests for the implemented Streak Freeze feature. Focus only on high-value
tests that verify the core streak rules. Do not attempt to cover every internal branch or
implementation detail. Derive expected behavior from CONTRACT.md and the existing gamification
rules. Test observable domain and persistence behavior, not private methods.

## Feature gating — remove the title-based unlocking system completely

`Title`: Remove title-based feature unlocking; every feature available to every authenticated user

`User prompt`: Remove the title-based feature unlocking system completely. All product features must
be available to every authenticated user regardless of title, level, points, streak, or gamification
progress. Use the appropriate project skills for conflict handling, contract updates, implementation,
verification, and testing. Do not bypass documented decisions silently.

[On the decision-conflict prompt: chose full removal across both projects — the gate component, hook,
helpers, and `TITLES[].feature` in both mirrors — and chose to keep titles themselves as identity and
progression.]

## Session persistence — refresh token in an HttpOnly cookie

`Title`: Keep users signed in across reloads via a refresh token in an HttpOnly, Secure, SameSite cookie

`User prompt`: Update the application's authentication flow so users remain signed in and can resume
their session after refreshing or reopening the page. On application startup, check for an existing
authenticated session and, when the access token is missing or expired, automatically request a new
access token using the refresh token. Store the refresh token securely in an HttpOnly, Secure, and
SameSite cookie rather than localStorage, and keep the access token in memory where possible.

[Collided with ADR-008 revision 2 (single stateless JWT, no refresh token, no cookie, a reload signs
the user out), which the user had chosen explicitly on 2026-07-29. Raised as a decision conflict; the
user confirmed the supersession. Recorded as ADR-008 revision 3 — revision 1 reinstated. Chose a
DB-backed rotating opaque refresh token over a stateless signed refresh JWT, so revocation is real.
Also chose in scope: rotation reuse-detection, change-password revoking other sessions, and an
unguarded cookie-driven logout. Deferred: refetch-on-focus for long-lived tabs, and `logout-all`.
Out of scope: the Netlify production rewrite — local dev only.]

[Shipped in two phases. A0 recorded the supersession and amended CONTRACT.md before any code landed.
A1 reinstated `auth_sessions` in the shape `20260729120000_drop_auth_sessions` destroyed, plus a
CHECK that the idle window never outlives the ceiling; added `domain/auth-session.ts` (pure — the
`Math.min` that makes every rotated successor inherit its predecessor's `absolute_expires_at`),
`auth-session.repository.ts`, `refresh-token.service.ts`, `common/utils/cookies.ts`, and
`POST /auth/refresh`; made `logout` unguarded and cookie-driven; set CORS `credentials: true`; added
`req.headers.cookie` and `res.headers["set-cookie"]` to the Pino redaction list. Three decisions were
made during implementation rather than in planning: `changePassword` revokes **every** session and
immediately opens a fresh one for the caller, rather than sparing the caller's — a mistaken exclusion
would leave a session alive across a password change, where a mistaken revocation costs one sign-in;
the login-time purge keeps revoked rows for a whole idle window, because reuse detection reads them;
and `REFRESH_THROTTLE` is 20/min rather than reusing `CREDENTIAL_THROTTLE`, since a 429 from
`/auth/refresh` is not a 401 and would eject a signed-in user. `JWT_ACCESS_TTL_MS` moved 8 h → 15 min
in A2, not A1, so no phase boundary shipped a shorter window without the renewal that hides it. No
new production dependency: `res.cookie` is native Express, so `cookie-parser` was replaced by a
ten-line header reader. Verified against a live database — rotation, replay killing the family,
indistinguishable 401s, logout revoking for real, ten rotations leaving the ceiling unchanged, and
no cookie value in the logs at `LOG_LEVEL=debug`.]

## Google sign-in — OAuth 2.0 + OpenID Connect

`Title`: Add server-side OIDC Authorization Code Flow with PKCE alongside password authentication

`User prompt`: Review the existing authentication system and prepare a detailed implementation plan
for adding OAuth 2.0 authentication to the application. Inspect the current backend authentication
flow, including login, logout, access-token handling, refresh-token handling, session restoration,
protected routes, user storage, API middleware, cookies, and environment configuration. Identify the
application's framework, authentication libraries, database structure, deployment environment, and
any existing OAuth-related code. Determine whether OpenID Connect is also required for user
authentication and identity information. The plan should cover the recommended OAuth 2.0
authorization flow, preferably Authorization Code Flow with PKCE where appropriate, the selected
identity providers, redirect and callback routes, state and nonce validation, PKCE generation and
verification, secure token exchange, user profile retrieval, account creation and linking, handling
users with the same email address, access-token and refresh-token storage, token rotation, logout
and provider revocation, protected API access, error handling, CSRF protection, XSS risks, cookie
security, required scopes, environment variables, database changes, and provider configuration.
Include the API endpoints required, database migrations, security considerations, testing strategy,
and rollout approach. Do not generate or change application code until the plan has been reviewed
and approved.

[Settled: **server-side confidential-client flow** rather than SPA-side PKCE, so `client_secret`
never leaves the server and the browser never holds a code, verifier or provider token; **Google
only**; **auto-link an existing account only when `email_verified` is true**; **link/unlink
management in scope**. PKCE `S256` is applied despite the client secret, because OAuth 2.1 / RFC 9700
require it universally — it defends against code injection, which a secret does not.]

[Collided with ADR-008's recorded deferral of social login and with `week_plan.md`'s out-of-scope
list. Raised as a decision conflict and confirmed. Recorded as **ADR-008a** rather than an ADR-008
revision: the session layer is untouched, and that is enforced rather than hoped for — the callback
calls the same `AuthService.startSession()` as `login`, so rotation, reuse detection, the ceiling and
`JwtGuard` are all unmodified. ADR-008 had already specified this exact path (*"a new
`auth_identities` table and a new controller action"*), so the ADR records a deferral ending, not a
choice reversing.]

[**Zero new production dependencies**, which was the deciding factor on flow shape. The exchange is a
server-to-server call over TLS authenticated with `client_secret`, so OIDC Core §3.1.3.7 permits
validating the ID token's claims without fetching JWKS or verifying its signature — removing the only
requirement that would have needed `openid-client` or `jose`. Global `fetch`, `node:crypto` and the
already-present `@nestjs/jwt` cover the rest. No provider token is stored at all: `access_type=online`
means none is issued, so there is no rotation, encryption-at-rest or revocation story to build.]

[One defect identified during planning and scheduled into the phase that creates it, not after:
`pino-http` logs `req.url`, and the callback URL carries `?code=…&state=…`, so every successful
sign-in would write a live authorization code into the application log. Recorded as CONTRACT.md §9.5.]

## Google sign-in — governance before implementation

`Title`: Update governance, architecture, contract, and prompt history before any OAuth code is written

`User prompt`: Review the complete OAuth 2.0 + OpenID Connect (Google) Implementation Plan. Do not
modify application code, backend services, Prisma schema, migrations, environment files,
dependencies, or tests during this task. The objective is to update the project's governance,
architecture, contract, and prompt-history files so that the Google OAuth implementation can begin
without contradicting existing recorded decisions.

[Phase O0, executed as documentation only — no schema, migration, service, or `.env` file was
touched. `backend_architecture.md` gains ADR-008a in full (options, decision, impact, revisit-when)
plus amendments to ADR-008's rejected-OAuth option, its "separation worth stating explicitly"
paragraph, and ADR-009's "social login as the recovery path" line, which is **still rejected** —
`set-password` is a stopgap for a different population, not password reset shipping early.]

## Google sign-in — backend implementation (O1 + O2)

`Title`: Implement the Google OAuth 2.0 + OIDC backend, entirely server-driven

`User prompt`: Implement the Evergrove Google OAuth 2.0 and OpenID Connect backend exactly
according to oauth_implementation_plan.md. Before writing implementation code, confirm that the
earlier decision to defer social login has been formally superseded, preserve the historical
decision rather than deleting it, and ensure every new endpoint, request shape, response shape,
status code, error code, authentication requirement, and redirect behaviour is documented in
CONTRACT.md. Implement Google as the only supported provider. Keep the OAuth flow entirely
backend-driven: the backend must generate the authorization request, receive Google's callback,
exchange the authorization code, validate the OpenID Connect identity, resolve the Evergrove
account, create or link the identity, create the normal Evergrove session, and redirect the browser
back to the frontend.

[Phases O1 and O2. `auth_identities` plus a nullable `users.password_hash`; `domain/oauth.ts` for
PKCE, `state`/`nonce`, ID-token claim validation and profile derivation; three services and one
controller for the two redirect routes; `GET /auth/providers`; and the §9.7 logging fix, which was a
live defect rather than hardening — `pino-http` logs `req.url`, and the callback URL carries a
redeemable authorization code. **Zero new production dependencies**: `node:crypto` for PKCE, global
`fetch` for the exchange, `@nestjs/jwt` for the transaction cookie, and no signature check on the ID
token because it arrives over a TLS-authenticated back-channel (OIDC Core §3.1.3.7). The session
layer is untouched — the callback calls the same `AuthService.startSession()` the password path
does, which is the property ADR-008a was built to preserve. Link management (§4.14–§4.17) stays in
O4, so the link branch of §4.12.1 is specified but not yet reachable.]

## Periodic email reporting — proposal before plan

`Title`: Design a periodic email report delivered as a PDF attachment, proposal first

`User prompt`: Examine the Evergrove codebase and project documentation to design and implement a
periodic email-reporting feature that sends each eligible user a weekly or monthly report as a PDF
attachment. Do not begin implementation or write a final implementation plan immediately. Before
planning the implementation, prepare a PDF-format proposal for discussion. Explain exactly what
information the report could contain based only on data that already exists in the application.
Propose the document structure, including title page or compact header, reporting-period label,
summary section, tables, charts, empty-state messaging, page numbers, footer, Evergrove branding,
locale-aware dates and numbers, timezone display, and accessibility considerations. Compare the
appropriate server-side PDF-generation approaches available in the existing technology stack, such
as HTML-to-PDF rendering or a programmatic PDF library, and explain the operational, security,
deployment, font, styling, performance, and maintenance trade-offs. Do not select a PDF library
until the existing runtime and deployment restrictions have been examined. The report must not
depend on loading untrusted remote assets while rendering, and temporary PDF files must not remain
on disk longer than necessary. Create a dedicated section listing every unresolved, conflicting, or
non-confirmed product and technical decision that must be answered before implementation. At
minimum, clarify whether users receive weekly reports, monthly reports, or may choose either; the
default frequency; whether the feature is opt-in or enabled automatically; who is eligible; where
the preference is managed; whether users can pause or disable reports; the delivery day and local
delivery time; how the start of the week is determined; whether monthly reports represent calendar
months or rolling periods. After presenting the PDF proposal and unresolved-decision register, stop
and request explicit confirmation. Do not silently choose defaults for disputed or unspecified
behaviour. Once the decisions have been confirmed, produce a phased implementation plan before
changing code. The plan should preserve the current application architecture and include database or
preference changes, API contracts, scheduler design, report-period calculation, deterministic data
aggregation, PDF rendering, email composition and attachment delivery, idempotency records, retries,
observability, security, configuration, migrations, rollout, rollback, and testing.

[Proposal delivered as `email_reporting_proposal.pdf` at the repository root, with its HTML source
beside it. No application file, schema, dependency, or configuration was touched. The register runs
to 34 items and three of them are collisions with locked decisions rather than gaps: ADR-014 (no
load-bearing scheduler — its own revisit trigger names digests), the 2026-07-31 aggregation
supersession (server-side statistics were deleted, not deferred), and ADR-009's unmade mail-provider
decision, which blocks sending entirely and must be answered once for both features. `CONTRACT.md`
§11's `Mailer` port and `POST /auth/forgot-password` remain the shape any provider choice has to fit.]

## Periodic email reporting — six confirmed decisions (A1, A2, A3, P3, P5, L3)

`User prompt`:

A1 — Email provider and mail abstraction. Create a provider-neutral Mailer interface. Use Resend
through native fetch in production. Use a console adapter in local development. Use a recording fake
in automated tests. Keep provider-specific features inside the adapter.

A2 — Scheduling and job processing. Use an external scheduler because the application may be asleep.
The scheduler should start a small report worker. Store pending, successful, failed, and retryable
deliveries in the database. Do not introduce pg-boss or a managed queue yet. Add a full queue later
when background jobs become more numerous or complex. Schedule: run daily or weekly if everyone
receives reports at one global time; run hourly if users receive reports according to their own
timezone.

A3 — Report calculations. Create a private, pure TypeScript report-calculation module. Fetch the
required records through the repository. Calculate statistics in application memory. Do not create
/stats/rollups yet. Do not use SQL aggregation yet. Make the email report and History page follow the
same counting rules. Test both using the same example fixtures.

P3 — How users enable reports. Reports should not be automatically enabled. During signup, let new
users choose weekly, monthly, or no email reports. Do not automatically subscribe existing users.
Show existing users a one-time in-app invitation. Provide controls in Settings. Include unsubscribe
and change-frequency links in every email.

P5 — Where report preferences are stored. Use a dedicated `report_subscriptions` table storing
frequency (weekly or monthly), status, delivery day, timezone, pause information, bounce information,
and confirmation state. Use a separate `report_deliveries` table for individual report deliveries.

L3 — Sending to unverified email addresses. Never send private reports to an unverified
password-account email. Google users with a Google-confirmed email may activate reports immediately.
Password users must click a confirmation link before reports begin. Confirmation links must be
single-use, time-limited, securely generated, and stored as hashes. Build full account email
verification later as part of password-reset work. Bounce handling: first hard bounce disables the
subscription immediately; a temporary soft bounce is retried a limited number of times; repeated
temporary failures pause the subscription.

[These six close register items A1, A2, A3, P3, P5, L3 outright, and settle P1 (user's choice),
P6 (pause exists), D4 (bounce policy), L2 (unsubscribe link in every email), A9 (re-derive from
`focus_sessions`) and A10 (the frontend gains signup choice, invitation, Settings controls, and
confirm/unsubscribe pages) by implication. Three supersessions still need recording before code:
ADR-014 (a scheduler now exists), the 2026-07-31 aggregation supersession (the server computes
statistics again, for its own use only), and ADR-009 (the mail provider is chosen — Resend behind the
`Mailer` port, which unblocks password reset too).]

## Email reports — backend, and `unsubscribed` as a real state

`User prompt`: Implement the backend for the Email Reports feature. Implement the provider-neutral
Mailer port with a Resend production adapter using native fetch, a console adapter for local
development, and a recording fake for tests. Add the required validated environment variables.
Create the documented `report_subscriptions` and `report_deliveries` models, migrations,
repositories, and services. Do not duplicate the user timezone in the subscription — read
`users.timezone` when determining report periods and delivery times. Support the documented
subscription states, including declined, pending confirmation, active, paused, unsubscribed, and
bounced. Treat a missing subscription row as never asked, not as an error, and ensure the
preference-read endpoint returns a valid response for users without a row. Allow authenticated users
to read their preference, choose weekly or monthly, decline or disable, change frequency, resend
confirmation where allowed, and pause or resume where documented. Write a DECLINED row when the user
explicitly chooses no reports. For Google accounts with a provider-confirmed address, allow
activation according to the documented rules. For unverified password accounts, create a pending
subscription and require the documented single-use, expiring email-confirmation flow before
activation.

[Phase R1 + R2. Two decisions are settled by this prompt rather than by the plan. **`unsubscribed`
is now a sixth stored status**, distinct from `declined` — one is an answer given before anything was
sent, the other an answer given by somebody who was receiving reports and stopped; `CONTRACT.md`
§23.1's open question is closed accordingly. And **the signup answer moved out of
`POST /auth/register`** (§25.7 amended): applying it there would have required a circular module
dependency between AuthModule and ReportModule, and would have put an outbound confirmation email
inside the transaction creating the account. It is a follow-up `PUT /me/reports` from the client, so
there is one implementation of the L3 activation rule rather than two. The worker, the aggregation
and the PDF are still R4/R5 and were not built.]

## Email reports — completing the backend (R4 + R5)

`User prompt`: Complete the remaining backend work for the Email Reports feature — the pure report
aggregation logic, the shared aggregation fixtures, weekly and monthly totals following the same
rules as the frontend History feature; the PDF renderer using pdfmake as selected in ADR-021,
supporting weekly and monthly reports with the documented period, summary totals, timezone,
generated-at timestamp, charts, task information and footer, handling empty activity, long task
titles, Unicode, large datasets, multiple pages and page breaks, and exposing no internal database
IDs, API keys, confirmation tokens, unsubscribe tokens, provider metadata, or another user's
information; the hourly report worker and signed Resend webhook, where the worker finds due weekly
and monthly subscriptions, uses users.timezone, safely claims delivery records, prevents duplicate
sends per user and period, calculates the report, generates the PDF, sends through the existing
Mailer port, and records attempts, provider IDs, successes and failures, retrying only temporary
failures and never resending messages Resend has already accepted merely because delivery is
delayed; and where the webhook verifies signatures from the raw request body, processes events
idempotently, handles delivered, delayed, failed, suppressed, bounced and complained events, and
stops future reports after a permanent bounce or complaint. Add focused worker and webhook tests,
run all existing checks, and provide a safe manual command that sends exactly one test report to an
explicitly supplied database user using --user-id or TEST_REPORT_USER_ID plus --confirm-send, never
choosing or sending to multiple users, displaying only the user ID, masked email, verification and
subscription status, frequency, timezone and report period, refusing unverified addresses unless
explicitly authorized for testing, and never exposing secrets, full tokens, or complete unsubscribe
links.

[R4 and R5. Three things the implementation forced and that are recorded rather than absorbed. The
**unsubscribe token is now derived** — `HMAC(JWT_SECRET, "report-unsubscribe:<userId>")` — because a
hashed column and a link that must keep working in year-old email cannot both hold with a random
token the worker has no way to reproduce (§23.3 amended). A **complaint records `unsubscribed`**
rather than §25.6's original `declined`, now that the two states exist. And **`report_webhook_events`
was added** as a second migration, because idempotent webhook processing needs somewhere to record
what it has seen and the soft-bounce counter is the one effect that is not naturally idempotent.
`pdfmake` is the first new production dependency since the project began; ADR-021 chose it. §30
records what is verified and what is not — nothing has been sent to a real inbox and no PDF has been
read by a human.]

`Title`: Use Gmail SMTP as the mail transport

`User prompt`: use gmail smtp — i generated app password for gmail smtp. define variables required
for smtp in .env file so that i can place values there. using iqbalarslan009@gmail.com, send report
of the user on same gmail.

[Asked for after Resend refused `MAIL_FROM=iqbalarslan009@gmail.com` twice with HTTP 403 — Resend
only sends from a DNS-verified domain, and `gmail.com` can never be one. The alternatives were laid
out (wait for domain verification; `onboarding@resend.dev`, which only delivers to the Resend account
owner; or SMTP) and SMTP was chosen deliberately. This **supersedes ADR-009's explicit refusal of
`nodemailer`**, recorded in `locked_decisions.md` with its costs: no delivery webhooks, so §25.6
bounce handling does not run; no provider message id; a ~500/day Gmail cap; and a translation layer
for the retry ladder, because SMTP 4xx is transient and 5xx permanent — the inverse of the HTTP
statuses `decideRetry` reads. To be deleted when the Resend domain verifies.]


`Title`: Scope auth test coverage to real behaviour, not field validation

`User prompt`: Review and refine only the test cases for password-based sign-up and login. OAuth is
completely out of scope for this task. For sign-up, keep only tests that verify the actual working of
the feature, such as successful registration, persistence of the new user, secure password hashing,
successful session creation if registration logs the user in, rejection when the email is already in
use, rejection when the username is already in use, and any other meaningful business, database, or
security failure that would prevent registration from working correctly. Remove or consolidate small
input-field validation tests, such as separate cases for empty fields, character lengths, formats,
individual invalid values, or minor DTO validation rules, unless they protect a critical security
requirement that cannot be covered elsewhere. For login, keep only tests that verify real
authentication behavior, such as successful login with correct credentials, rejection for an
incorrect password, rejection when the account does not exist, correct generic failure responses that
do not reveal whether an email is registered, password-hash verification, and correct session, token,
or cookie creation defined by the contract. Remove tests focused only on minor field validation, empty
inputs, formatting variations, DTO decorators, controller forwarding, mocked method calls, or internal
implementation details. Keep at least one real-database integration or E2E test that signs up a new
user and then logs in using the same email and password.

[A standing coverage standard for the auth surface, not a one-off cleanup: a test earns its place by
proving a behaviour the feature depends on, and per-field validation counts only where it is itself
the security control. It cut 54 cases to 35 and produced the project's first e2e spec,
`test/auth.e2e-spec.ts`, which is also the first coverage of the two facts no fake can assert — what
`password_hash` actually holds, and that the 409 comes from the UNIQUE index rather than a pre-check.
Two gaps the old suite had are now closed: nothing asserted the password was hashed before it reached
the repository, and nothing asserted the refresh half of the session either flow returns.]


`Title`: Add an ADMIN role alongside USER — capability analysis and phased plan

`User prompt`: Use only `CONTRACT.md`, `backend_architecture.md`, `.claude/locked_decisions.md`, and
`product_analysis.md` to understand the application and create a plan for adding an `ADMIN` role
alongside `USER`. Password and OAuth authentication already exist and must remain compatible.
First, briefly discuss realistic Admin capabilities such as viewing/searching users, viewing limited
account details, disabling/reactivating accounts, deleting users, revoking sessions, viewing system
statistics, reviewing audit/security events, assigning roles, and managing limited system settings.
Group them into minimal, balanced, and advanced scopes, compare effort, value, security risk,
database impact, frontend impact, and test burden, then recommend the best scope for this project.
After selecting the recommended scope, create a phased implementation plan. Design all required Admin
endpoints, including method, path, purpose, required role, request data, response shape, validation,
errors, pagination/filtering, and audit requirements. Also cover the role field and migration,
default `USER` assignment, first Admin creation, guards/decorators, ownership rules,
disabled-account behavior, token/session handling, Admin frontend pages, audit logging, security
controls, affected modules, testing strategy, rollout, and acceptance criteria.
Public sign-up, OAuth sign-in, profile updates, and normal user APIs must never allow users to assign
or change their own role. Admins must never access passwords, hashes, refresh tokens, OAuth secrets,
or other credentials. Do not write code; provide only the capability analysis, recommended scope,
endpoint design, and implementation plan.

[Fires ADR-010's own revisit trigger — *"an admin surface appears… that is the point at which RBAC can
be designed against reality rather than guesswork"* — and therefore reopens three settled positions:
`CONTRACT.md` §12 (*"RBAC. There are no roles."*), `backend_architecture.md` §0.4 (admin back-office
listed as a v1 non-goal), and the one-line rule that no route in the product accepts another user's
id (§25.8, ADR-010). The two hard constraints in the instruction — role is never client-assignable on
any public path, and no admin surface may expose credential material — are what the endpoint and DTO
design are built around.]


`Title`: Ship only the role field needed to see the admin frontend work

`User prompt`: Update only the backend user schema/auth data needed to support the new role field so
we can visually test the admin frontend. Add a `role` field to the user model/schema with allowed
values `user` and `admin`, defaulting to `user`. Ensure all existing users are assigned
`role = 'user'`, except the existing user with email [REDACTED], which must be assigned
`role = 'admin'`. Make the minimum required migration/data update so this user can log in normally
using the application's existing login flow and the returned authenticated `UserProfile` includes
`role: 'admin'`. Other users should receive `role: 'user'`. Do not create a separate admin login
flow, change passwords, modify authentication/session behavior, add admin APIs, or change any
unrelated backend/frontend functionality. The only purpose of this change is to let that account log
in as an admin so we can visually verify the already-built admin navigation and pages. Keep all
existing login behavior unchanged apart from exposing the new `role` field.

[Cuts `admin_role_plan.md`'s phase G1 down to its display half and defers the rest: the column, its
CHECK, one targeted UPDATE, and `role` on `UserProfile` — but no `disabled_at`, no `AdminGuard`, no
`/admin` namespace, no audit table, and no change to any auth path. It settles what the frontend's
role check currently means: `role === 'admin'` chooses navigation and nothing more, with no
server-side counterpart behind it, which is recorded in `CONTRACT.md` §2.4 and against the amended
§12 non-goal so nothing is later built on the assumption that the field is enforced.]


## Admin Users API — the read half of the admin namespace

`Title`: Add GET /admin/users behind JwtGuard + AdminGuard, list read only

`User prompt`: Implement only the backend API required for the Admin Users page. Add
`GET /api/v1/admin/users` and protect it with the existing `JwtGuard` and `AdminGuard`, so only users
with `role = 'admin'` can access it. Non-admin users should receive `404`. The endpoint should
support these optional query parameters: `q`, `role`, `status`, `cursor`, and `limit`. `q` should
perform a prefix search against normalized email and username fields. `role` should accept `user` or
`admin`, `status` should accept `active` or `disabled`, and `limit` should allow 1–100 with a default
of 50. Use cursor-based pagination on `(created_at, id)` ordered by `created_at DESC`; do not use
offset/page-number pagination. Return only the explicit user summary fields required by the frontend
(id, email, username, firstName, lastName, role, status, emailVerified). `status` should be derived
from `disabled_at`. Do not return passwords, hashes, tokens, OAuth-sensitive fields, session details,
task/focus-session contents, or any other credential/private information. Do not add `lastSeenAt` to
the list response. Use the existing project architecture and conventions for DTO validation,
repositories, services, controllers, error handling, and response types. Keep the endpoint
read-only; no audit event is required for this GET request. Do not implement user detail,
disable/reactivate, session revocation, role changes, audit-events API, stats API, or any frontend
changes in this task.

[Opens the `/api/v1/admin` namespace, which `CONTRACT.md` §2.4 had explicitly ruled out — so §2.4 is
amended rather than left contradicted, and `role` stops being display-only for the first time.
Establishes three positions the rest of `admin_role_plan.md` will build on: authorization is
`AdminGuard` reading the role off the row `JwtGuard` just re-read (never a token claim), the
namespace answers 404 rather than 403 so it stays invisible to a non-admin, and the response is an
explicit allow-list type that no credential-bearing row can be passed to. Adds `users.disabled_at`
as a read-only column — `status` is derived from it and nothing writes it, because disable and
reactivate are not in scope.]

## Post-login navigation must follow the authenticated role

Fix the post-login navigation so users are redirected according to their authenticated role.
Currently, when an admin logs in successfully, the application navigates to the normal user Timer
page. This is incorrect. After authentication is completed and the authenticated `UserProfile` is
available, determine the destination from `user.role`. For `role === 'admin'`, navigate to the admin
landing page `/admin`. For `role === 'user'`, preserve the existing normal-user behavior and
navigate to the Timer page or whatever current default user route is already used. Make sure this
works consistently for every authentication/hydration path that can result in a logged-in user,
including normal login and any existing session restore/refresh flow where a default redirect is
performed. Do not create separate admin authentication logic or duplicate auth state; use the
existing authenticated user and its role as the source of truth.

[The backend half of a request that reads as a frontend one. Google sign-in ends in a server-issued
redirect, so it is the only session-opening path the client cannot route — and `CONTRACT.md` §2.4
had recorded that as a deliberate gap in which every admin using Google landed on `/timer`. Closing
it moves the default from `start` to `callback`: the start DTO now records "nothing was asked for"
as `NO_RETURN_TO` instead of substituting `/timer`, because at that moment nobody has authenticated
and there is no account whose landing page could be chosen. `resolveReturnTo` takes the role and is
called after `startSession`, so the redirect is decided from the same `UserProfile` the password
flow returns. `/admin` joins `ALLOWED_RETURN_TO`, which grants nothing — `AdminGuard` is still what
refuses a non-admin.]
