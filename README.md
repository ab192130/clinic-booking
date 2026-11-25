# clinic-booking

## Reporting bugs

Found a bug? Please [open an issue](https://github.com/ab192130/clinic-booking/issues) and include:

- The version you are using.
- The steps to reproduce the problem.

## Database development

Install the pinned dependencies with `npm ci`. Copy `.env.example` to `.env` and
set `DATABASE_URL` to the Postgres database you want to migrate.

- `npm run db:generate` regenerates the checked-in Drizzle migration from
  `db/schema.ts` when the schema changes.
- `npm run db:migrate` applies the checked-in migrations to `DATABASE_URL`.
- `npm test` runs the schema integration suite against a fresh, temporary
  embedded Postgres cluster; no external database or Docker is required.
- `npm run typecheck` checks the TypeScript sources.

Set `TEST_PG_PORT` to change the embedded cluster's default port (`55433`), or
`TEST_DATABASE_URL` to run the suite against a disposable external Postgres
database instead. The suite applies the migrations and truncates the contract
tables between tests, so never point it at a database containing data you need.
