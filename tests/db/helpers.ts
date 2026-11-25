import postgres from "postgres";

export const testPostgresPort = Number(process.env.TEST_PG_PORT ?? "55433");

export const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  `postgres://postgres:postgres@127.0.0.1:${testPostgresPort}/clinic_test`;

export function createTestClient() {
  return postgres(testDatabaseUrl, { max: 1 });
}

export async function truncateTables(
  client: ReturnType<typeof createTestClient>,
) {
  await client.unsafe(
    "truncate table bookings, slots, users, doctors restart identity cascade",
  );
}
