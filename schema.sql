CREATE TABLE IF NOT EXISTS registration_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  state TEXT NOT NULL,
  revision INTEGER NOT NULL
);
