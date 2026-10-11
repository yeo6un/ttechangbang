// Node 로 직접 돌리는 서버 (내 컴퓨터·일반 Node 호스팅용). Cloudflare 없이도 같은 기능이 돈다.
//   npm run build && npm start        → http://localhost:8787
// 환경 변수: PORT, DATA_DIR(기본 ./data), DIST_DIR(기본 ./dist)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { handleApi, purgeExpired } from './api.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8787);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const DIST_DIR = path.resolve(process.env.DIST_DIR || path.join(root, 'dist'));

fs.mkdirSync(DATA_DIR, { recursive: true });
const sdb = new DatabaseSync(path.join(DATA_DIR, 'ttechang.db'));
sdb.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');

const DB = {
  async run(sql, ...params) {
    const r = sdb.prepare(sql).run(...params);
    return { changes: Number(r.changes) };
  },
  async all(sql, ...params) {
    return sdb.prepare(sql).all(...params);
  },
  async get(sql, ...params) {
    return sdb.prepare(sql).get(...params) ?? undefined;
  },
  async batch(list) {
    sdb.exec('BEGIN IMMEDIATE');
    try {
      for (const [sql, ...params] of list) sdb.prepare(sql).run(...params);
      sdb.exec('COMMIT');
    } catch (e) {
      sdb.exec('ROLLBACK');
      throw e;
    }
  },
};
const env = { DB };
// 테스트용 가짜 AI (Cloudflare 없이 AI 화면 흐름을 확인할 때만): MOCK_AI=1 npm start
if (process.env.MOCK_AI) env.AI = (await import('../tests/mock-ai.mjs')).default;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
};

/** 화면(HTML)은 링크 미리보기 그림 주소를 완전한 주소로 바꿔서 준다 */
function sendIndex(res, file, origin) {
  const html = fs.readFileSync(file, 'utf8').replaceAll('content="/og.png"', `content="${origin}/og.png"`);
  res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
  res.end(html);
}

function sendFile(res, file, status = 200) {
  const ext = path.extname(file).toLowerCase();
  const hashed = /\/assets\//.test(file.replaceAll('\\', '/'));
  res.writeHead(status, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 8 * 1024 * 1024) {
          res.writeHead(413, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 'too_large', message: '파일이 너무 커요.' } }));
          return;
        }
        chunks.push(c);
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
      if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', req.socket.remoteAddress || '');
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const request = new Request(url, { method: req.method, headers, body: hasBody ? Buffer.concat(chunks) : undefined });
      const response = await handleApi(request, env, { waitUntil() {} });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let decoded = '/';
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const safe = path.normalize(decoded).replace(/^([/\\])+/, '');
    const file = path.join(DIST_DIR, safe);
    const index = path.join(DIST_DIR, 'index.html');
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    const origin = `${proto}://${req.headers.host || 'localhost'}`;
    // 화면 폴더 밖의 파일은 절대 주지 않는다 (../ 로 빠져나가려는 주소 차단)
    const inside = file === DIST_DIR || file.startsWith(DIST_DIR + path.sep);
    if (inside && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return file === index ? sendIndex(res, index, origin) : sendFile(res, file);
    }
    if (path.extname(safe) === '' && fs.existsSync(index)) return sendIndex(res, index, origin);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(fs.existsSync(index) ? 'Not found' : '먼저 npm run build 로 화면을 만들어 주세요.');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('server error');
  }
});

setInterval(() => purgeExpired(env).catch(() => {}), 3_600_000).unref();
server.listen(PORT, () => console.log(`떼창방 서버: http://localhost:${PORT}  (데이터: ${DATA_DIR})`));
