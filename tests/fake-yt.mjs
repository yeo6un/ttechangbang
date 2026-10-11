// 가짜 유튜브 플레이어 + 가짜 마이크. 자동 테스트에서 브라우저 안에 심어 쓴다 (page.addInitScript).
// 진짜 유튜브에는 닿을 수 없는 환경에서도 "영상에 맞춰 녹음하고 합쳐 듣는" 흐름 전체를 확인하려는 것이다.
//
// 가짜 세상의 규칙
//  - 영상: 재생 중이면 영상 위치 = base + (지금 − t0). 0.25초마다 (영상 위치, 그 순간의 시각)을 앱에 알려 준다.
//    영상에는 소리가 없다. 대신 "가수"가 영상에 맞춰 소리를 낸다.
//  - 가수: 영상에서 가사 줄이 시작되는 순간마다 짧은 소리를 낸다. 그 소리는 지연(latency)이 있는 마이크로 들어온다.
//  - 마이크 지연은 앱의 "싱크 미리 맞춰 두기"(시험 소리)로 잴 수 있다.
export function fakeWorld(opts) {
  // 심어 둔 스크립트는 안쪽 틀(iframe)에서도 돌기 때문에, 맨 바깥 화면에서만 차린다
  if (window.top !== window) return;
  const T = (window.__ttbTest = {
    opts,
    singing: false,
    /** 구간이 영상의 어디에서 시작하는지 (테스트가 방 정보를 보고 넣어 준다) */
    segStart: 0,
    /** 가수가 소리를 낼 구간 시각들 */
    clickTimes: [],
    players: [],
    voices: [],
    voiceErrors: [],
    plays: [],
    scheduled: [],

    // ───── 마이크 ─────
    micFactory(ctx) {
      const dest = ctx.createMediaStreamDestination();
      const delay = ctx.createDelay(1);
      delay.delayTime.value = opts.latency;
      const voice = ctx.createGain();
      voice.connect(delay);
      delay.connect(dest);
      const noise = ctx.createBufferSource();
      const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const nd = nb.getChannelData(0);
      for (let i = 0; i < nd.length; i++) nd[i] = (Math.random() * 2 - 1) * 0.001;
      noise.buffer = nb;
      noise.loop = true;
      noise.connect(dest);
      noise.start();
      const calibGain = ctx.createGain();
      calibGain.gain.value = 0.3;
      calibGain.connect(delay);
      T.calibGain = calibGain;
      T.voice = voice;
      T.micCtx = ctx;
      T.watch(ctx);
      return dest.stream;
    },
    onCalibrate(node) {
      if (T.calibGain) node.connect(T.calibGain);
    },
    onGraph() {},
    onPlay(info) {
      T.plays.push(info);
    },

    /**
     * 벽시계(performance.now, 초) → 그 순간 귀에 들리는 소리 시계 값. 브라우저가 알려 주는 값을 그대로 믿되,
     * 한 번 읽은 값은 소리 처리 주기에 따라 몇 ms 씩 흔들리므로 최근 1초의 가운데 값을 쓴다.
     */
    aSamples: [],
    watch(ctx) {
      if (T.watching === ctx) return;
      T.watching = ctx;
      T.aSamples = [];
      clearInterval(T.watchTimer);
      T.watchTimer = setInterval(() => {
        if (ctx.state !== 'running') return;
        const ts = ctx.getOutputTimestamp();
        if (!(ts.contextTime > 0)) return;
        T.aSamples.push(ts.contextTime - ts.performanceTime / 1000);
        if (T.aSamples.length > 25) T.aSamples.shift();
      }, 40);
    },
    audibleOffset(ctx) {
      T.watch(ctx);
      if (T.aSamples.length >= 5) {
        const v = [...T.aSamples].sort((x, y) => x - y);
        return v[v.length >> 1];
      }
      const ts = ctx.getOutputTimestamp();
      return ts.contextTime - ts.performanceTime / 1000;
    },

    /**
     * 영상이 돌기 시작하면: 가사 줄 시작마다 가수가 소리를 낸다.
     * 진짜 가수처럼 그때그때 영상을 따라가도록, 조금 뒤(0.2초 안)에 시작할 줄만 그때그때 예약한다.
     */
    sing(p) {
      clearInterval(T.singTimer);
      for (const o of T.scheduled) {
        try {
          o.stop();
          o.disconnect();
        } catch {}
      }
      T.scheduled = [];
      const ctx = T.micCtx;
      if (!ctx || !T.voice || !T.singing) return;
      T.watch(ctx);
      const done = new Set();
      const step = () => {
        if (p.dead || p.state !== 1 || !T.singing) return clearInterval(T.singTimer);
        const now = performance.now() / 1000;
        const A = T.audibleOffset(ctx);
        for (const s of T.clickTimes) {
          if (done.has(s)) continue;
          const video = T.segStart + s;
          if (video < p.base - 0.001) {
            done.add(s);
            continue;
          }
          const wall = p.t0 / 1000 + (video - p.base);
          if (wall - now > 0.2) continue; // 아직 멀었다 (진짜 가수처럼 닥쳐서 낸다)
          done.add(s);
          const at = A + wall;
          if (at < ctx.currentTime + 0.02) continue; // 이미 지나갔다
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.frequency.value = 880;
          g.gain.setValueAtTime(0, 0);
          g.gain.setValueAtTime(0.5, at);
          g.gain.exponentialRampToValueAtTime(0.001, at + 0.3);
          osc.connect(g).connect(T.voice);
          osc.start(at);
          osc.stop(at + 0.35);
          T.scheduled.push(osc);
        }
      };
      T.singTimer = setInterval(step, 50);
      step();
    },

    /** 앱이 목소리를 영상에 맞춰 깔 때마다: 앱이 잡은 싱크가 참값과 얼마나 다른지 적어 둔다 */
    onYtVoices({ tZero, from, segStart }) {
      const p = T.players.filter((x) => !x.dead && x.state === 1).pop();
      const ctx = T.lib?.getCtx?.();
      if (!p || !ctx) return;
      const truth = segStart - (p.base - p.t0 / 1000) + T.audibleOffset(ctx);
      T.voices.push({ tZero, from, errorMs: (tZero - truth) * 1000 });
    },

    // ───── 유튜브 플레이어 ─────
    ytFactory(mount, videoId, cb) {
      const meta = (opts.videos && opts.videos[videoId]) || { len: 24, title: videoId, author: 'fake' };
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'fake-yt';
      el.textContent = `▶ 가짜 영상 ${videoId}`;
      el.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#1b2a4a;color:#cfe0ff;font:600 14px sans-serif';
      mount.appendChild(el);
      const p = { id: videoId, state: -1, base: 0, t0: 0, len: meta.len, vol: 100, tapped: false, timer: 0, pending: 0, starts: 0, dead: false, ad: null, adDone: !opts.ad, seeksInAd: 0 };
      const now = () => performance.now();
      const adTime = () => (p.ad.paused ? p.ad.at : (now() - p.ad.t0) / 1000);
      const media = () => (p.ad ? adTime() : p.state === 1 ? Math.min(p.len, p.base + (now() - p.t0) / 1000) : p.base);
      const setState = (s) => {
        p.state = s;
        cb.onState(s);
      };
      const report = () => {
        if (p.state !== 1 || p.dead) return;
        const m = media();
        if (m >= p.len - 0.001) {
          p.base = p.len;
          clearInterval(p.timer);
          setState(0);
          return;
        }
        // 실제 플레이어처럼 "위치를 잰 시각"을 함께 알려 주되, 약간의 오차를 섞는다
        const jitter = (opts.jitterMs || 0) * (Math.random() * 2 - 1);
        cb.onTime(m, now() + jitter);
      };
      /**
       * 영상 앞 광고 (opts.ad = { sec, len, state }): 첫 재생 때 sec 초 동안 광고가 돈다.
       * 그동안 플레이어는 광고의 시각(0부터)과 광고의 길이(len)를 알려 주고, 옮기라는 말(seekTo)은 듣지 않는다.
       * state 1: 광고가 도는 동안 "재생 중"이라고 알린다. state -1: 영상이 시작되기 전까지 "시작 전"으로 남는다.
       * 광고가 끝나면 영상은 맨 앞에서 시작한다 (광고 전에 옮겨 둔 위치는 잊는다: 가장 고약한 경우).
       */
      const startAd = () => {
        clearTimeout(p.pending);
        clearInterval(p.timer);
        if (!p.ad) p.ad = { t0: now(), at: 0, paused: false };
        else if (p.ad.paused) {
          p.ad.t0 = now() - p.ad.at * 1000;
          p.ad.paused = false;
        }
        setState(opts.ad.state === 1 ? 1 : -1);
        p.timer = setInterval(() => {
          if (p.dead || !p.ad) return;
          const t = adTime();
          if (t >= opts.ad.sec) {
            clearInterval(p.timer);
            p.ad = null;
            p.adDone = true;
            p.base = 0;
            begin();
            return;
          }
          cb.onTime(t, now());
        }, opts.reportMs || 250);
      };
      const begin = () => {
        if (!p.adDone) return startAd();
        clearTimeout(p.pending);
        clearInterval(p.timer);
        setState(3);
        p.pending = setTimeout(() => {
          if (p.dead) return;
          // 틀어 봐야 알 수 있는 막힘: 올린 사람이 다른 사이트에서의 재생을 막아 둔 영상
          if (meta.blockedOnPlay) return cb.onError(150);
          p.t0 = now();
          p.starts++;
          setState(1);
          p.timer = setInterval(report, opts.reportMs || 250);
          report();
          T.sing(p);
        }, opts.startDelayMs ?? 150);
      };
      const api = {
        playVideo() {
          if (opts.blockAutoplay && !p.tapped) return; // 휴대폰처럼: 영상을 직접 한 번 눌러야 재생된다
          if (p.ad && !p.ad.paused) return; // 광고가 도는 중
          if (p.state === 1 || p.state === 3) return;
          begin();
        },
        pauseVideo() {
          clearTimeout(p.pending);
          clearInterval(p.timer);
          if (p.ad) {
            if (!p.ad.paused) {
              p.ad.at = adTime();
              p.ad.paused = true;
              setState(2);
            }
            return;
          }
          if (p.state === 1) p.base = media();
          if (p.state === 1 || p.state === 3) setState(2);
        },
        seekTo(s) {
          if (p.ad) {
            p.seeksInAd++; // 광고 중에는 듣지 않는다
            return;
          }
          const was = p.state;
          p.base = Math.max(0, Math.min(p.len, s));
          p.t0 = now();
          if (was === 1) begin();
        },
        getCurrentTime: () => media(),
        getDuration: () => (p.ad ? (opts.ad.len ?? opts.ad.sec) : p.len),
        getPlayerState: () => p.state,
        setVolume(v) {
          p.vol = v;
        },
        getVideoData: () => ({ title: meta.title, author: meta.author }),
        destroy() {
          p.dead = true;
          clearInterval(p.timer);
          clearTimeout(p.pending);
          el.remove();
        },
      };
      el.addEventListener('click', () => {
        p.tapped = true;
        if (p.ad && !p.ad.paused) api.pauseVideo();
        else if (p.state === 1) api.pauseVideo();
        else begin();
      });
      p.media = media;
      p.api = api;
      T.players.push(p);
      setTimeout(() => (meta.blocked ? cb.onError(150) : cb.onReady()), 60);
      return api;
    },
  });

  if (opts.realApi) {
    // 앱이 진짜 길(IFrame API)을 타도록 끼우는 자리를 비운다. 영상의 참값은 흉내 플레이어가 알려 준다.
    T.ytFactory = undefined;
    const bySource = new Map();
    window.addEventListener('message', (e) => {
      if (!/^https:\/\/www\.youtube\.com$/.test(e.origin)) return;
      let d;
      try {
        d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (!d || d.event !== 'ttbTruth') return;
      let p = bySource.get(e.source);
      if (!p) {
        p = { id: 'stub', state: -1, base: 0, t0: 0, dead: false };
        bySource.set(e.source, p);
        T.players.push(p);
      }
      p.state = d.info.state;
      p.base = d.info.base;
      p.t0 = performance.now() - (Date.now() - d.info.t0Epoch);
      p.media = () => (p.state === 1 ? p.base + (performance.now() - p.t0) / 1000 : p.base);
      if (p.state === 1) T.sing(p);
    });
  }
}

/**
 * 유튜브 IFrame API 자체를 흉내 낸다 (tests/e2e-ytapi.mjs).
 * 위의 가짜 플레이어는 앱 안의 "플레이어 끼우는 자리"에 바로 들어가지만, 이쪽은 앱이 실제로 쓰는 길을 그대로 탄다:
 *   https://www.youtube.com/iframe_api 스크립트를 불러오고 → YT.Player 를 만들고 → 다른 사이트(youtube.com)의 틀과
 *   postMessage 로 명령·알림을 주고받는다.
 * stamp: 알림에 "영상 위치를 잰 시각"을 넣을지. block: 영상을 직접 눌러야만 재생되는지.
 */
export async function stubYouTubeApi(context, { stamp = true, block = false, len = 24.07 } = {}) {
  const API = `(function () {
  var seq = 0;
  function Player(el, config) {
    var self = this;
    this.info = { playerState: -1, currentTime: 0, duration: 0, videoData: {}, playbackRate: 1 };
    var iframe = document.createElement('iframe');
    iframe.width = config.width || 640;
    iframe.height = config.height || 360;
    iframe.setAttribute('frameborder', '0');
    iframe.setAttribute('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share');
    var pv = config.playerVars || {};
    var qs = Object.keys(pv).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(pv[k]); }).join('&');
    iframe.src = 'https://www.youtube.com/embed/' + config.videoId + '?' + qs + '&widgetid=' + ++seq;
    el.parentNode.replaceChild(iframe, el);
    this.iframe = iframe;
    var ev = config.events || {};
    this.onMsg = function (e) {
      if (e.source !== iframe.contentWindow) return;
      var d;
      try { d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (x) { return; }
      if (!d) return;
      if (d.event === 'infoDelivery') {
        for (var k in d.info) self.info[k] = d.info[k];
        if ('currentTime' in d.info) self.info.receivedAt = Date.now() / 1000;
      } else if (d.event === 'onReady') { ev.onReady && ev.onReady({ target: self }); }
      else if (d.event === 'onStateChange') { self.info.playerState = d.info; ev.onStateChange && ev.onStateChange({ target: self, data: d.info }); }
      else if (d.event === 'onError') { ev.onError && ev.onError({ target: self, data: d.info }); }
    };
    window.addEventListener('message', this.onMsg);
  }
  var P = Player.prototype;
  P.cmd = function (func, args) { this.iframe.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [] }), '*'); };
  P.playVideo = function () { this.cmd('playVideo'); };
  P.pauseVideo = function () { this.cmd('pauseVideo'); };
  P.seekTo = function (s, ahead) { this.cmd('seekTo', [s, ahead]); };
  P.setVolume = function (v) { this.cmd('setVolume', [v]); };
  P.unMute = function () { this.cmd('unMute'); };
  P.setPlaybackRate = function (r) { this.cmd('setPlaybackRate', [r]); };
  P.getCurrentTime = function () {
    var i = this.info;
    return i.playerState === 1 && i.receivedAt ? i.currentTime + (Date.now() / 1000 - i.receivedAt) : i.currentTime;
  };
  P.getDuration = function () { return this.info.duration || 0; };
  P.getPlayerState = function () { return this.info.playerState; };
  P.getVideoData = function () { return this.info.videoData; };
  P.getIframe = function () { return this.iframe; };
  P.destroy = function () { window.removeEventListener('message', this.onMsg); this.iframe.remove(); };
  window.YT = { Player: Player, PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } };
  if (window.onYouTubeIframeAPIReady) window.onYouTubeIframeAPIReady();
})();`;
  const EMBED = `<!doctype html><meta charset="utf-8">
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#2a1b3a;color:#e9d8ff;font:600 14px sans-serif">
<button id="b" style="all:unset;cursor:pointer;padding:40px">▶ 흉내 유튜브 플레이어</button>
<script>
var LEN = ${len}, STAMP = ${stamp}, BLOCK = ${block};
var st = -1, base = 0, t0 = 0, timer = 0, pending = 0, tapped = false;
function now() { return performance.now(); }
function media() { return st === 1 ? Math.min(LEN, base + (now() - t0) / 1000) : base; }
function send(o) { parent.postMessage(JSON.stringify(o), '*'); }
// 테스트가 참값을 알 수 있게, 재생이 시작된 순간을 벽시계(Date.now)로 알려 준다
function truth() { send({ event: 'ttbTruth', info: { state: st, base: base, t0Epoch: Date.now() - (now() - t0) } }); }
function setState(s) { st = s; send({ event: 'infoDelivery', info: { playerState: s } }); send({ event: 'onStateChange', info: s }); truth(); }
function report() {
  if (st !== 1) return;
  var m = media();
  if (m >= LEN - 0.001) { base = LEN; clearInterval(timer); setState(0); return; }
  var info = { currentTime: m };
  if (STAMP) info.currentTimeLastUpdated_ = Date.now() / 1000;
  send({ event: 'infoDelivery', info: info });
}
function begin() {
  clearTimeout(pending); clearInterval(timer); setState(3);
  pending = setTimeout(function () { t0 = now(); setState(1); timer = setInterval(report, 250); report(); }, 150);
}
var api = {
  playVideo: function () { if (BLOCK && !tapped) return; if (st === 1 || st === 3) return; begin(); },
  pauseVideo: function () { clearTimeout(pending); clearInterval(timer); if (st === 1) base = media(); if (st === 1 || st === 3) setState(2); },
  seekTo: function (s) { var was = st; base = Math.max(0, Math.min(LEN, s)); t0 = now(); send({ event: 'infoDelivery', info: { currentTime: base } }); if (was === 1) begin(); },
  setVolume: function () {},
  unMute: function () {},
  setPlaybackRate: function () {},
};
addEventListener('message', function (e) {
  var d; try { d = JSON.parse(e.data); } catch (x) { return; }
  if (d && d.event === 'command' && api[d.func]) api[d.func].apply(null, d.args || []);
});
document.getElementById('b').onclick = function () { tapped = true; if (st === 1) api.pauseVideo(); else begin(); };
send({ event: 'infoDelivery', info: { duration: LEN, videoData: { title: '흉내 영상', author: '흉내 채널' } } });
setTimeout(function () { send({ event: 'onReady' }); }, 80);
</script>`;
  await context.route('https://www.youtube.com/iframe_api', (route) => route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: API }));
  await context.route('https://www.youtube.com/embed/**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: EMBED }));
}

/** Apple 곡 검색(JSONP)을 흉내 낸다: 한글 이름으로 찾으면 연습용 노래 하나가 나온다 */
export async function fakeApple(context) {
  await context.route('https://itunes.apple.com/**', async (route) => {
    const url = new URL(route.request().url());
    const cb = url.searchParams.get('callback') || 'cb';
    let results = [];
    if (url.pathname === '/search') {
      const term = (url.searchParams.get('term') || '').toLowerCase();
      if (/연습/.test(term)) {
        results = [
          { wrapperType: 'track', kind: 'song', trackId: 9001, trackName: '연습용 노래', artistName: '떼창방 밴드', collectionName: '떼창방 1집', trackTimeMillis: 24000, artworkUrl100: 'https://example.com/100x100bb.jpg' },
          { wrapperType: 'track', kind: 'song', trackId: 9002, trackName: '연습용 노래 (Live)', artistName: '떼창방 밴드', collectionName: '떼창방 라이브', trackTimeMillis: 61000 },
        ];
      }
    } else if (url.pathname === '/lookup') {
      if (url.searchParams.get('id') === '9001') results = [{ kind: 'song', trackId: 9001, trackName: 'Practice Song', artistName: 'Ttechang Band', trackTimeMillis: 24000 }];
      if (url.searchParams.get('id') === '9002') results = [{ kind: 'song', trackId: 9002, trackName: 'Practice Song (Live)', artistName: 'Ttechang Band', trackTimeMillis: 61000 }];
    }
    await route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: `${cb}(${JSON.stringify({ resultCount: results.length, results })});` });
  });
}

/** Apple 곡 검색이 막힌 환경 (광고 차단 등) */
export async function blockApple(context) {
  await context.route('https://itunes.apple.com/**', (route) => route.abort());
}

/**
 * 싱크 오차 판정. 테스트 기계가 바쁘면 브라우저의 소리 처리가 잠깐 밀릴 때가 있고(수십 ms),
 * 가짜 가수는 소리를 조금 앞서 예약하기 때문에 마침 그 순간에 걸린 한 줄은 어긋나 보인다.
 * 그래서 가장 나쁜 한 곳은 빼고 본다. 돌려주는 값: { typical: 그다음으로 나쁜 값, worst: 가장 나쁜 값 }
 */
export function judgeSync(errorsMs) {
  const sorted = errorsMs.map((e) => Math.abs(e)).sort((a, b) => a - b);
  const worst = sorted[sorted.length - 1] ?? Infinity;
  const typical = sorted.length >= 3 ? sorted[sorted.length - 2] : worst;
  return { typical, worst };
}
