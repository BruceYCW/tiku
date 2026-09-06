import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiku-test-'));
const port = 3100 + Math.floor(Math.random() * 500);
const server = spawn(process.execPath, ['src/server.js'], { cwd: path.resolve(import.meta.dirname, '..'), env: { ...process.env, PORT: String(port), TIKU_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('测试服务启动超时');
}
async function request(pathname, options) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const payload = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.arrayBuffer();
  assert.equal(response.ok, true, JSON.stringify(payload));
  return payload.data ?? payload;
}

test.before(async () => waitForHealth());
test.after(async () => {
  server.kill();
  await once(server, 'close').catch(() => {});
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('本地题库主流程可运行', async () => {
  const banks = await request('/api/question-banks');
  assert.ok(banks.length > 0);
  const points = await request('/api/knowledge-points');
  const text = '1. 集合的概念题目？\nA. 选项一\nB. 选项二\n【答案】A\n【解析】这是解析内容。\n\n2. 第二道判断题。';
  const imported = await request('/api/imports/papers', { method: 'POST', body: JSON.stringify({ bankId: banks[0].id, year: '2025', title: '本地测试卷', fileName: 'sample.txt', fileType: 'txt', text }) });
  assert.equal(imported.candidateCount, 2);
  const job = await request(`/api/imports/${imported.id}`);
  assert.equal(job.candidates.length, 2);
  assert.ok(job.candidates[0].knowledgePointIds.length > 0);
  const candidate = job.candidates[0];
  assert.deepEqual(candidate.answer, ['A']);
  assert.equal(candidate.analysis, '这是解析内容。');
  const savedCandidate = await request(`/api/imports/${imported.id}/candidates/${candidate.id}`, { method: 'PUT', body: JSON.stringify({ type: 'single_choice', answer: ['B'], analysis: '校对后的解析。', content: { type: 'single_choice', stem: '集合的概念校对题？', options: [{ key: 'A', text: '选项一' }, { key: 'B', text: '选项二' }], tags: ['本地测试'], attachments: [] }, knowledgePointIds: [points[0].id] }) });
  assert.deepEqual(savedCandidate.answer, ['B']);
  assert.equal(savedCandidate.analysis, '校对后的解析。');
  await request(`/api/imports/${imported.id}/candidates/${candidate.id}/crop`, { method: 'POST', body: JSON.stringify({ selection: { unit: 'relative', x: 0.1, y: 0.2, width: 0.8, height: 0.7 } }) });
  const reviewedCandidate = await request(`/api/imports/${imported.id}`);
  assert.equal(reviewedCandidate.candidates[0].selection.width, 0.8);
  const confirmation = await request(`/api/imports/${imported.id}/confirm`, { method: 'POST', body: '{}' });
  assert.equal(confirmation.count, 2);
  const publishedAll = await request('/api/questions/publish-all', { method: 'POST', body: JSON.stringify({ sourceJobId: imported.id }) });
  assert.equal(publishedAll.total, 2);
  assert.equal(publishedAll.publishedCount, 2);
  assert.equal(publishedAll.failedCount, 0);
  const search = await request(`/api/questions/search?bankId=${banks[0].id}&keyword=${encodeURIComponent('集合的概念校对题')}`);
  assert.ok(search.items.some((item) => item.content.stem.includes('集合的概念校对题')));
  assert.equal('answer_json' in search.items[0], false);

  const paper = await request('/api/papers/generate', { method: 'POST', body: JSON.stringify({ name: '自动测试卷', rule: { bankId: banks[0].id, typeCounts: { single_choice: 1 }, scores: { single_choice: 10 } } }) });
  assert.equal(paper.selectedCount, 1);
  const preview = await request(`/api/papers/${paper.id}`);
  assert.equal(preview.questions.length, 1);
  await request(`/api/papers/${paper.id}/confirm`, { method: 'POST', body: '{}' });
  const exported = await request(`/api/papers/${paper.id}/export-pdf`, { method: 'POST', body: '{}' });
  assert.ok(exported.downloadUrl);
  const pdf = await request(exported.downloadUrl);
  assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), '%PDF-');

  const manual = await request('/api/imports/papers', { method: 'POST', body: JSON.stringify({ bankId: banks[0].id, year: '2025', title: '手动框选测试卷', fileName: 'manual.txt', fileType: 'txt', text: '原始页内容', manualCut: true }) });
  assert.equal(manual.candidateCount, 0);
  assert.equal(manual.pageCount, 1);
  const manualJob = await request(`/api/imports/${manual.id}`);
  assert.equal(manualJob.paper_year, '2025');
  assert.equal(manualJob.paper_title, '手动框选测试卷');
  const segment = await request(`/api/imports/${manual.id}/segments`, { method: 'POST', body: JSON.stringify({ mode: 'box', number: 1, parts: [{ pageNo: 1, role: 'stem', coordinateSpace: 'pdf', rect: { x: 30, y: 50, width: 520, height: 150 } }, { pageNo: 1, role: 'image', coordinateSpace: 'pdf', rect: { x: 80, y: 220, width: 200, height: 120 } }] }) });
  assert.equal(segment.content.parts.length, 2);
  const appended = await request(`/api/imports/${manual.id}/segments/${segment.id}`, { method: 'PUT', body: JSON.stringify({ stem: '跨页测试题', parts: [...segment.content.parts, { pageNo: 1, role: 'stem', coordinateSpace: 'pdf', rect: { x: 30, y: 400, width: 520, height: 150 } }] }) });
  assert.equal(appended.page_start, 1);
  assert.equal(appended.page_end, 1);
  const manualConfirmation = await request(`/api/imports/${manual.id}/confirm`, { method: 'POST', body: '{}' });
  assert.equal(manualConfirmation.count, 1);
  assert.equal(manualConfirmation.results[0].success, true);
  const manualDrafts = await request(`/api/questions/review?sourceJobId=${manual.id}&status=draft`);
  assert.equal(manualDrafts.total, 1);
  assert.equal(manualDrafts.items[0].status, 'draft');
  await request(`/api/questions/${manualConfirmation.importedQuestionIds[0]}/publish`, { method: 'POST', body: '{}' });
  const publishedManual = await request(`/api/questions/search?bankId=${banks[0].id}&keyword=${encodeURIComponent('跨页测试题')}`);
  assert.equal(publishedManual.total, 1);
  assert.equal(publishedManual.items[0].source_job_id, manual.id);
  assert.equal(publishedManual.items[0].sourcePages.length, 1);
  const chineseKeyword = await request(`/api/questions/search?bankId=${banks[0].id}&keyword=${encodeURIComponent('集合')}`);
  assert.ok(chineseKeyword.items.some((item) => item.content.stem.includes('集合')));
  const paperWithImportedQuestion = await request('/api/papers/generate', { method: 'POST', body: JSON.stringify({ name: '图片题预览测试卷', rule: { bankId: banks[0].id, typeCounts: { short_answer: 1 }, scores: { short_answer: 10 } } }) });
  const paperWithSource = await request(`/api/papers/${paperWithImportedQuestion.id}`);
  assert.ok(paperWithSource.questions.some((item) => item.content.parts?.length));
  await request(`/api/questions/${manualConfirmation.importedQuestionIds[0]}`, { method: 'DELETE' });
  const deletedSearch = await request(`/api/questions/search?bankId=${banks[0].id}&keyword=${encodeURIComponent('跨页测试题')}`);
  assert.equal(deletedSearch.total, 0);
  const batchDelete = await request('/api/questions/delete-batch', { method: 'POST', body: JSON.stringify({ ids: [confirmation.importedQuestionIds[0], confirmation.importedQuestionIds[1]] }) });
  assert.equal(batchDelete.deletedCount, 2);
  const batchDeletedSearch = await request(`/api/questions/search?bankId=${banks[0].id}&keyword=${encodeURIComponent('集合的概念校对题')}`);
  assert.equal(batchDeletedSearch.total, 0);
  const cleared = await request(`/api/imports/${manual.id}/segments/clear`, { method: 'POST', body: '{}' });
  assert.equal(cleared.cleared, true);
});
