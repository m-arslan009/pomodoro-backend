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
