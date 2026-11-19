/** MIGRATIONS[i] is migration i + 1. Each runs in one transaction with the kv update. */
export const MIGRATIONS: readonly string[] = [
  // Migration 1: the SQL of design 9.2, character for character.
  `CREATE TABLE events (
  id          INTEGER PRIMARY KEY,
  spool_name  TEXT UNIQUE,              -- NULL for observed events
  time_ns     INTEGER NOT NULL,
  kind        TEXT NOT NULL,            -- start | end | observed
  detail      TEXT NOT NULL,            -- see 5.3; '' for observed
  raw_detail  TEXT,                     -- source / reason as received
  session_id  TEXT NOT NULL,
  boot_id     TEXT NOT NULL,
  pid         INTEGER NOT NULL,
  proc_start  INTEGER,                  -- NULL when /proc could not be read
  cwd         TEXT,
  argv        TEXT,                     -- JSON array; start and observed only
  name        TEXT,
  payload     TEXT                      -- hook input as received (start/end only)
);
CREATE INDEX events_by_process ON events (boot_id, pid, time_ns, id);
CREATE INDEX events_by_session ON events (session_id, time_ns, id);

CREATE TABLE session_meta (
  session_id  TEXT PRIMARY KEY,
  label       TEXT,
  group_name  TEXT,
  note        TEXT,
  done_at_ns  INTEGER,
  created_ns  INTEGER NOT NULL,
  updated_ns  INTEGER NOT NULL
);

CREATE TABLE links (
  event_id      INTEGER PRIMARY KEY REFERENCES events(id),
  from_session  TEXT NOT NULL,
  to_session    TEXT NOT NULL,
  kind          TEXT NOT NULL,          -- clear | switch | fork
  time_ns       INTEGER NOT NULL
);
CREATE INDEX links_to ON links (to_session);

CREATE TABLE transcripts (
  path             TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL,
  size_read        INTEGER NOT NULL,
  file_size        INTEGER NOT NULL,
  mtime_ns         INTEGER NOT NULL,
  first_cwd        TEXT,
  entrypoint       TEXT,
  ai_title         TEXT,
  custom_title     TEXT,
  first_record_ns  INTEGER,
  last_record_ns   INTEGER,
  last_user_ns     INTEGER,
  last_turn_role   TEXT,                -- user | assistant: type of the last such record
  missing_since_ns INTEGER
);
CREATE INDEX transcripts_by_session ON transcripts (session_id);

CREATE TABLE prs (
  url          TEXT PRIMARY KEY,
  owner        TEXT NOT NULL,
  repo         TEXT NOT NULL,
  number       INTEGER NOT NULL,
  title        TEXT,
  state        TEXT,                    -- open | draft | merged | closed
  review       TEXT,
  checks       TEXT,
  ok_at_ns     INTEGER,
  tried_at_ns  INTEGER,
  error        TEXT
);

CREATE TABLE session_prs (
  session_id     TEXT NOT NULL,
  url            TEXT NOT NULL REFERENCES prs(url),
  origin         TEXT NOT NULL,         -- auto | manual
  first_seen_ns  INTEGER NOT NULL,
  detached_at_ns INTEGER,
  PRIMARY KEY (session_id, url)
);

CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // Migration 2: the SQL of design-step-2.md 10.2, character for character. It only adds a table,
  // so a reader of schema 1 (an old server until its next write, an old interactive list) still
  // reads correctly (stage B's plan, B1).
  `CREATE TABLE attention (
  session_id      TEXT PRIMARY KEY,
  turn_ended_seq  INTEGER,  -- order of the latest turn end the server saw (10.3)
  turn_ended_ns   INTEGER,  -- its time, for display only
  seen_seq        INTEGER,  -- order of the latest moment the user saw the session (12.4)
  window_end_seq  INTEGER,  -- order of the latest end of a window terminal holding it, the
  window_end_ns   INTEGER   -- session then being marked ended-unexpectedly (12.4); its time
);`,
  // Migration 3 (follow-up F18): the SQL of design-step-2.md 10.2, character for character. It only
  // adds a nullable column, so a reader of schema 2 (an old server until its next write, an old
  // interactive list) still reads correctly; an older skydeck refuses the database at its open.
  'ALTER TABLE session_meta ADD COLUMN ticket_url TEXT;  -- F18: the ticket the user set, its address; NULL for none',
  // Migration 4 (follow-up F19): the SQL of design-step-2.md 10.2, character for character. It only
  // adds a table, so a reader of schema 3 still reads correctly; an older skydeck refuses the
  // database at its open.
  `CREATE TABLE ticket_status (
  url          TEXT PRIMARY KEY,  -- a ticket's address (F19), as a session's ticket gives it
  status       TEXT,              -- its status' text; NULL until a read succeeded
  category     TEXT,              -- todo | doing | review | blocked | done | closed; NULL for none
  ok_at_ns     INTEGER,           -- the last read that succeeded
  tried_at_ns  INTEGER NOT NULL,  -- the last attempt
  error        TEXT               -- the last attempt's failure; NULL after a success
);`,
];

export const SCHEMA_VERSION: number = MIGRATIONS.length;
