# EGParts Backend Agent Contract

This file is mandatory reading before changing any backend route, service, or SQL.

## Runtime boundaries

- Active entrypoint: `server.js`.
- Active routes: `routes/`.
- Active services: `services/`.
- Active middleware: `middleware/`.
- Database changes: numbered files under `supabase_tabled-and-rows/` and the
  corresponding production migration.

## Unified Data Contract Protocol — Mandatory

The platform's repeated failures are contract mismatches between the frontend,
HTTP parser, route, service, and PostgreSQL. Every agent must preserve this flow:

```text
UI -> one API client -> validated route -> service -> Supabase schema/RPC
```

- Treat `Content-Type: application/json` as required for JSON requests. Reject or
  clearly report missing/invalid bodies instead of allowing an empty object to
  reach the database.
- Resolve tenant context on the server. Do not authorize or scope data from a
  browser-provided `store_id` alone.
- Maintain one canonical field and enum contract. Do not create parallel names,
  legacy aliases, or duplicate route/service implementations.
- Validate body, params, and query at the route boundary and return a safe 4xx
  with a stable `code` and Arabic/user-safe `message` for invalid input.
- Use one safe error envelope: `{ success, code, message, requestId, data }`.
  Log diagnostic fields (`code`, `details`, `hint`, correlation ID), never tokens,
  cookies, passwords, provider credentials, SQL secrets, or WhatsApp key/session
  objects.
- In PL/pgSQL, prefix parameters/variables (`p_`, `v_`) and qualify every column
  when output variables or parameters could share its name (`t.user_id`,
  `av.phone_e164`). Prefer explicit constraint names in `ON CONFLICT` when names
  can collide.
- Test the entire contract, not only JavaScript syntax: request headers, parsed
  body, service mapping, database constraints/RPC, response status, and UI state.
- For every production bug, add a regression test that reproduces the original
  boundary failure before marking the work complete.

Required verification commands:

```bash
node --check <changed-runtime-file>
npm run audit:contracts
```

For frontend/API changes, also run the frontend lint and production build. For
database changes, apply the migration to the correct Supabase project and run a
read-only or transaction-rolled-back verification query before handoff.
