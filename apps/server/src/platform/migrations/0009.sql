-- Search runs inside each server's own database. Remove the shared search index and every
-- term it held; activity_events keeps only message IDs, sequences and times.
INSERT INTO activity_search(activity_search) VALUES('delete-all');
DROP TABLE activity_search;
