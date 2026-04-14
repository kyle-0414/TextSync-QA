import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { spawn, ChildProcess } from 'child_process';

const app = express();
const PORT = 3005;

const ROOT_DIR = path.resolve(__dirname, '..');
const SPEC_PATH = path.join(ROOT_DIR, 'data/spec/flag-spec.csv');
const RESULTS_PATH = path.join(ROOT_DIR, 'data/exports/live_results.json');
const CACHE_PATH = path.join(ROOT_DIR, 'data/exports/verification_cache.json');
const SCREENSHOT_DIR = path.join(ROOT_DIR, 'data/screenshots');

let runnerProcess: ChildProcess | null = null;
let isRunning = false;

app.use(cors());
app.use(express.static(path.join(ROOT_DIR, 'data/dashboard'), { etag: false, maxAge: 0, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate'); } }));
app.use('/screenshots', express.static(SCREENSHOT_DIR));

app.post('/api/run', (req, res) => {
  if (isRunning) return res.json({ success: false, message: '이미 실행 중입니다.' });
  isRunning = true;
  console.log('🚀 [Runner] Starting automation...');
  runnerProcess = spawn('npm', ['start'], { cwd: ROOT_DIR, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  runnerProcess.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
  runnerProcess.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  runnerProcess.on('close', (code) => { console.log(`🏁 [Runner] Exited with code ${code}`); isRunning = false; runnerProcess = null; });
  runnerProcess.on('error', (err) => { console.error('❌ [Runner] Spawn error:', err.message); isRunning = false; runnerProcess = null; });
  res.json({ success: true });
});

app.get('/api/status', (req, res) => { res.json({ isRunning }); });

// [개선] 리셋 시 스크린샷 파일도 모두 삭제
app.post('/api/reset', (req, res) => {
  try {
    if (fs.existsSync(CACHE_PATH)) fs.unlinkSync(CACHE_PATH);
    if (fs.existsSync(RESULTS_PATH)) fs.unlinkSync(RESULTS_PATH);
    
    // 스크린샷 폴더 비우기
    if (fs.existsSync(SCREENSHOT_DIR)) {
      const files = fs.readdirSync(SCREENSHOT_DIR);
      for (const file of files) {
        const fullPath = path.join(SCREENSHOT_DIR, file);
        if (fs.lstatSync(fullPath).isFile()) fs.unlinkSync(fullPath);
      }
      console.log('🧹 [RESET] Screenshots cleared.');
    }
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/audit', (req, res) => {
  try {
    if (!fs.existsSync(SPEC_PATH)) return res.json([]);
    const specContent = fs.readFileSync(SPEC_PATH, 'utf-8');
    const specs = parse(specContent, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
    let cache: any = {};
    if (fs.existsSync(CACHE_PATH)) cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));

    const auditData = specs.map((s: any) => {
      const cached = cache[s.UIDisplayName] || cache[s.FlagName];
      return {
        ...s,
        status: cached ? cached.status : 'PENDING',
        slideId: cached ? cached.firstTestId : '-',
        actualMeaning: cached ? (cached.actualMeaning || '') : '',
        actualAction: cached ? (cached.actualAction || '') : '',
        actualName: (cached && cached.actualName !== undefined) ? cached.actualName : null,
        screenshot: cached ? (cached.screenshotPath || null) : null
      };
    });
    res.json(auditData);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.get('/api/logs', (req, res) => {
  try {
    if (fs.existsSync(RESULTS_PATH)) {
      const data = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf-8'));
      res.json(data.results || []);
    } else res.json([]);
  } catch { res.json([]); }
});

app.listen(PORT, () => { console.log(`🚀 DASHBOARD SERVER: http://localhost:${PORT}`); });
