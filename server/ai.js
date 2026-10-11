// Cloudflare Workers AI 호출. env.AI 바인딩이 있을 때만 쓰인다 (무료 할당량 안에서 동작).
// 모델 이름은 환경 변수로 바꿀 수 있다: AI_ASR_MODEL, AI_TEXT_MODEL

const DEFAULT_ASR = '@cf/openai/whisper-large-v3-turbo';
const DEFAULT_TEXT = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

/** 노래 구간을 받아써서 단어별 시각을 얻는다. base64Audio 는 mp3 전체의 base64. */
export async function aiAlign(env, base64Audio, { language, prompt } = {}) {
  const input = { audio: base64Audio, task: 'transcribe', vad_filter: false, condition_on_previous_text: false };
  if (language) input.language = language;
  if (prompt) input.initial_prompt = prompt.slice(0, 400);
  const out = await env.AI.run(env.AI_ASR_MODEL || DEFAULT_ASR, input);
  const words = [];
  const segments = [];
  for (const seg of out?.segments || []) {
    const s = Number(seg.start);
    const e = Number(seg.end);
    if (Number.isFinite(s) && Number.isFinite(e)) segments.push({ s, e, text: String(seg.text || '').trim() });
    for (const w of seg.words || []) {
      const ws = Number(w.start);
      const we = Number(w.end);
      const text = String(w.word || '').trim();
      if (text && Number.isFinite(ws) && Number.isFinite(we)) words.push({ w: text, s: ws, e: Math.max(ws, we) });
    }
  }
  // 단어 시각이 없는 응답이면 문장 단위로라도 채운다
  if (!words.length) {
    for (const g of segments) {
      const parts = g.text.split(/\s+/).filter(Boolean);
      const step = (g.e - g.s) / Math.max(1, parts.length);
      parts.forEach((p, i) => words.push({ w: p, s: g.s + i * step, e: g.s + (i + 1) * step }));
    }
  }
  if (!words.length) throw new Error('no words in transcription');
  return { text: String(out?.text || ''), language: out?.transcription_info?.language || language || '', words, segments };
}

const SPLIT_SYSTEM = `You arrange casual group karaoke covers for friends who are not professional singers.
Split the lyric lines among the singers. Singers are numbered 1..N.

Rules:
1. Every line gets at least one singer.
2. Hook or chorus lines (repeated lines, the climactic lines everyone knows) go to ALL singers.
3. Outside the chorus, give each singer short phrases of 1-3 consecutive lines, and rotate so the same singer does not sing two solo phrases back to back.
4. Balance total singing time between singers. Every singer must get at least one solo or duet line if there are enough lines.
5. Fast, dense lines (rap-like: many syllables per second) should stay with one singer for the whole run.
6. A duet (2 singers) on the line right before a chorus is welcome, but use duets sparingly.
7. Follow the host's notes when given. In notes, "1번" means singer 1.

Answer with JSON only, in this exact shape:
{"lines":[{"i":0,"s":[1]},{"i":1,"s":[2,3]}],"summary":"한국어로 한두 문장. 어떻게 나눴는지 친근하게 설명."}
"i" is the line index, "s" is the list of singer numbers.`;

/** 가사 줄을 인원수에 맞게 나누는 추천을 LLM 에게 받는다. 결과 검증·보정은 클라이언트가 한 번 더 한다. */
export async function aiSplit(env, { title, lines, seatCount, notes }) {
  const listing = lines
    .map((l, i) => {
      const dur = Math.max(0.1, l.t1 - l.t0);
      const syll = (l.text.match(/[가-힣]|[a-zA-Z]+|\d+/g) || []).length;
      return `${i} | ${l.t0.toFixed(1)}s +${dur.toFixed(1)}s | ${(syll / dur).toFixed(1)}/s | ${l.text || '(가사 없음)'}`;
    })
    .join('\n');
  const user = `Song: ${title}\nSingers: ${seatCount}\nHost notes: ${notes || '(none)'}\n\nLines (index | start +duration | syllables per second | text):\n${listing}`;
  const schema = {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        items: {
          type: 'object',
          properties: { i: { type: 'integer' }, s: { type: 'array', items: { type: 'integer' } } },
          required: ['i', 's'],
        },
      },
      summary: { type: 'string' },
    },
    required: ['lines', 'summary'],
  };
  const out = await env.AI.run(env.AI_TEXT_MODEL || DEFAULT_TEXT, {
    messages: [
      { role: 'system', content: SPLIT_SYSTEM },
      { role: 'user', content: user },
    ],
    response_format: { type: 'json_schema', json_schema: schema },
    max_tokens: 2400,
    temperature: 0.4,
  });
  let data = out?.response ?? out?.result?.response ?? out;
  if (typeof data === 'string') {
    const a = data.indexOf('{');
    const b = data.lastIndexOf('}');
    if (a < 0 || b <= a) throw new Error('no json in model output');
    data = JSON.parse(data.slice(a, b + 1));
  }
  if (!data || !Array.isArray(data.lines)) throw new Error('bad model output');
  const assign = {};
  for (const item of data.lines) {
    const i = Number(item?.i);
    if (!Number.isInteger(i) || i < 0 || i >= lines.length || !Array.isArray(item.s)) continue;
    const seats = [];
    for (const s of item.s) {
      const n = Number(s) - 1;
      if (Number.isInteger(n) && n >= 0 && n < seatCount && !seats.includes(n)) seats.push(n);
    }
    if (seats.length) assign[lines[i].id] = seats.sort((x, y) => x - y);
  }
  if (Object.keys(assign).length < Math.ceil(lines.length * 0.5)) throw new Error('model covered too few lines');
  return { assign, summary: String(data.summary || '').slice(0, 300), source: 'ai' };
}
