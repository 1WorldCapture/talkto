-- Organization storage pool: a reservation is first recorded here as pending, then confirmed by
-- the organization's pool before any upload link is signed. Rows written before the pool were
-- counted by the old per-server cap and stay usable as they are.
ALTER TABLE file_transfers ADD COLUMN pool_state TEXT NOT NULL DEFAULT 'reserved'
  CHECK (pool_state IN ('pending', 'reserved'));
