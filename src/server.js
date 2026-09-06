import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { db, paths, json, hashBuffer, transaction } from './db.js';
import { parseImportContent } from './importers.js';

const port = Number(process.env.PORT || 3000);
const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const maxBodySize = 24 * 1024 * 1024;

function id() { return crypto.randomUUID(); }
function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body?.code ? body : { code: 'OK', data: body });
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}
function fail(res, status, message) { send(res, status, { code: 'ERROR', message, data: null }); }
function safeName(name) { return String(name || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120); }
function body(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    request.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBodySize) { reject(new Error('请求体超过 24MB 限制')); request.destroy(); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('请求体必须是 JSON')); }
    });
    request.on('error', reject);
  });
}
function contentFromCandidate(candidate) {
  const content = json(candidate.content_json, { stem: '', options: [], attachments: [] });
  const answers = json(candidate.answer_json || content.answer || '[]', []);
  if (candidate.analysis) content.analysis = candidate.analysis;
  if (candidate.attachments_json) content.attachments = json(candidate.attachments_json, content.attachments || []);
  return { content, answers };
}
function inferType(content) {
  if (content.type) return content.type;
  if (content.options?.length) return 'single_choice';
  return 'short_answer';
}
function normalizeType(type, content) {
  const value = type || content.type || inferType(content);
  if (!['single_choice', 'multiple_choice', 'true_false', 'short_answer'].includes(value)) throw new Error(`不支持的题型：${value}`);
  return value;
}
function validateContent(content, type) {
  if (!content || typeof content.stem !== 'string' || !content.stem.trim()) throw new Error('题干不能为空');
  if (['single_choice', 'multiple_choice'].includes(type)) {
    if (!Array.isArray(content.options) || content.options.length < 2) throw new Error('选择题至少需要两个选项');
    const keys = content.options.map((option) => String(option.key || '').toUpperCase());
    if (keys.some((key) => !key) || new Set(keys).size !== keys.length) throw new Error('选项编号必须唯一且不能为空');
  }
  if (type === 'true_false' && content.options?.length) throw new Error('判断题不应包含选择项');
}
function classifyKnowledgePoints(content, bankId) {
  const haystack = `${content.stem || ''} ${(content.options || []).map((option) => option.text).join(' ')}`.toLowerCase();
  return db.prepare('SELECT id, name, aliases FROM knowledge_points WHERE bank_id = ? ORDER BY id').all(bankId)
    .filter((point) => [point.name, ...String(point.aliases || '').split(',')].some((term) => term.trim() && haystack.includes(term.trim().toLowerCase())))
    .map((point) => ({ id: point.id, confidence: 0.65 }));
}
function indexQuestion(questionId) {
  const row = db.prepare(`SELECT qv.content_json, qv.analysis FROM questions q JOIN question_versions qv ON qv.id = q.current_version_id WHERE q.id = ?`).get(questionId);
  if (!row) return;
  const content = json(row.content_json, {});
  db.prepare('DELETE FROM question_search WHERE question_id = ?').run(String(questionId));
  db.prepare('INSERT INTO question_search(question_id, stem, options, analysis, tags) VALUES (?, ?, ?, ?, ?)').run(String(questionId), content.stem || '', (content.options || []).map((option) => option.text).join(' '), row.analysis || '', (content.tags || []).join(' '));
}
function normalizeImportText(text) {
  return String(text || '').replace(/\r/g, '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .split('\n').filter((line) => !/^\s*第\s*\d+\s*页\/共\s*\d+\s*页\s*$/.test(line) && !/学科网（北京）股份有限公司/.test(line)).join('\n');
}
function answerValue(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return [];
  if (/^[A-H]+$/i.test(normalized)) return [...normalized.toUpperCase()];
  if (/^(正确|对)$/i.test(normalized)) return ['true'];
  if (/^(错误|错)$/i.test(normalized)) return ['false'];
  return [normalized];
}
function parseTextCandidates(text, pageNo = 1, attachmentPath = '', pageRanges = []) {
  const normalized = normalizeImportText(text);
  const lines = normalized.split('\n');
  const starts = [];
  lines.forEach((line, index) => { if (/^\s*\d{1,3}\s*[.、．)）]\s*/.test(line)) starts.push(index); });
  const pageForLine = (lineIndex) => pageRanges.find((range) => lineIndex >= range.start && lineIndex < range.end)?.pageNo || pageNo;
  const attachmentsForRange = (start, end) => {
    if (!pageRanges.length) return attachmentPath ? [{ type: 'page_image', path: attachmentPath, pageNo }] : [];
    return pageRanges.filter((range) => range.start < end && range.end > start && range.imagePath).map((range) => ({ type: 'page_image', path: range.imagePath, pageNo: range.pageNo }));
  };
  if (!starts.length && normalized.trim()) return [{ stem: normalized.trim(), options: [], answer: [], analysis: '', attachments: attachmentsForRange(0, lines.length), pageStart: pageNo, pageEnd: pageNo }];
  return starts.map((start, position) => {
    const end = starts[position + 1] ?? lines.length;
    const segment = lines.slice(start, end).filter((line) => line.trim());
    const first = segment.shift() || '';
    const number = first.match(/^\s*(\d{1,3})\s*[.、．)）]\s*/)?.[1] || '';
    const raw = [first.replace(/^\s*\d{1,3}\s*[.、．)）]\s*/, ''), ...segment].join('\n');
    const marker = raw.search(/【(?:答案|解析|详解)】/);
    const questionPart = marker >= 0 ? raw.slice(0, marker) : raw;
    const tail = marker >= 0 ? raw.slice(marker) : '';
    const answerMatch = tail.match(/【答案】\s*([\s\S]*?)(?=【(?:解析|详解)】|$)/i);
    const answer = answerValue(answerMatch?.[1]);
    const analysisStart = tail.search(/【(?:解析|详解)】/);
    const analysis = analysisStart >= 0 ? tail.slice(analysisStart).replace(/【(?:解析|详解)】/g, '').trim() : '';
    const options = [];
    const optionMatches = [...questionPart.matchAll(/(?:^|[\s])([A-H])\s*[.、．)）:：]\s*/g)];
    const stemText = optionMatches.length ? questionPart.slice(0, optionMatches[0].index).trim() : questionPart.trim();
    optionMatches.forEach((match, index) => {
      const startIndex = match.index + match[0].length;
      const endIndex = optionMatches[index + 1]?.index ?? questionPart.length;
      const optionText = questionPart.slice(startIndex, endIndex).replace(/\s+/g, ' ').trim();
      if (optionText) options.push({ key: match[1], text: optionText });
    });
    const content = { number, stem: stemText, options, attachments: attachmentsForRange(start, end) };
    if (answer.length) content.type = options.length ? (answer.length > 1 ? 'multiple_choice' : 'single_choice') : (answer[0] === 'true' || answer[0] === 'false' ? 'true_false' : 'short_answer');
    if (!content.stem) return null;
    if (!options.length && !answer.length && !analysis && /(试卷分为|注意事项|答题卡|考试结束|答题前务必|作图要用)/.test(content.stem)) return null;
    return { content, answer, analysis, pageStart: pageForLine(start), pageEnd: pageForLine(Math.max(start, end - 1)) };
  }).filter(Boolean);
}
function candidateView(row) {
  const content = json(row.content_json, {});
  return { ...row, content, answer: json(row.answer_json, []), analysis: row.analysis || content.analysis || '', attachments: json(row.attachments_json, content.attachments || []), selection: json(row.manual_selection_json, {}), autoContent: json(row.auto_content_json, {}), knowledgePointIds: db.prepare('SELECT knowledge_point_id AS id, confirmed FROM candidate_knowledge_points WHERE candidate_id = ?').all(row.id) };
}
function questionView(row) {
  const content = json(row.content_json, {});
  const questionId = row.question_id ?? row.id;
  const points = db.prepare(`SELECT kp.id, kp.name, tb.name AS textbook_name, tc.name AS chapter_name
    FROM question_knowledge_points qkp JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
    LEFT JOIN textbooks tb ON tb.id = kp.textbook_id LEFT JOIN textbook_chapters tc ON tc.id = kp.chapter_id
    WHERE qkp.question_id = ?`).all(questionId);
  return { ...row, content, knowledgePoints: points };
}
function listQuestions(url, status = 'published') {
  const params = url.searchParams;
  const where = ['q.status = ?'];
  const args = [status];
  const add = (condition, value) => { if (value) { where.push(condition); args.push(value); } };
  add('q.type = ?', params.get('type'));
  add('q.difficulty = ?', params.get('difficulty'));
  add('q.bank_id = ?', params.get('bankId'));
  add('q.source_job_id = ?', params.get('sourceJobId'));
  add('kp.id = ?', params.get('knowledgePointId'));
  add('tb.id = ?', params.get('textbookId'));
  add('tc.id = ?', params.get('chapterId'));
  const keyword = params.get('keyword')?.trim();
  let rows;
  if (keyword) {
    rows = db.prepare(`SELECT q.id, q.bank_id, q.type, q.status, q.difficulty, qv.content_json
      FROM questions q JOIN question_versions qv ON qv.id = q.current_version_id
      JOIN question_search qs ON qs.question_id = CAST(q.id AS TEXT)
      LEFT JOIN question_knowledge_points qkp ON qkp.question_id = q.id
      LEFT JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
      LEFT JOIN textbooks tb ON tb.id = kp.textbook_id LEFT JOIN textbook_chapters tc ON tc.id = kp.chapter_id
      WHERE ${where.join(' AND ')} AND question_search MATCH ? GROUP BY q.id ORDER BY q.updated_at DESC`).all(...args, keyword.replace(/[^\p{L}\p{N}_-]+/gu, ' '));
  } else {
    rows = db.prepare(`SELECT q.id, q.bank_id, q.type, q.status, q.difficulty, qv.content_json
      FROM questions q JOIN question_versions qv ON qv.id = q.current_version_id
      LEFT JOIN question_knowledge_points qkp ON qkp.question_id = q.id
      LEFT JOIN knowledge_points kp ON kp.id = qkp.knowledge_point_id
      LEFT JOIN textbooks tb ON tb.id = kp.textbook_id LEFT JOIN textbook_chapters tc ON tc.id = kp.chapter_id
      WHERE ${where.join(' AND ')} GROUP BY q.id ORDER BY q.updated_at DESC`).all(...args);
  }
  return rows.map(questionView);
}
function makePdfPlaceholder(paper, snapshot) {
  const text = [`题库系统试卷预览`, paper.name, '', ...snapshot.questions.map((question, index) => `${index + 1}. ${question.content.stem}`)].join('\n');
  const escaped = text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)').split('\n');
  const commands = ['BT', '/F1 12 Tf', '50 780 Td', ...escaped.map((line, index) => `${index ? '0 -20 Td' : ''} (${line.slice(0, 100)}) Tj`), 'ET'].join('\n');
  const objects = [`1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj`, `2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj`, `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >> endobj`, `4 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`, `5 0 obj << /Length ${Buffer.byteLength(commands)} >> stream\n${commands}\nendstream endobj`];
  let output = '%PDF-1.4\n'; const offsets = [0];
  for (const object of objects) { offsets.push(Buffer.byteLength(output)); output += `${object}\n`; }
  const xref = Buffer.byteLength(output); output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

async function api(request, response, url) {
  const method = request.method;
  const pathname = url.pathname;
  if (method === 'GET' && pathname === '/api/health') return send(response, 200, { status: 'ok', database: paths.database, localOnly: true });
  if (method === 'GET' && pathname === '/api/dashboard') {
    return send(response, 200, { banks: db.prepare('SELECT COUNT(*) AS count FROM question_banks').get().count, questions: db.prepare('SELECT COUNT(*) AS count FROM questions WHERE status = \'published\'').get().count, imports: db.prepare('SELECT COUNT(*) AS count FROM import_jobs').get().count, papers: db.prepare('SELECT COUNT(*) AS count FROM papers').get().count });
  }
  if (method === 'GET' && pathname === '/api/question-banks') return send(response, 200, db.prepare('SELECT * FROM question_banks ORDER BY id').all());
  const textbookMatch = pathname.match(/^\/api\/question-banks\/(\d+)\/textbooks$/);
  if (method === 'GET' && textbookMatch) {
    const bankId = textbookMatch[1];
    const textbooks = db.prepare('SELECT * FROM textbooks WHERE bank_id = ? ORDER BY id').all(bankId).map((textbook) => ({ ...textbook, chapters: db.prepare('SELECT * FROM textbook_chapters WHERE textbook_id = ? ORDER BY sort_order, id').all(textbook.id), knowledgePoints: db.prepare('SELECT * FROM knowledge_points WHERE textbook_id = ? ORDER BY id').all(textbook.id) }));
    return send(response, 200, textbooks);
  }
  if (method === 'GET' && pathname === '/api/knowledge-points') return send(response, 200, db.prepare(`SELECT kp.*, tb.name AS textbook_name, tc.name AS chapter_name FROM knowledge_points kp LEFT JOIN textbooks tb ON tb.id = kp.textbook_id LEFT JOIN textbook_chapters tc ON tc.id = kp.chapter_id ORDER BY kp.id`).all());
  if (method === 'GET' && pathname === '/api/questions/search') { const items = listQuestions(url); return send(response, 200, { items, total: items.length }); }
  if (method === 'GET' && pathname === '/api/questions/review') { const items = listQuestions(url, paramsStatus(url)); return send(response, 200, { items, total: items.length }); }

  const questionStatusMatch = pathname.match(/^\/api\/questions\/(\d+)\/(publish|offline)$/);
  if (method === 'POST' && questionStatusMatch) {
    const question = db.prepare('SELECT id, status FROM questions WHERE id = ?').get(questionStatusMatch[1]);
    if (!question) return fail(response, 404, '题目不存在');
    const status = questionStatusMatch[2] === 'publish' ? 'published' : 'offline';
    if (status === 'published') {
      const version = db.prepare('SELECT content_json FROM question_versions WHERE id = (SELECT current_version_id FROM questions WHERE id = ?)').get(question.id);
      const content = json(version?.content_json, {});
      validateContent(content, normalizeType(content.type, content));
    }
    db.prepare('UPDATE questions SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, question.id);
    if (status === 'published') indexQuestion(question.id);
    return send(response, 200, { id: question.id, status });
  }

  if (method === 'POST' && pathname === '/api/imports/papers') {
    const input = await body(request);
    if (!String(input.year || '').trim()) return fail(response, 400, '年份不能为空');
    if (!String(input.title || '').trim()) return fail(response, 400, '试卷标题不能为空');
    const fileName = safeName(input.fileName || 'import.txt');
    const content = input.contentBase64 ? Buffer.from(input.contentBase64, 'base64') : Buffer.from(String(input.text || ''), 'utf8');
    const jobId = id(); const filePath = path.join(paths.imports, `${jobId}-${fileName}`);
    fs.writeFileSync(filePath, content);
    const type = (input.fileType || path.extname(fileName).slice(1).toLowerCase() || 'text').toLowerCase();
    if (!['pdf', 'png', 'jpg', 'jpeg', 'docx', 'txt'].includes(type)) return fail(response, 415, '仅支持 PDF、PNG、JPG、JPEG、DOCX 或文本导入');
    const bank = db.prepare('SELECT id FROM question_banks WHERE id = ?').get(Number(input.bankId || 1));
    if (!bank) return fail(response, 400, '目标题库不存在');
    const hash = hashBuffer(content);
    const pageOutputDir = path.join(paths.imports, jobId, 'pages');
    const parsed = parseImportContent({ type, buffer: content, filePath, pageOutputDir, providedText: String(input.text || '') });
    if (['png', 'jpg', 'jpeg'].includes(type)) { fs.mkdirSync(pageOutputDir, { recursive: true }); const imagePath = path.join(pageOutputDir, `page-1.${type === 'jpeg' ? 'jpg' : type}`); fs.copyFileSync(filePath, imagePath); parsed.pages = [{ pageNo: 1, text: parsed.text, imagePath }]; }
    const pageRanges = [];
    const combinedLines = [];
    parsed.pages.forEach((page) => {
      const pageLines = normalizeImportText(page.text).split('\n');
      const start = combinedLines.length;
      combinedLines.push(...pageLines, '');
      pageRanges.push({ pageNo: page.pageNo, start, end: combinedLines.length, imagePath: page.imagePath ? `/api/imports/${jobId}/pages/${page.pageNo}/image` : '' });
    });
    const candidates = input.manualCut ? [] : parseTextCandidates(combinedLines.join('\n'), 1, '', pageRanges);
    transaction(() => {
      db.prepare('INSERT INTO import_jobs(id, bank_id, file_name, file_type, file_path, source_hash, status, progress, error_message, paper_year, paper_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(jobId, Number(input.bankId || 1), fileName, type, filePath, hash, candidates.length ? 'waiting_review' : 'uploaded', candidates.length ? 70 : 10, parsed.message, String(input.year).trim(), String(input.title).trim());
      const pages = parsed.pages.length ? parsed.pages : [{ pageNo: 1, text: parsed.text, imagePath: '' }];
      pages.forEach((page) => db.prepare('INSERT INTO import_pages(job_id, page_no, image_path, ocr_text, status, width_pt, height_pt) VALUES (?, ?, ?, ?, ?, ?, ?)').run(jobId, page.pageNo, page.imagePath, page.text, page.text || page.imagePath ? 'completed' : 'pending', page.widthPt || 595, page.heightPt || 842));
      candidates.forEach((content) => {
        const candidateId = id();
        db.prepare(`INSERT INTO import_candidates(id, job_id, page_start, page_end, content_json, auto_content_json, confidence) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(candidateId, jobId, content.pageStart, content.pageEnd, JSON.stringify(content.content), JSON.stringify(content.content), input.text ? 0.82 : (parsed.source === 'pdf-local-text' || parsed.source === 'docx-parser' ? 0.8 : 0.1));
        db.prepare('UPDATE import_candidates SET answer_json = ?, analysis = ?, attachments_json = ? WHERE id = ?').run(JSON.stringify(content.answer), content.analysis, JSON.stringify(content.content.attachments || []), candidateId);
        for (const point of classifyKnowledgePoints(content.content, bank.id)) db.prepare('INSERT INTO candidate_knowledge_points(candidate_id, knowledge_point_id, source, confidence) VALUES (?, ?, ?, ?)').run(candidateId, point.id, 'rule', point.confidence);
      });
    });
    return send(response, 201, { id: jobId, status: candidates.length ? 'waiting_review' : 'uploaded', candidateCount: candidates.length, pageCount: parsed.pages.length, parser: parsed.source, message: candidates.length ? '已生成候选，请人工校对' : parsed.message || '文件已保存，等待本地解析/OCR适配器处理' });
  }
  const importMatch = pathname.match(/^\/api\/imports\/([^/]+)$/);
  const pageImageMatch = pathname.match(/^\/api\/imports\/([^/]+)\/pages\/(\d+)\/image$/);
  if (method === 'GET' && pageImageMatch) {
    const page = db.prepare('SELECT image_path FROM import_pages WHERE job_id = ? AND page_no = ?').get(pageImageMatch[1], pageImageMatch[2]);
    if (!page || !page.image_path || !fs.existsSync(page.image_path)) return fail(response, 404, '页面图片不存在');
    const contentTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };
    response.writeHead(200, { 'Content-Type': contentTypes[path.extname(page.image_path).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'private, max-age=3600' });
    return fs.createReadStream(page.image_path).pipe(response);
  }
  if (method === 'GET' && importMatch) {
    const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(importMatch[1]);
    if (!job) return fail(response, 404, '导入任务不存在');
    return send(response, 200, { ...job, pages: db.prepare('SELECT page_no, image_path, status, width_pt AS widthPt, height_pt AS heightPt FROM import_pages WHERE job_id = ? ORDER BY page_no').all(job.id).map((page) => ({ ...page, imageUrl: page.image_path ? `/api/imports/${job.id}/pages/${page.page_no}/image` : '' })), candidates: db.prepare('SELECT * FROM import_candidates WHERE job_id = ? ORDER BY rowid').all(job.id).map(candidateView) });
  }
  if (method === 'PUT' && importMatch) {
    const input = await body(request); const job = db.prepare('SELECT id FROM import_jobs WHERE id = ?').get(importMatch[1]);
    if (!job) return fail(response, 404, '导入任务不存在');
    if (!String(input.year || '').trim() || !String(input.title || '').trim()) return fail(response, 400, '年份和试卷标题不能为空');
    db.prepare('UPDATE import_jobs SET paper_year = ?, paper_title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(String(input.year).trim(), String(input.title).trim(), job.id);
    return send(response, 200, { id: job.id, year: String(input.year).trim(), title: String(input.title).trim() });
  }
  const candidatesMatch = pathname.match(/^\/api\/imports\/([^/]+)\/candidates$/);
  if (method === 'GET' && candidatesMatch) return send(response, 200, db.prepare('SELECT * FROM import_candidates WHERE job_id = ? ORDER BY rowid').all(candidatesMatch[1]).map(candidateView));
  const candidateMatch = pathname.match(/^\/api\/imports\/([^/]+)\/candidates\/([^/]+)(?:\/(crop))?$/);
  if (method === 'PUT' && candidateMatch && !candidateMatch[3]) {
    const input = await body(request); const candidate = db.prepare('SELECT * FROM import_candidates WHERE id = ? AND job_id = ?').get(candidateMatch[2], candidateMatch[1]);
    if (!candidate) return fail(response, 404, '候选题不存在');
    const existingContent = json(candidate.content_json, {});
    const content = input.content ? { ...existingContent, ...input.content } : existingContent;
    const type = normalizeType(input.type || content.type, content);
    validateContent(content, type);
    content.type = type;
    const answers = Array.isArray(input.answer) ? input.answer : json(candidate.answer_json, content.answer || []);
    const analysis = typeof input.analysis === 'string' ? input.analysis : (content.analysis || candidate.analysis || '');
    content.analysis = analysis;
    db.prepare('UPDATE import_candidates SET content_json = ?, answer_json = ?, analysis = ?, attachments_json = ?, status = \'pending_review\', updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(content), JSON.stringify(answers), analysis, JSON.stringify(content.attachments || []), candidate.id);
    if (Array.isArray(input.knowledgePointIds)) {
      transaction(() => { db.prepare('DELETE FROM candidate_knowledge_points WHERE candidate_id = ?').run(candidate.id); for (const pointId of input.knowledgePointIds) db.prepare('INSERT INTO candidate_knowledge_points(candidate_id, knowledge_point_id, source, confirmed) VALUES (?, ?, ?, 1)').run(candidate.id, pointId, 'manual'); });
    }
    return send(response, 200, candidateView(db.prepare('SELECT * FROM import_candidates WHERE id = ?').get(candidate.id)));
  }
  const segmentsMatch = pathname.match(/^\/api\/imports\/([^/]+)\/segments$/);
  if (method === 'POST' && segmentsMatch) {
    const input = await body(request); const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(segmentsMatch[1]);
    if (!job) return fail(response, 404, '导入任务不存在');
    const parts = Array.isArray(input.parts) ? input.parts : [];
    if (!parts.length || !parts.some((part) => part.role === 'stem') || parts.some((part) => !Number.isInteger(Number(part.pageNo)) || !part.rect || ['x', 'y', 'width', 'height'].some((key) => !Number.isFinite(Number(part.rect[key])) || Number(part.rect[key]) < 0) || Number(part.rect.width) <= 0 || Number(part.rect.height) <= 0)) return fail(response, 400, '题目区域必须包含至少一个题干框和合法的 PDF 坐标');
    const content = { number: String(input.number || db.prepare('SELECT COUNT(*) AS count FROM import_candidates WHERE job_id = ?').get(job.id).count + 1), stem: String(input.stemText || `第${input.number || ''}题（待补充题干）`).trim(), options: [], attachments: parts.filter((part) => part.role === 'image').map((part) => ({ type: 'region', pageNo: part.pageNo, rect: part.rect })) , parts, mode: input.mode || 'box' };
    const candidateId = id();
    db.prepare('INSERT INTO import_candidates(id, job_id, page_start, page_end, content_json, auto_content_json, confidence, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(candidateId, job.id, Math.min(...parts.map((part) => Number(part.pageNo))), Math.max(...parts.map((part) => Number(part.pageNo))), JSON.stringify(content), JSON.stringify(content), 1, 'pending_review');
    db.prepare('UPDATE import_candidates SET attachments_json = ? WHERE id = ?').run(JSON.stringify(content.attachments), candidateId);
    return send(response, 201, candidateView(db.prepare('SELECT * FROM import_candidates WHERE id = ?').get(candidateId)));
  }
  const segmentMatch = pathname.match(/^\/api\/imports\/([^/]+)\/segments\/([^/]+)$/);
  if (method === 'PUT' && segmentMatch) {
    const input = await body(request); const candidate = db.prepare('SELECT * FROM import_candidates WHERE id = ? AND job_id = ?').get(segmentMatch[2], segmentMatch[1]);
    if (!candidate) return fail(response, 404, '题目不存在');
    const current = json(candidate.content_json, {}); const content = { ...current, ...input, parts: Array.isArray(input.parts) ? input.parts : current.parts || [] };
    if (!content.stem || !content.parts.length) return fail(response, 400, '题目至少需要一个题干区域');
    content.attachments = content.parts.filter((part) => part.role === 'image').map((part) => ({ type: 'region', pageNo: part.pageNo, rect: part.rect }));
    db.prepare('UPDATE import_candidates SET content_json = ?, answer_json = ?, analysis = ?, attachments_json = ?, page_start = ?, page_end = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(content), JSON.stringify(input.answer || json(candidate.answer_json, [])), input.analysis || candidate.analysis || '', JSON.stringify(content.attachments), Math.min(...content.parts.map((part) => Number(part.pageNo))), Math.max(...content.parts.map((part) => Number(part.pageNo))), candidate.id);
    return send(response, 200, candidateView(db.prepare('SELECT * FROM import_candidates WHERE id = ?').get(candidate.id)));
  }
  if (method === 'DELETE' && segmentMatch) {
    const result = db.prepare('DELETE FROM import_candidates WHERE id = ? AND job_id = ?').run(segmentMatch[2], segmentMatch[1]);
    if (!result.changes) return fail(response, 404, '题目不存在');
    return send(response, 200, { id: segmentMatch[2], deleted: true });
  }
  const clearSegmentsMatch = pathname.match(/^\/api\/imports\/([^/]+)\/segments\/clear$/);
  if (method === 'POST' && clearSegmentsMatch) {
    db.prepare('DELETE FROM import_candidates WHERE job_id = ?').run(clearSegmentsMatch[1]);
    return send(response, 200, { jobId: clearSegmentsMatch[1], cleared: true });
  }
  const mergeMatch = pathname.match(/^\/api\/imports\/([^/]+)\/segments\/merge$/);
  if (method === 'POST' && mergeMatch) {
    const input = await body(request); const ids = Array.isArray(input.ids) ? input.ids : [];
    if (ids.length < 2) return fail(response, 400, '至少选择两道相邻题目合并');
    const rows = ids.map((candidateId) => db.prepare('SELECT * FROM import_candidates WHERE id = ? AND job_id = ?').get(candidateId, mergeMatch[1])).filter(Boolean);
    if (rows.length !== ids.length) return fail(response, 404, '待合并题目不存在');
    const parts = rows.flatMap((row) => json(row.content_json, {}).parts || []); const first = json(rows[0].content_json, {}); first.parts = parts; first.stem = input.stem || first.stem; first.attachments = parts.filter((part) => part.role === 'image').map((part) => ({ type: 'region', pageNo: part.pageNo, rect: part.rect }));
    db.prepare('UPDATE import_candidates SET content_json = ?, attachments_json = ?, page_start = ?, page_end = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(JSON.stringify(first), JSON.stringify(first.attachments), Math.min(...parts.map((part) => Number(part.pageNo))), Math.max(...parts.map((part) => Number(part.pageNo))), rows[0].id);
    db.prepare(`DELETE FROM import_candidates WHERE job_id = ? AND id IN (${ids.slice(1).map(() => '?').join(',')})`).run(mergeMatch[1], ...ids.slice(1));
    return send(response, 200, candidateView(db.prepare('SELECT * FROM import_candidates WHERE id = ?').get(rows[0].id)));
  }
  if (method === 'POST' && candidateMatch?.[3] === 'crop') {
    const input = await body(request); const candidateId = candidateMatch[2];
    const candidate = db.prepare('SELECT id FROM import_candidates WHERE id = ? AND job_id = ?').get(candidateId, candidateMatch[1]);
    if (!candidate) return fail(response, 404, '候选题不存在');
    const selection = input.selection || {};
    if (selection.unit === 'relative' && ['x', 'y', 'width', 'height'].some((key) => !Number.isFinite(Number(selection[key])) || Number(selection[key]) < 0 || Number(selection[key]) > 1)) return fail(response, 400, '选区坐标必须是 0 到 1 之间的数字');
    db.prepare('UPDATE import_candidates SET manual_selection_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND job_id = ?').run(JSON.stringify(selection), candidateId, candidateMatch[1]);
    return send(response, 200, { candidateId, message: '手动选区已保存，下一步可重新执行本地 OCR' });
  }
  const confirmMatch = pathname.match(/^\/api\/imports\/([^/]+)\/confirm$/);
  if (method === 'POST' && confirmMatch) {
    const jobId = confirmMatch[1]; const job = db.prepare('SELECT * FROM import_jobs WHERE id = ?').get(jobId);
    if (!job) return fail(response, 404, '导入任务不存在');
    const candidates = db.prepare('SELECT * FROM import_candidates WHERE job_id = ? AND status != \'confirmed\'').all(jobId);
    const created = transaction(() => candidates.map((candidate) => {
      const { content, answers } = contentFromCandidate(candidate); const type = normalizeType(content.type, content); validateContent(content, type);
      const question = db.prepare('INSERT INTO questions(bank_id, type, status, difficulty, source_job_id) VALUES (?, ?, ?, ?, ?)').run(job.bank_id, type, 'draft', inputDifficulty(content), jobId);
      const questionId = Number(question.lastInsertRowid);
      const version = db.prepare('INSERT INTO question_versions(question_id, version_no, content_json, answer_json, analysis) VALUES (?, ?, ?, ?, ?)').run(questionId, 1, JSON.stringify(content), JSON.stringify(answers), content.analysis || '');
      db.prepare('UPDATE questions SET current_version_id = ? WHERE id = ?').run(Number(version.lastInsertRowid), questionId);
      indexQuestion(questionId);
      db.prepare('INSERT INTO question_sources(question_id, import_job_id, page_no, crop_path, source_hash, source_text) VALUES (?, ?, ?, ?, ?, ?)').run(questionId, jobId, candidate.page_start, candidate.manual_selection_json || candidate.crop_path || '', job.source_hash, JSON.stringify(content));
      db.prepare('INSERT INTO question_knowledge_points(question_id, knowledge_point_id, source) SELECT ?, knowledge_point_id, CASE WHEN confirmed = 1 THEN \'manual\' ELSE \'rule\' END FROM candidate_knowledge_points WHERE candidate_id = ?').run(questionId, candidate.id);
      db.prepare('UPDATE import_candidates SET status = \'confirmed\' WHERE id = ?').run(candidate.id);
      return questionId;
    }));
    db.prepare('UPDATE import_jobs SET status = \'completed\', progress = 100, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(jobId);
    return send(response, 200, { importedQuestionIds: created, count: created.length, status: 'completed' });
  }

  const replaceMatch = pathname.match(/^\/api\/papers\/([^/]+)\/questions\/(\d+)\/replace$/);
  if (method === 'POST' && replaceMatch) {
    const input = await body(request);
    const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(replaceMatch[1]);
    if (!paper) return fail(response, 404, '试卷不存在');
    if (['confirmed', 'exported'].includes(paper.status)) return fail(response, 409, '已确认的试卷不能直接修改');
    const target = db.prepare('SELECT id FROM paper_questions WHERE id = ? AND paper_id = ?').get(replaceMatch[2], paper.id);
    const question = db.prepare(`SELECT q.id, q.type, q.difficulty, q.current_version_id
      FROM questions q WHERE q.id = ? AND q.status = 'published'`).get(Number(input.questionId));
    if (!target || !question) return fail(response, 404, '试卷题目或替换题目不存在');
    const duplicate = db.prepare(`SELECT 1 FROM paper_questions WHERE paper_id = ? AND question_version_id = ? AND id != ?`).get(paper.id, question.current_version_id, target.id);
    if (duplicate) return fail(response, 409, '替换题目已在试卷中');
    const old = db.prepare(`SELECT q.type FROM paper_questions pq JOIN question_versions qv ON qv.id = pq.question_version_id JOIN questions q ON q.id = qv.question_id WHERE pq.id = ?`).get(target.id);
    if (old.type !== question.type) return fail(response, 400, '替换题目必须保持原题型');
    const score = Number(input.score ?? db.prepare('SELECT score FROM paper_questions WHERE id = ?').get(target.id).score);
    db.prepare('UPDATE paper_questions SET question_version_id = ?, score = ?, source = \'manual_replace\' WHERE id = ?').run(question.current_version_id, score, target.id);
    const totalScore = db.prepare('SELECT COALESCE(SUM(score), 0) AS total FROM paper_questions WHERE paper_id = ?').get(paper.id).total;
    db.prepare('UPDATE papers SET total_score = ?, updated_at = CURRENT_TIMESTAMP, status = \'editing\' WHERE id = ?').run(totalScore, paper.id);
    return send(response, 200, { paperId: paper.id, paperQuestionId: target.id, replacementQuestionId: question.id, totalScore });
  }

  if (method === 'POST' && pathname === '/api/papers/generate') {
    const input = await body(request); const rule = input.rule || {}; const counts = rule.typeCounts || { single_choice: 2, true_false: 1 };
    const all = listQuestions(new URL('http://localhost/api/questions/search?bankId=' + (rule.bankId || '1')));
    const selected = []; const used = new Set();
    for (const [type, count] of Object.entries(counts)) {
      const requestedDifficulty = rule.difficulties?.[type];
      const pool = all.filter((question) => question.type === type && (!requestedDifficulty || question.difficulty === requestedDifficulty));
      for (let index = 0; index < Number(count); index += 1) { const question = pool.find((item) => !used.has(item.id)); if (!question) break; selected.push(question); used.add(question.id); }
    }
    const paperId = id(); const totalScore = selected.reduce((sum, question) => sum + Number(rule.scores?.[question.type] || 5), 0);
    transaction(() => {
      db.prepare('INSERT INTO papers(id, name, rule_config, total_score, random_seed, status) VALUES (?, ?, ?, ?, ?, ?)').run(paperId, input.name || '未命名试卷', JSON.stringify(rule), totalScore, id(), 'preview');
      selected.forEach((question, index) => db.prepare('INSERT INTO paper_questions(paper_id, question_version_id, sort_order, score) VALUES (?, ?, ?, ?)').run(paperId, question.current_version_id || db.prepare('SELECT current_version_id FROM questions WHERE id = ?').get(question.id).current_version_id, index + 1, Number(rule.scores?.[question.type] || 5)));
    });
    return send(response, 201, { id: paperId, selectedCount: selected.length, requestedCount: Object.values(counts).reduce((sum, count) => sum + Number(count), 0), totalScore, warnings: selected.length < Object.values(counts).reduce((sum, count) => sum + Number(count), 0) ? ['可用题目不足，未满足全部组卷规则'] : [] });
  }
  const paperMatch = pathname.match(/^\/api\/papers\/([^/]+)(?:\/(preview|confirm|export-pdf))?$/);
  if (method === 'GET' && paperMatch) {
    const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperMatch[1]); if (!paper) return fail(response, 404, '试卷不存在');
    const questions = db.prepare(`SELECT pq.*, q.id AS question_id, q.type, q.difficulty, qv.content_json, qv.answer_json, qv.analysis FROM paper_questions pq JOIN question_versions qv ON qv.id = pq.question_version_id JOIN questions q ON q.id = qv.question_id WHERE pq.paper_id = ? ORDER BY pq.sort_order`).all(paper.id).map(questionView);
    return send(response, 200, { ...paper, rule: json(paper.rule_config, {}), questions });
  }
  if (method === 'POST' && paperMatch?.[2] === 'confirm') {
    const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperMatch[1]); if (!paper) return fail(response, 404, '试卷不存在');
    const questions = db.prepare(`SELECT pq.*, q.type, q.difficulty, qv.content_json FROM paper_questions pq JOIN question_versions qv ON qv.id = pq.question_version_id JOIN questions q ON q.id = qv.question_id WHERE pq.paper_id = ? ORDER BY pq.sort_order`).all(paper.id).map(questionView);
    const snapshot = { paperId: paper.id, name: paper.name, totalScore: paper.total_score, questions };
    db.prepare('INSERT INTO paper_snapshots(paper_id, snapshot_json) VALUES (?, ?)').run(paper.id, JSON.stringify(snapshot)); db.prepare('UPDATE papers SET status = \'confirmed\' WHERE id = ?').run(paper.id);
    return send(response, 200, snapshot);
  }
  if (method === 'POST' && paperMatch?.[2] === 'export-pdf') {
    const paper = db.prepare('SELECT * FROM papers WHERE id = ?').get(paperMatch[1]); if (!paper) return fail(response, 404, '试卷不存在');
    const snapshotRow = db.prepare('SELECT * FROM paper_snapshots WHERE paper_id = ? ORDER BY id DESC LIMIT 1').get(paper.id);
    if (!snapshotRow) return fail(response, 409, '请先确认试卷快照');
    const snapshot = json(snapshotRow.snapshot_json, {}); const pdf = makePdfPlaceholder(paper, snapshot); const pdfPath = path.join(paths.exports, `${paper.id}.pdf`); fs.writeFileSync(pdfPath, pdf); db.prepare('UPDATE paper_snapshots SET pdf_path = ? WHERE id = ?').run(pdfPath, snapshotRow.id); db.prepare('UPDATE papers SET status = \'exported\' WHERE id = ?').run(paper.id);
    return send(response, 200, { fileName: path.basename(pdfPath), downloadUrl: `/api/exports/${paper.id}`, path: pdfPath, bytes: pdf.length, note: '当前骨架已生成本地 PDF 文件；中文字体嵌入和复杂排版将在排版适配器阶段接入。' });
  }
  const exportMatch = pathname.match(/^\/api\/exports\/([^/]+)$/);
  if (method === 'GET' && exportMatch) {
    const snapshot = db.prepare('SELECT pdf_path FROM paper_snapshots WHERE paper_id = ? AND pdf_path != \'\' ORDER BY id DESC LIMIT 1').get(exportMatch[1]);
    if (!snapshot || !fs.existsSync(snapshot.pdf_path)) return fail(response, 404, 'PDF 文件不存在');
    response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${exportMatch[1]}.pdf"` });
    return fs.createReadStream(snapshot.pdf_path).pipe(response);
  }
  return fail(response, 404, '接口不存在');
}
function inputDifficulty(content) { return content.difficulty || 'medium'; }
function paramsStatus(url) { return ['draft', 'pending_review', 'published', 'offline', 'archived'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'draft'; }

function staticFile(response, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.resolve(publicDir, `.${requested}`);
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return fail(response, 404, '页面不存在');
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' }); fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) await api(request, response, url);
    else if (request.method === 'GET') staticFile(response, url.pathname);
    else fail(response, 405, '方法不支持');
  } catch (error) { console.error(error); fail(response, 400, error.message || '请求处理失败'); }
});

server.listen(port, '127.0.0.1', () => console.log(`tiku is running at http://127.0.0.1:${port}`));
