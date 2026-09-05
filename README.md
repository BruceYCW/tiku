# tiku

题库系统项目。

项目部署约束：系统必须支持本地部署，第一阶段不依赖云端服务或需要单独部署的中间件。数据库、缓存和文件均使用本地方案，详见技术设计文档。

## 文档

- [题库系统初始化技术设计](docs/question-bank-technical-design.md)

## 本地运行

要求 Node.js 22 或更高版本。项目不依赖 Redis、对象存储、搜索服务或其他外部中间件。

```powershell
node src/server.js
```

浏览器访问 `http://127.0.0.1:3000/`。默认数据目录为项目根目录下的 `data/`，可用 `TIKU_DATA_DIR` 指定其他位置；备份时需同时复制 `tiku.db` 和 `uploads/`。

当前初始化版本已包含本地 SQLite、文本/DOCX 导入、文本型 PDF 提取、本机 Tesseract 尝试、候选校对、知识点规则分类、草稿发布、题目检索、自动组卷、快照和本地 PDF 文件下载。复杂扫描 PDF、图片 OCR、中文字体排版、手动画布切题和用户权限将在后续适配阶段完善。

## 测试

```powershell
node --test
```
