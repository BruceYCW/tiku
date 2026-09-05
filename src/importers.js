import fs from 'node:fs';
import childProcess from 'node:child_process';
import zlib from 'node:zlib';

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

export function parseImportContent({ type, buffer, filePath, providedText = '' }) {
  if (providedText.trim()) return { text: providedText.trim(), source: 'provided-text', message: '' };
  if (type === 'txt') return { text: buffer.toString('utf8').trim(), source: 'text', message: '' };
  if (type === 'docx') {
    const text = docxText(buffer);
    return { text, source: 'docx-parser', message: text ? '' : 'DOCX 未提取到可识别文本，可能只包含图片' };
  }
  if (type === 'pdf') {
    let text = '';
    try { text = childProcess.execFileSync(process.platform === 'win32' ? 'pdftotext.exe' : 'pdftotext', ['-layout', filePath, '-'], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 }); } catch { text = pdfText(buffer); }
    return { text: text.trim(), source: 'pdf-text', message: text.trim() ? '' : 'PDF 未提取到文本，请安装本地 OCR 或配置扫描 PDF 处理器' };
  }
  if (['png', 'jpg', 'jpeg'].includes(type)) {
    const text = localOcr(filePath);
    return { text, source: 'tesseract', message: text ? '' : '未检测到可用的本地 Tesseract OCR，原文件已保存，任务等待 OCR 适配器处理' };
  }
  return { text: '', source: 'unsupported', message: '当前格式没有本地解析器' };
}
