-- Checkpoints must not survive a rewind into a different message history.
CREATE TABLE updates_identity (
 singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
 generation TEXT NOT NULL CHECK(length(generation) = 32)
) STRICT;
INSERT INTO updates_identity(singleton,generation) VALUES(1,lower(hex(randomblob(16))));
