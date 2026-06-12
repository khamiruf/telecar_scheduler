-- Telecar initial schema.
-- users: the whitelist. A Telegram id present here is authorized.
-- car_status: single row (id = 1) holding the car's current location.
-- bookings: reservations as [starts_at, ends_at) unix-second ranges.

CREATE TABLE users (
  telegram_id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE car_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  level TEXT NOT NULL,
  updated_by INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(telegram_id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (ends_at > starts_at)
);

CREATE INDEX idx_bookings_range ON bookings (starts_at, ends_at);
