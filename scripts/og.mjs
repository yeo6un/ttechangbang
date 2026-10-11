// 링크 미리보기 그림(og.png) 만들기: npm run build 후 node scripts/og.mjs
import fs from 'node:fs';
import { chromium } from 'playwright';

const font = fs.readdirSync('dist/assets').find((f) => /black-han-sans-korean.*\.woff2$/.test(f));
const rows = [
  ['#FF4D5E', [[0, 21], [22, 25], [49, 36]]],
  ['#3D8BFF', [[2, 19], [22, 24], [49, 23], [74, 24]]],
  ['#A66BFF', [[0, 21], [22, 25], [74, 24]]],
  ['#FFC93C', [[0, 34], [35, 26], [83, 17]]],
  ['#1FD1C1', [[49, 51]]],
];
const html = `<!doctype html><meta charset="utf-8"><style>
@font-face{font-family:B;src:url(data:font/woff2;base64,${fs.readFileSync('dist/assets/' + font).toString('base64')}) format('woff2')}
body{margin:0;width:1200px;height:630px;background:#161226;color:#FFF8EA;font-family:B,sans-serif;display:flex;flex-direction:column;justify-content:center;padding:0 90px;box-sizing:border-box}
h1{font-size:230px;line-height:.9;margin:0;font-weight:400;letter-spacing:-4px}
p{font:600 44px/1.3 'Noto Sans CJK KR',sans-serif;color:#BDB4DA;margin:26px 0 44px}
.r{position:relative;height:26px;margin-top:9px}
.r i{position:absolute;top:0;bottom:0;border-radius:8px}
.s{border-radius:8px;background:repeating-linear-gradient(90deg,rgba(22,18,38,.55) 0 3px,transparent 3px 8px),#2BD576}
</style><h1>떼창방</h1><p>한 곡을 여럿이 나눠 부르고, 한 곡으로 합쳐요</p>
<div class="r s"></div>${rows.map(([c, clips]) => `<div class="r">${clips.map(([l, w]) => `<i style="left:${l}%;width:${w}%;background:${c}"></i>`).join('')}</div>`).join('')}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: 'web/public/og.png' });
await browser.close();
console.log('web/public/og.png 저장');
