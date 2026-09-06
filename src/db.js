import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const projectRoot = path.resolve(import.meta.dirname, '..');
export const dataDir = path.resolve(process.env.TIKU_DATA_DIR || path.join(projectRoot, 'data'));
export const paths = {
  database: path.join(dataDir, 'tiku.db'),
  uploads: path.join(dataDir, 'uploads'),
  imports: path.join(dataDir, 'imports'),
  exports: path.join(dataDir, 'exports'),
  backups: path.join(dataDir, 'backups'),
  models: path.join(dataDir, 'models')
};

for (const directory of Object.values(paths).filter((value) => value !== paths.database)) {
  fs.mkdirSync(directory, { recursive: true });
}

export const db = new DatabaseSync(paths.database);
db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');

const migrations = [
  ['001_initial', path.join(projectRoot, 'migrations', '001_initial.sql')],
  ['002_import_structure', path.join(projectRoot, 'migrations', '002_import_structure.sql')]
  ,['003_import_registration', path.join(projectRoot, 'migrations', '003_import_registration.sql')]
  ,['004_page_dimensions', path.join(projectRoot, 'migrations', '004_page_dimensions.sql')]
];
for (const [version, migrationPath] of migrations) {
  if (!db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(version)) {
    transactionMigration(migrationPath);
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, CURRENT_TIMESTAMP)').run(version);
  }
}

function transactionMigration(migrationPath) {
  db.exec('BEGIN IMMEDIATE');
  try { db.exec(fs.readFileSync(migrationPath, 'utf8')); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function seed() {
  const existing = db.prepare('SELECT COUNT(*) AS count FROM question_banks').get().count;
  if (existing > 0) return;
  const bank = db.prepare('INSERT INTO question_banks(name, description) VALUES (?, ?)').run('示例题库', '用于验证本地题库工作流的初始数据');
  const bankId = Number(bank.lastInsertRowid);
  const textbook = db.prepare('INSERT INTO textbooks(bank_id, name, subject, grade, edition) VALUES (?, ?, ?, ?, ?)').run(bankId, '高中数学必修第一册', '数学', '高一', '人教A版');
  const textbookId = Number(textbook.lastInsertRowid);
  const chapter = db.prepare('INSERT INTO textbook_chapters(textbook_id, name, sort_order) VALUES (?, ?, ?)').run(textbookId, '集合与常用逻辑用语', 1);
  const chapterId = Number(chapter.lastInsertRowid);
  const points = ['集合的概念', '充分条件与必要条件', '集合的运算'];
  for (const name of points) {
    db.prepare('INSERT INTO knowledge_points(bank_id, textbook_id, chapter_id, name) VALUES (?, ?, ?, ?)').run(bankId, textbookId, chapterId, name);
  }
  const pointRows = db.prepare('SELECT id, name FROM knowledge_points WHERE bank_id = ? ORDER BY id').all(bankId);
  const samples = [
    { stem: '若 A={1,2,3}，则 A 的子集个数为（ ）', options: ['A. 3', 'B. 6', 'C. 8', 'D. 9'], answer: ['C'], difficulty: 'easy', point: pointRows[0].id },
    { stem: '设集合 A={1,2}，B={2,3}，则 A∩B=（ ）', options: ['A. {1}', 'B. {2}', 'C. {3}', 'D. {1,2,3}'], answer: ['B'], difficulty: 'medium', point: pointRows[2].id },
    { stem: '“x>1”是“x>2”的充分不必要条件。', options: [], answer: ['false'], difficulty: 'hard', point: pointRows[1].id, type: 'true_false' }
  ];
  for (const sample of samples) {
    const type = sample.type || (sample.options.length > 0 ? 'single_choice' : 'short_answer');
    const question = db.prepare('INSERT INTO questions(bank_id, type, status, difficulty) VALUES (?, ?, ?, ?)').run(bankId, type, 'published', sample.difficulty);
    const questionId = Number(question.lastInsertRowid);
    const content = JSON.stringify({ stem: sample.stem, options: sample.options.map((text) => ({ key: text.slice(0, 1), text: text.slice(3) })), attachments: [] });
    const version = db.prepare('INSERT INTO question_versions(question_id, version_no, content_json, answer_json, analysis) VALUES (?, ?, ?, ?, ?)').run(questionId, 1, content, JSON.stringify(sample.answer), '示例解析：请结合对应知识点进行判断。');
    const versionId = Number(version.lastInsertRowid);
    db.prepare('UPDATE questions SET current_version_id = ? WHERE id = ?').run(versionId, questionId);
    db.prepare('INSERT INTO question_knowledge_points(question_id, knowledge_point_id, source) VALUES (?, ?, ?)').run(questionId, sample.point, 'manual');
    const search = JSON.parse(content);
    db.prepare('INSERT INTO question_search(question_id, stem, options, analysis, tags) VALUES (?, ?, ?, ?, ?)').run(String(questionId), search.stem, search.options.map((option) => option.text).join(' '), '示例解析', '示例');
  }
}
seed();

export function json(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

export function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function transaction(callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
