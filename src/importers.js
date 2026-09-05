import fs from 'node:fs';
import childProcess from 'node:child_process';
import zlib from 'node:zlib';
import path from 'node:path';

function decodeXml(value) {
  return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function readZipEntries(buffer) {
  const end = Math.max(0, buffer.length - 65557);
  let eocd = -1;
  for (let index = buffer.length - 22; index >= end; index -= 1) {
    if (buffer.readUInt32LE(index) === 0x06054b50) { eocd = index; break; }
  }
  if (eocd < 0) throw new Error('DOCX 文件不是有效的 ZIP 容器');
  const count = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('DOCX 中央目录损坏');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(start, start + compressedSize);
    entries.set(name, method === 0 ? compressed : zlib.inflateRawSync(compressed));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function docxText(buffer) {
  const xml = readZipEntries(buffer).get('word/document.xml');
  if (!xml) throw new Error('DOCX 缺少 word/document.xml');
  const source = xml.toString('utf8');
  const paragraphs = [...source.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)].map((match) => {
    const paragraph = match[0].replace(/<w:tab\s*\/?>/g, '\t').replace(/<w:br\s*\/?>/g, '\n');
    return [...paragraph.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map((text) => decodeXml(text[1])).join('');
  }).filter(Boolean);
  return paragraphs.join('\n');
}

function pdfText(buffer) {
  const source = buffer.toString('latin1');
  const text = [...source.matchAll(/\((?:\\.|[^)])*\)\s*Tj/g)].map(([value]) => value.slice(1, value.lastIndexOf(')')).replace(/\\([\\()])/g, '$1')).join('\n');
  return text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
}

function localOcr(filePath) {
  try {
    const executable = process.platform === 'win32' ? childProcess.execFileSync('where.exe', ['tesseract'], { encoding: 'utf8', timeout: 2000 }).split(/\r?\n/)[0] : 'tesseract';
    return childProcess.execFileSync(executable, [filePath, 'stdout', '-l', 'chi_sim+eng'], { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

function pythonPdfText(filePath) {
  const script = "import sys; from PyPDF2 import PdfReader; print('\\f'.join((page.extract_text() or '') for page in PdfReader(sys.argv[1]).pages))";
  try { return childProcess.execFileSync('python', ['-X', 'utf8', '-c', script, filePath], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 }).trim(); } catch { return ''; }
}

function pdfTextFallback(buffer) {
  const source = buffer.toString('latin1');
  return [...source.matchAll(/\((?:\\.|[^)])*\)\s*Tj/g)].map(([value]) => value.slice(1, value.lastIndexOf(')')).replace(/\\([\\()])/g, '$1')).join('\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim();
}

function renderPdfPages(filePath, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  try { childProcess.execFileSync(process.platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm', ['-png', '-r', '144', filePath, path.join(outputDir, 'page')], { timeout: 120000, maxBuffer: 1024 * 1024 }); } catch { return []; }
  return fs.readdirSync(outputDir).filter((name) => /^page-\d+\.png$/.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0])).map((name) => path.join(outputDir, name));
}

function splitPages(text) { return String(text || '').split(/\f/).map((page) => page.trim()).filter(Boolean); }

export function parseImportContent({ type, buffer, filePath, pageOutputDir, providedText = '' }) {
  let text = providedText.trim(); let source = 'provided-text'; let message = ''; let pageImages = [];
  if (!text && type === 'txt') { text = buffer.toString('utf8').trim(); source = 'text'; }
  if (!text && type === 'docx') { text = docxText(buffer); source = 'docx-parser'; if (!text) message = 'DOCX 未提取到可识别文本，可能只包含图片'; }
  if (!text && type === 'pdf') { text = pythonPdfText(filePath) || pdfTextFallback(buffer); source = text ? 'pdf-local-text' : 'pdf-render'; if (!text) message = 'PDF 未提取到文本，已渲染页面；请安装本地 OCR 适配器处理扫描内容'; }
  if (type === 'pdf' && pageOutputDir) pageImages = renderPdfPages(filePath, pageOutputDir);
  if (!text && ['png', 'jpg', 'jpeg'].includes(type)) { text = localOcr(filePath); source = 'tesseract'; if (!text) message = '未检测到可用的本地 Tesseract OCR，原文件已保存，任务等待 OCR 适配器处理'; }
  const pages = splitPages(text).map((pageText, index) => ({ pageNo: index + 1, text: pageText, imagePath: pageImages[index] || '' }));
  if (!pages.length && pageImages.length) pageImages.forEach((imagePath, index) => pages.push({ pageNo: index + 1, text: '', imagePath }));
  return { text, pages, pageImages, source, message };
}
