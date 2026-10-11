// Cloudflare Worker 진입점: /api/* 는 API, 나머지는 정적 화면 파일.
import { Buffer } from 'node:buffer';
import { handleApi, purgeExpired } from './api.js';

globalThis.Buffer ??= Buffer;

let cached = null; // { d1, adapter }

function adapterFor(d1) {
  if (cached && cached.d1 === d1) return cached.adapter;
  const adapter = {
    async run(sql, ...params) {
      const r = await d1.prepare(sql).bind(...params).run();
      return { changes: r.meta?.changes ?? 0 };
    },
    async all(sql, ...params) {
      const r = await d1.prepare(sql).bind(...params).all();
      return r.results || [];
    },
    async get(sql, ...params) {
      return (await d1.prepare(sql).bind(...params).first()) ?? undefined;
    },
    async batch(list) {
      await d1.batch(list.map(([sql, ...params]) => d1.prepare(sql).bind(...params)));
    },
  };
  cached = { d1, adapter };
  return adapter;
}

function apiEnv(env) {
  return { DB: adapterFor(env.DB), AI: env.AI, AI_ASR_MODEL: env.AI_ASR_MODEL, AI_TEXT_MODEL: env.AI_TEXT_MODEL };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return handleApi(request, apiEnv(env), ctx);
    const res = await env.ASSETS.fetch(request);
    // 화면(HTML)을 줄 때는 링크 미리보기 그림 주소를 완전한 주소로 바꿔 준다 (카카오톡 등은 상대 주소를 못 읽는 경우가 있다)
    if (request.method === 'GET' && (res.headers.get('content-type') || '').includes('text/html')) {
      const html = (await res.text()).replaceAll('content="/og.png"', `content="${url.origin}/og.png"`);
      const headers = new Headers(res.headers);
      headers.delete('content-length');
      headers.delete('etag');
      headers.set('cache-control', 'no-cache');
      return new Response(html, { status: res.status, headers });
    }
    return res;
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(purgeExpired(apiEnv(env)));
  },
};
