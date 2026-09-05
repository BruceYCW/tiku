CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS question_banks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS textbooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL REFERENCES question_banks(id),
  name TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  grade TEXT NOT NULL DEFAULT '',
  edition TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(bank_id, name, edition)
);

CREATE TABLE IF NOT EXISTS textbook_chapters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  textbook_id INTEGER NOT NULL REFERENCES textbooks(id),
  parent_id INTEGER REFERENCES textbook_chapters(id),
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS knowledge_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL REFERENCES question_banks(id),
  textbook_id INTEGER REFERENCES textbooks(id),
  chapter_id INTEGER REFERENCES textbook_chapters(id),
  parent_id INTEGER REFERENCES knowledge_points(id),
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  bank_id INTEGER NOT NULL DEFAULT 1 REFERENCES question_banks(id),
  file_name TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  progress INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS import_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  page_no INTEGER NOT NULL,
  image_path TEXT NOT NULL DEFAULT '',
  ocr_text TEXT NOT NULL DEFAULT '',
  ocr_blocks TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE(job_id, page_no)
);

CREATE TABLE IF NOT EXISTS import_candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES import_jobs(id),
  page_start INTEGER NOT NULL DEFAULT 1,
  page_end INTEGER NOT NULL DEFAULT 1,
  crop_path TEXT NOT NULL DEFAULT '',
  content_json TEXT NOT NULL,
  auto_content_json TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_review',
  manual_selection_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS candidate_knowledge_points (
  candidate_id TEXT NOT NULL REFERENCES import_candidates(id),
  knowledge_point_id INTEGER NOT NULL REFERENCES knowledge_points(id),
  source TEXT NOT NULL DEFAULT 'rule',
  confidence REAL NOT NULL DEFAULT 0,
  confirmed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(candidate_id, knowledge_point_id)
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id INTEGER NOT NULL REFERENCES question_banks(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  difficulty TEXT NOT NULL DEFAULT 'medium',
  source_job_id TEXT REFERENCES import_jobs(id),
  current_version_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS question_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  version_no INTEGER NOT NULL,
  content_json TEXT NOT NULL,
  answer_json TEXT NOT NULL DEFAULT '{}',
  analysis TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT 'local-user',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(question_id, version_no)
);

CREATE TABLE IF NOT EXISTS question_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id),
  import_job_id TEXT REFERENCES import_jobs(id),
  page_no INTEGER NOT NULL DEFAULT 1,
  crop_path TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL DEFAULT '',
  source_text TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS question_knowledge_points (
  question_id INTEGER NOT NULL REFERENCES questions(id),
  knowledge_point_id INTEGER NOT NULL REFERENCES knowledge_points(id),
  source TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY(question_id, knowledge_point_id)
);

CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  rule_config TEXT NOT NULL DEFAULT '{}',
  template_config TEXT NOT NULL DEFAULT '{}',
  total_score REAL NOT NULL DEFAULT 0,
  random_seed TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS paper_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id TEXT NOT NULL REFERENCES papers(id),
  question_version_id INTEGER NOT NULL REFERENCES question_versions(id),
  sort_order INTEGER NOT NULL,
  section_no INTEGER NOT NULL DEFAULT 1,
  score REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'auto',
  UNIQUE(paper_id, sort_order)
);

CREATE TABLE IF NOT EXISTS paper_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  paper_id TEXT NOT NULL REFERENCES papers(id),
  snapshot_json TEXT NOT NULL,
  pdf_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS question_search USING fts5(
  question_id UNINDEXED,
  stem,
  options,
  analysis,
  tags,
  tokenize = 'unicode61'
);
