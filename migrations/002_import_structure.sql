ALTER TABLE import_candidates ADD COLUMN answer_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE import_candidates ADD COLUMN analysis TEXT NOT NULL DEFAULT '';
ALTER TABLE import_candidates ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
