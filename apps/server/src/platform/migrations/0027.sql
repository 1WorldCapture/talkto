-- Swarm servers (docs/swarm-server-spec.md, 2.3). Additive only: older Workers never read this
-- column. `board` is 1 on a server whose task board is switched on: set when the server is created
-- as a swarm server, and copied after each switch the server's creator makes in Settings. The
-- server object holds the switch itself (board_settings); this copy only lets the server list show
-- which servers are swarm servers without asking each server object.
ALTER TABLE servers ADD COLUMN board INTEGER NOT NULL DEFAULT 0 CHECK (board IN (0, 1));
