// 가짜 AI: Cloudflare Workers AI 가 돌려주는 모양(문서 기준)을 흉내 낸다. 화면 흐름 테스트 전용.
//  - 받아쓰기: 연습용 비트의 가사를 조금 틀리게, 시간은 거의 맞게 돌려준다
//  - 파트 추천: 차례로 돌려 가며 나누고 마지막 줄은 모두에게 준다
const BAR = (4 * 60) / 92;
const LEAD = 0.12;
const HEARD = ['하나 둘 셋 시작해', '목소리를 겹쳐봐', '틀려도 그냥 우서', '박자는 대충 가도', '여기는 내가 할께', '다음은 네가 받아', '다 같이 크게 질러 봐', '떼창방에서 만나'];

export default {
  calls: [],
  async run(model, input) {
    this.calls.push({ model, keys: Object.keys(input) });
    if (/whisper/.test(model)) {
      if (typeof input.audio !== 'string' || input.audio.length < 1000) throw new Error('audio must be base64');
      const segments = HEARD.map((text, i) => {
        const start = LEAD + (1 + i) * BAR + 0.04;
        const end = start + BAR - 0.3;
        const ws = text.split(' ');
        const step = (end - start) / ws.length;
        return { start, end, text: ' ' + text, words: ws.map((word, k) => ({ word: ' ' + word, start: start + k * step, end: start + (k + 1) * step - 0.03 })) };
      });
      segments.unshift({ start: 0.3, end: 1.2, text: ' (음악)', words: [{ word: ' 음악', start: 0.3, end: 1.2 }] });
      return { text: segments.map((s) => s.text).join(''), word_count: 30, transcription_info: { language: 'ko', duration: 24 }, segments };
    }
    const user = input.messages[input.messages.length - 1].content;
    // 검색어 다듬기: 한글로 적은 연습용 노래를 가사 데이터베이스의 영어 표기로 바꿔 준다
    if (/music search box/.test(input.messages[0].content)) {
      return { response: { queries: /연습|떼창방/.test(user) ? ['Ttechang Band Practice Song'] : [] } };
    }
    const n = Number(/Singers: (\d+)/.exec(user)?.[1] || 2);
    const count = user.split('\n').filter((l) => /^\d+ \| /.test(l)).length;
    const lines = Array.from({ length: count }, (_, i) => ({ i, s: i === count - 1 ? Array.from({ length: n }, (_, k) => k + 1) : [(i % n) + 1] }));
    // 일부러 한 줄을 빼먹고 없는 사람 번호도 섞는다 → 앱이 고쳐 써야 한다
    lines.splice(2, 1);
    lines[0].s.push(99);
    return { response: { lines, summary: '후렴인 마지막 줄은 다같이, 나머지는 한 줄씩 돌아가며 나눴어요.' } };
  },
};
