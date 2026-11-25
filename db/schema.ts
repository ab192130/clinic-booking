import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["staff", "doctor"]);
export const bookingStatus = pgEnum("booking_status", ["booked", "cancelled"]);

export const doctors = pgTable("doctors", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRole("role").notNull(),
    doctorId: integer("doctor_id").references(() => doctors.id, {
      onDelete: "restrict",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("users_username_unique").on(table.username),
    uniqueIndex("users_doctor_id_unique").on(table.doctorId),
    check(
      "users_role_doctor_consistency",
      sql`(${table.role} = 'doctor' AND ${table.doctorId} IS NOT NULL) OR (${table.role} = 'staff' AND ${table.doctorId} IS NULL)`,
    ),
  ],
);

export const slots = pgTable(
  "slots",
  {
    id: serial("id").primaryKey(),
    doctorId: integer("doctor_id")
      .notNull()
      .references(() => doctors.id, { onDelete: "restrict" }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("slots_doctor_starts_at_unique").on(
      table.doctorId,
      table.startsAt,
    ),
  ],
);

export const bookings = pgTable(
  "bookings",
  {
    id: serial("id").primaryKey(),
    slotId: integer("slot_id")
      .notNull()
      .references(() => slots.id, { onDelete: "restrict" }),
    bookingReference: text("booking_reference").notNull(),
    patientName: text("patient_name").notNull(),
    contact: text("contact").notNull(),
    status: bookingStatus("status").default("booked").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("bookings_booking_reference_unique").on(
      table.bookingReference,
    ),
    uniqueIndex("bookings_active_slot_unique")
      .on(table.slotId)
      .where(sql`status = 'booked'`),
  ],
);
