import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * 自研贡献蛇生成器
 * - 铺满均匀网格（边缘残缺周补空格），格子严格对齐
 * - 蛇按格子逐格移动（serpentine 路线覆盖每一个格子）
 * - 吃到紫色食物后变长（3 节起步，封顶 10 节）
 * - 格子颜色来自真实贡献数据；SMIL 动画，无 JS，可被 <img> 直接渲染
 */

const USER = process.env.SNAKE_USER || 'xh0915';
const OUT = 'dist';
const DT = 0.1;                 // 每格耗时（秒）
const H = 7;                    // 一周 7 天
const CELL = 12, GAP = 4, PITCH = CELL + GAP, PAD = 2;
const FADE_IN = 4, FADE_OUT = 5; // 循环首尾的淡入淡出 ticks
const START_LEN = 3, MAX_LEN = 10;
const FOOD_FRACTIONS = [0.10, 0.22, 0.34, 0.47, 0.60, 0.74];

const LEVEL_INDEX = { NONE: 0, FIRST_QUADRANT: 1, SECOND_QUADRANT: 2, THIRD_QUADRANT: 3, FOURTH_QUADRANT: 4 };
const PALETTES = {
  dark:  { empty: '#161b22', greens: ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'], snake: '#39d353', food: '#a371f7' },
  light: { empty: '#ebedf0', greens: ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39'], snake: '#26a641', food: '#8250df' },
};

async function fetchCalendar() {
  if (process.env.SNAKE_TEST === '1') {
    // 本地验证用的合成贡献数据
    const weeks = [];
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const start = Date.UTC(2025, 9, 26);
    const names = ['NONE', 'FIRST_QUADRANT', 'SECOND_QUADRANT', 'THIRD_QUADRANT', 'FOURTH_QUADRANT'];
    for (let w = 0; w < 53; w++) {
      const days = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start + (w * 7 + d) * 86400000);
        const r = rnd();
        const lv = r > 0.93 ? 4 : r > 0.85 ? 3 : r > 0.72 ? 2 : r > 0.55 ? 1 : 0;
        days.push({ date: date.toISOString().slice(0, 10), contributionLevel: names[lv], contributionCount: lv * 2 });
      }
      weeks.push({ contributionDays: days });
    }
    return weeks;
  }
  const query = `query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks { contributionDays { date contributionLevel contributionCount } }
        }
      }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error('GraphQL: ' + JSON.stringify(json.errors));
  return json.data.user.contributionsCollection.contributionCalendar.weeks;
}

function buildSvg(weeks, pal) {
  const W = weeks.length;
  // 网格：按首日星期补齐行偏移，边缘缺日视为空格
  const pad = new Date(weeks[0].contributionDays[0].date + 'T00:00:00Z').getUTCDay();
  const grid = Array.from({ length: H }, () => Array(W).fill(null));
  weeks.forEach((week, c) => {
    week.contributionDays.forEach((day, k) => {
      grid[(pad + k) % H][c] = day;
    });
  });

  // 蛇的路线：逐列蛇形遍历，覆盖每个格子
  const path = [];
  for (let c = 0; c < W; c++) {
    if (c % 2 === 0) { for (let r = 0; r < H; r++) path.push([c, r]); }
    else { for (let r = H - 1; r >= 0; r--) path.push([c, r]); }
  }
  const T = path.length;
  const dur = (T * DT).toFixed(2);
  const eatTicks = FOOD_FRACTIONS.map(f => Math.round(T * f));
  const nSeg = Math.min(MAX_LEN, START_LEN + eatTicks.length);
  const appear = i => (i < START_LEN ? 0 : eatTicks[i - START_LEN]);
  const fx = ([c, r]) => c * PITCH + PAD;
  const fy = ([c, r]) => r * PITCH + PAD;
  const kt = v => (Math.round(v * 1e6) / 1e6).toFixed(6).replace(/0+$/, '0');

  let s = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W * PITCH + PAD * 2}" height="${H * PITCH + PAD * 2}" viewBox="0 0 ${W * PITCH + PAD * 2} ${H * PITCH + PAD * 2}" role="img" aria-label="contribution snake">`;
  s += `<defs><filter id="gl" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  s += `<path id="route" d="M${path.map(([c, r]) => `${fx([c, r])} ${fy([c, r])}`).join('L')}"/></defs>`;

  // 贡献格子（均匀铺满）
  s += '<g>';
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const day = grid[r][c];
      const lv = day ? (LEVEL_INDEX[day.contributionLevel] ?? 0) : 0;
      const fill = pal.greens[lv];
      const tip = day && day.contributionCount > 0 ? `<title>${day.date} · ${day.contributionCount} contributions</title>` : '';
      s += `<rect x="${fx([c, r])}" y="${fy([c, r])}" width="${CELL}" height="${CELL}" rx="3" fill="${fill}">${tip}</rect>`;
    }
  }
  s += '</g>';

  // 食物（紫色格子，蛇靠近前出现、吃掉后消失）
  s += '<g>';
  eatTicks.forEach((e, f) => {
    const r0 = f === 0 ? FADE_IN + 2 : eatTicks[f - 1] + 4;
    const [c, r] = path[e];
    s += `<rect x="${fx([c, r])}" y="${fy([c, r])}" width="${CELL}" height="${CELL}" rx="3" fill="${pal.food}" filter="url(#gl)" opacity="0">`
      + `<animate attributeName="opacity" dur="${dur}s" repeatCount="indefinite" calcMode="linear" `
      + `keyTimes="0;${kt(r0 / T)};${kt((r0 + 1) / T)};${kt(e / T)};${kt((e + 1) / T)};1" values="0;0;1;1;0;0"/></rect>`;
  });
  s += '</g>';

  // 蛇（逐格跳跃；第 i 节比头晚 i 格出发；到达出现 tick 时挂上尾巴并常驻）
  s += '<g>';
  for (let i = 0; i < nSeg; i++) {
    const a = appear(i);
    const head = i === 0;
    const ktTail = a > FADE_IN
      ? `0;${kt(a / T)};${kt((a + 1) / T)};${kt((T - FADE_OUT) / T)};${kt((T - 1) / T)};1`
      : `0;${kt(FADE_IN / T)};${kt((T - FADE_OUT) / T)};${kt((T - 1) / T)};1`;
    const vTail = a > FADE_IN ? '0;0;1;1;0;0' : '0;1;1;0;0';
    s += `<rect width="${CELL}" height="${CELL}" rx="3" fill="${pal.snake}" opacity="0"${head ? ' filter="url(#gl)"' : ''}>`
      + `<animateMotion dur="${dur}s" begin="${(-i * DT).toFixed(2)}s" repeatCount="indefinite"><mpath href="#route" xlink:href="#route"/></animateMotion>`
      + `<animate attributeName="opacity" dur="${dur}s" repeatCount="indefinite" calcMode="linear" keyTimes="${ktTail}" values="${vTail}"/></rect>`;
  }
  s += '</g></svg>';
  return s;
}

try {
  const weeks = await fetchCalendar();
  mkdirSync(OUT, { recursive: true });
  for (const [name, pal] of Object.entries(PALETTES)) {
    const svg = buildSvg(weeks, pal);
    writeFileSync(`${OUT}/contribution-snake-${name}.svg`, svg);
    console.log(`contribution-snake-${name}.svg  ${(svg.length / 1024).toFixed(1)}KB`);
  }
  console.log(`OK grid=${weeks.length}x${H}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
