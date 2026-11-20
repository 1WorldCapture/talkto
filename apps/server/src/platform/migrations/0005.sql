-- Preserve the admission classification when billing later changes.
ALTER TABLE servers ADD COLUMN admission_kind TEXT NOT NULL DEFAULT 'unpaid' CHECK(admission_kind IN ('paid','unpaid'));
CREATE INDEX servers_admissions ON servers(admission_kind,created_at);
CREATE INDEX servers_creator_admissions ON servers(created_by,created_at);
CREATE INDEX accounts_creator_admissions ON accounts(created_by,created_at);
