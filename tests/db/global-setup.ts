import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import EmbeddedPostgres from "embedded-postgres";
import postgres from "postgres";
import { testDatabaseUrl, testPostgresPort } from "./helpers";

export default async function globalSetup() {
  let cluster: EmbeddedPostgres | undefined;

  try {
    if (!process.env.TEST_DATABASE_URL) {
      if (
        !Number.isInteger(testPostgresPort) ||
        testPostgresPort < 1 ||
        testPostgresPort > 65535
      ) {
        throw new Error("TEST_PG_PORT must be an integer between 1 and 65535.");
      }

      cluster = new EmbeddedPostgres({
        databaseDir: mkdtempSync(join(tmpdir(), "clinic-pg-")),
        user: "postgres",
        password: "postgres",
        port: testPostgresPort,
        persistent: false,
        autoRehydrateSymlinks: true,
      });

      await cluster.initialise();
      await cluster.start();
      await cluster.createDatabase("clinic_test");
    }

    const client = postgres(testDatabaseUrl, { max: 1 });
    try {
      await migrate(drizzle(client), {
        migrationsFolder: resolve("drizzle"),
      });
    } finally {
      await client.end();
    }
  } catch (error) {
    if (cluster) {
      await cluster.stop().catch(() => undefined);
    }
    throw error;
  }

  return async () => {
    await cluster?.stop();
  };
}
