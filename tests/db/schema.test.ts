import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestClient, truncateTables } from "./helpers";

const db = createTestClient();

type ColumnRow = {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
};

async function getColumns() {
  return db<ColumnRow[]>`
    select table_name, column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema = 'public'
      and table_name in ('doctors', 'users', 'slots', 'bookings')
    order by table_name, ordinal_position
  `;
}

async function insertDoctor(name = "Dr. Example") {
  const [row] = await db<{ id: number }[]>`
    insert into doctors (name) values (${name}) returning id
  `;
  return row.id;
}

async function insertSlot(
  doctorId: number,
  startsAt = new Date("2030-01-01T09:00:00.000Z"),
) {
  const [row] = await db<{ id: number }[]>`
    insert into slots (doctor_id, starts_at)
    values (${doctorId}, ${startsAt})
    returning id
  `;
  return row.id;
}

async function insertBooking(slotId: number, reference: string) {
  const [row] = await db<{ id: number }[]>`
    insert into bookings (slot_id, booking_reference, patient_name, contact)
    values (${slotId}, ${reference}, 'Patient Example', '555-0100')
    returning id
  `;
  return row.id;
}

async function cancelBooking(id: number) {
  await db`
    update bookings
    set status = 'cancelled', cancelled_at = now()
    where id = ${id}
  `;
}

async function expectPostgresError(
  operation: PromiseLike<unknown>,
  code: "23503" | "23505" | "23514",
  constraint?: string,
) {
  let thrown: unknown;

  try {
    await operation;
  } catch (error) {
    thrown = error;
  }

  expect(thrown, `expected PostgreSQL error ${code}`).toBeDefined();
  const postgresError = thrown as {
    code?: string;
    constraint_name?: string;
  };
  expect(postgresError.code).toBe(code);
  if (constraint) {
    expect(postgresError.constraint_name).toBe(constraint);
  }
}

beforeEach(async () => {
  await truncateTables(db);
});

afterAll(async () => {
  await db.end();
});

describe("database structure", () => {
  it("creates the four contract tables", async () => {
    const tables = await db<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('doctors', 'users', 'slots', 'bookings')
      order by table_name
    `;

    expect(tables.map((table) => table.table_name)).toEqual([
      "bookings",
      "doctors",
      "slots",
      "users",
    ]);
  });

  it("uses timestamptz for appointment and audit timestamps", async () => {
    const columns = await getColumns();
    const dataTypes = new Map(
      columns.map((column) => [
        `${column.table_name}.${column.column_name}`,
        column.data_type,
      ]),
    );

    for (const column of [
      "doctors.created_at",
      "users.created_at",
      "slots.created_at",
      "slots.starts_at",
      "bookings.created_at",
      "bookings.cancelled_at",
    ]) {
      expect(dataTypes.get(column), column).toBe("timestamp with time zone");
    }
  });

  it("creates the role and status enums with exactly the contract values", async () => {
    const values = await db<{ typname: string; enumlabel: string }[]>`
      select type.typname, enum.enumlabel
      from pg_type type
      join pg_enum enum on enum.enumtypid = type.oid
      join pg_namespace namespace on namespace.oid = type.typnamespace
      where namespace.nspname = 'public'
        and type.typname in ('user_role', 'booking_status')
      order by type.typname, enum.enumsortorder
    `;

    expect(values).toEqual([
      { typname: "booking_status", enumlabel: "booked" },
      { typname: "booking_status", enumlabel: "cancelled" },
      { typname: "user_role", enumlabel: "staff" },
      { typname: "user_role", enumlabel: "doctor" },
    ]);
  });

  it("enforces the required nullability", async () => {
    const columns = await getColumns();

    for (const [table, column] of [
      ["doctors", "name"],
      ["users", "username"],
      ["users", "password_hash"],
      ["users", "role"],
      ["slots", "doctor_id"],
      ["slots", "starts_at"],
      ["bookings", "slot_id"],
      ["bookings", "booking_reference"],
      ["bookings", "patient_name"],
      ["bookings", "contact"],
      ["bookings", "status"],
      ["bookings", "created_at"],
    ]) {
      const row = columns.find(
        (candidate) =>
          candidate.table_name === table && candidate.column_name === column,
      );
      expect(row, `${table}.${column}`).toBeDefined();
      expect(row?.is_nullable, `${table}.${column}`).toBe("NO");
    }

    for (const [table, column] of [
      ["users", "doctor_id"],
      ["bookings", "cancelled_at"],
    ]) {
      const row = columns.find(
        (candidate) =>
          candidate.table_name === table && candidate.column_name === column,
      );
      expect(row?.is_nullable, `${table}.${column}`).toBe("YES");
    }
  });

  it("creates restrict foreign keys for every relationship", async () => {
    const foreignKeys = await db<
      {
        constraint_name: string;
        table_name: string;
        column_name: string;
        foreign_table_name: string;
        foreign_column_name: string;
        delete_rule: string;
      }[]
    >`
      select
        table_constraints.constraint_name,
        table_constraints.table_name,
        key_columns.column_name,
        constraint_columns.table_name as foreign_table_name,
        constraint_columns.column_name as foreign_column_name,
        referential_constraints.delete_rule
      from information_schema.table_constraints table_constraints
      join information_schema.key_column_usage key_columns
        on key_columns.constraint_catalog = table_constraints.constraint_catalog
        and key_columns.constraint_schema = table_constraints.constraint_schema
        and key_columns.constraint_name = table_constraints.constraint_name
      join information_schema.constraint_column_usage constraint_columns
        on constraint_columns.constraint_catalog = table_constraints.constraint_catalog
        and constraint_columns.constraint_schema = table_constraints.constraint_schema
        and constraint_columns.constraint_name = table_constraints.constraint_name
      join information_schema.referential_constraints referential_constraints
        on referential_constraints.constraint_catalog = table_constraints.constraint_catalog
        and referential_constraints.constraint_schema = table_constraints.constraint_schema
        and referential_constraints.constraint_name = table_constraints.constraint_name
      where table_constraints.constraint_schema = 'public'
        and table_constraints.constraint_type = 'FOREIGN KEY'
      order by table_constraints.constraint_name
    `;

    expect(foreignKeys).toEqual([
      {
        constraint_name: "bookings_slot_id_slots_id_fk",
        table_name: "bookings",
        column_name: "slot_id",
        foreign_table_name: "slots",
        foreign_column_name: "id",
        delete_rule: "RESTRICT",
      },
      {
        constraint_name: "slots_doctor_id_doctors_id_fk",
        table_name: "slots",
        column_name: "doctor_id",
        foreign_table_name: "doctors",
        foreign_column_name: "id",
        delete_rule: "RESTRICT",
      },
      {
        constraint_name: "users_doctor_id_doctors_id_fk",
        table_name: "users",
        column_name: "doctor_id",
        foreign_table_name: "doctors",
        foreign_column_name: "id",
        delete_rule: "RESTRICT",
      },
    ]);
  });

  it("creates all named unique indexes, including the partial active-booking index", async () => {
    const indexes = await db<
      { index_name: string; is_unique: boolean; is_partial: boolean }[]
    >`
      select
        index_class.relname as index_name,
        pg_index.indisunique as is_unique,
        pg_index.indpred is not null as is_partial
      from pg_index
      join pg_class index_class on index_class.oid = pg_index.indexrelid
      join pg_class table_class on table_class.oid = pg_index.indrelid
      join pg_namespace namespace on namespace.oid = table_class.relnamespace
      where namespace.nspname = 'public'
        and index_class.relname in (
          'users_username_unique',
          'users_doctor_id_unique',
          'slots_doctor_starts_at_unique',
          'bookings_booking_reference_unique',
          'bookings_active_slot_unique'
        )
      order by index_class.relname
    `;

    expect(indexes).toEqual([
      {
        index_name: "bookings_active_slot_unique",
        is_unique: true,
        is_partial: true,
      },
      {
        index_name: "bookings_booking_reference_unique",
        is_unique: true,
        is_partial: false,
      },
      {
        index_name: "slots_doctor_starts_at_unique",
        is_unique: true,
        is_partial: false,
      },
      {
        index_name: "users_doctor_id_unique",
        is_unique: true,
        is_partial: false,
      },
      {
        index_name: "users_username_unique",
        is_unique: true,
        is_partial: false,
      },
    ]);
  });

  it("persists only the intended booking and account columns", async () => {
    const columns = await getColumns();
    const bookingColumns = columns
      .filter((column) => column.table_name === "bookings")
      .map((column) => column.column_name)
      .sort();
    const userColumns = columns
      .filter((column) => column.table_name === "users")
      .map((column) => column.column_name);

    expect(bookingColumns).toEqual([
      "booking_reference",
      "cancelled_at",
      "contact",
      "created_at",
      "id",
      "patient_name",
      "slot_id",
      "status",
    ]);
    expect(bookingColumns.some((column) => column.includes("reschedul"))).toBe(
      false,
    );
    expect(userColumns).toContain("password_hash");
    expect(userColumns).not.toContain("password");
  });
});

describe("user and slot constraints", () => {
  it("allows multiple staff users and a doctor user linked to one doctor", async () => {
    const doctorId = await insertDoctor();

    await db`
      insert into users (username, password_hash, role, doctor_id)
      values
        ('staff-one', '$2b$10$staffonehash', 'staff', null),
        ('staff-two', '$2b$10$stafftwohash', 'staff', null),
        ('doctor-user', '$2b$10$doctoruserhash', 'doctor', ${doctorId})
    `;

    const users = await db<{ username: string }[]>`
      select username from users order by username
    `;
    expect(users.map((user) => user.username)).toEqual([
      "doctor-user",
      "staff-one",
      "staff-two",
    ]);
  });

  it("rejects a staff user linked to a doctor", async () => {
    const doctorId = await insertDoctor();

    await expectPostgresError(
      db`
        insert into users (username, password_hash, role, doctor_id)
        values ('staff-user', '$2b$10$staffhash', 'staff', ${doctorId})
      `,
      "23514",
      "users_role_doctor_consistency",
    );
  });

  it("rejects a doctor user without a doctor", async () => {
    await expectPostgresError(
      db`
        insert into users (username, password_hash, role, doctor_id)
        values ('doctor-user', '$2b$10$doctorhash', 'doctor', null)
      `,
      "23514",
      "users_role_doctor_consistency",
    );
  });

  it("rejects a second doctor user for the same doctor", async () => {
    const doctorId = await insertDoctor();
    await db`
      insert into users (username, password_hash, role, doctor_id)
      values ('doctor-one', '$2b$10$doctoronehash', 'doctor', ${doctorId})
    `;

    await expectPostgresError(
      db`
        insert into users (username, password_hash, role, doctor_id)
        values ('doctor-two', '$2b$10$doctortwohash', 'doctor', ${doctorId})
      `,
      "23505",
      "users_doctor_id_unique",
    );
  });

  it("rejects duplicate usernames", async () => {
    await db`
      insert into users (username, password_hash, role)
      values ('staff-user', '$2b$10$firsthash', 'staff')
    `;

    await expectPostgresError(
      db`
        insert into users (username, password_hash, role)
        values ('staff-user', '$2b$10$secondhash', 'staff')
      `,
      "23505",
      "users_username_unique",
    );
  });

  it("allows equal start times for different doctors but not the same doctor", async () => {
    const firstDoctorId = await insertDoctor("Dr. One");
    const secondDoctorId = await insertDoctor("Dr. Two");
    const startsAt = new Date("2030-02-01T09:00:00.000Z");

    await insertSlot(firstDoctorId, startsAt);
    await insertSlot(secondDoctorId, startsAt);

    await expectPostgresError(
      insertSlot(firstDoctorId, startsAt),
      "23505",
      "slots_doctor_starts_at_unique",
    );
  });

  it("rejects a slot for a nonexistent doctor", async () => {
    await expectPostgresError(insertSlot(999_999), "23503");
  });
});

describe("booking constraints and persistence", () => {
  it("requires every booking to reference an existing slot", async () => {
    await expectPostgresError(insertBooking(999_999, "UNKNOWN-SLOT"), "23503");
  });

  it("rejects a second active booking for one slot", async () => {
    const slotId = await insertSlot(await insertDoctor());
    await insertBooking(slotId, "ACTIVE-ONE");

    await expectPostgresError(
      insertBooking(slotId, "ACTIVE-TWO"),
      "23505",
      "bookings_active_slot_unique",
    );
  });

  it("rejects duplicate public booking references", async () => {
    const firstSlotId = await insertSlot(await insertDoctor("Dr. One"));
    const secondSlotId = await insertSlot(await insertDoctor("Dr. Two"));
    await insertBooking(firstSlotId, "DUPLICATE-REFERENCE");

    await expectPostgresError(
      insertBooking(secondSlotId, "DUPLICATE-REFERENCE"),
      "23505",
      "bookings_booking_reference_unique",
    );
  });

  it("retains cancelled history and permits rebooking after each cancellation", async () => {
    const slotId = await insertSlot(await insertDoctor());

    for (const reference of ["HISTORY-ONE", "HISTORY-TWO", "HISTORY-THREE"]) {
      const bookingId = await insertBooking(slotId, reference);
      await cancelBooking(bookingId);
    }

    await insertBooking(slotId, "CURRENT-ACTIVE");

    const bookings = await db<{ status: string }[]>`
      select status from bookings where slot_id = ${slotId} order by id
    `;
    expect(bookings.map((booking) => booking.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "booked",
    ]);

    const active = await db<{ count: number }[]>`
      select count(*)::integer as count
      from bookings
      where slot_id = ${slotId} and status = 'booked'
    `;
    expect(active[0].count).toBe(1);
  });

  it("persists guest details and timestamps without a patient account", async () => {
    const slotId = await insertSlot(await insertDoctor());
    const cancelledAt = new Date("2030-03-01T10:30:00.000Z");

    const [booking] = await db<
      {
        booking_reference: string;
        patient_name: string;
        contact: string;
        status: string;
        created_at: Date;
        cancelled_at: Date;
      }[]
    >`
      insert into bookings (
        slot_id,
        booking_reference,
        patient_name,
        contact,
        status,
        cancelled_at
      )
      values (
        ${slotId},
        'PUBLIC-REFERENCE',
        'Guest Patient',
        'guest@example.test',
        'cancelled',
        ${cancelledAt}
      )
      returning
        booking_reference,
        patient_name,
        contact,
        status,
        created_at,
        cancelled_at
    `;

    expect(booking.booking_reference).toBe("PUBLIC-REFERENCE");
    expect(booking.patient_name).toBe("Guest Patient");
    expect(booking.contact).toBe("guest@example.test");
    expect(booking.status).toBe("cancelled");
    expect(booking.created_at).toBeInstanceOf(Date);
    expect(booking.cancelled_at).toBeInstanceOf(Date);
    expect(booking.cancelled_at.toISOString()).toBe(cancelledAt.toISOString());
  });
});
