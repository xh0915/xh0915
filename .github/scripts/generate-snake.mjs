import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * 自研贡献蛇生成器 v2
 * - 均匀网格铺满（边缘残缺周补空格），格子严格对齐
 * - 有机随机游走路线：偏好直行、向右推进、主动经过有贡献的格子；每日换路线（日期做种子）
 * - 蛇严格在格子上移动；吃到青色食物后变长（3 节起步，封顶 10 节）
 * - 进食动画：青色食物爆开 + 冲击环 + 蛇头闪光
 * - 格子颜色来自真实贡献数据；SMIL 动画，无 JS
 */

const USER = process.env.SNAKE_USER || 'xh0915';
const OUT = 'dist';
const DT = 0.1;                 // 每格耗时（秒）
const H = 7;                    // 一周 7 天
const CELL = 12, GAP = 4, PITCH = CELL + GAP, PAD = 2;
const FADE_IN = 4, FADE_OUT = 5;
const START_LEN = 3, MAX_LEN = 10;
const COOLDOWN = 14;            // 同一格子多少 tick 后才可再进入
const FOOD_FRACTIONS = [0.10, 0.22, 0.34, 0.47, 0.60, 0.74];

const LEVEL_INDEX = { NONE: 0, FIRST_QUADRANT: 1, SECOND_QUADRANT: 2, THIRD_QUADRANT: 3, FOURTH_QUADRANT: 4 };
// GraphQL 的等级枚举偶有无法映射的情况，至少按贡献数保留可见色阶
function levelOf(day) {
  if (!day) return 0;
  const key = String(day.contributionLevel || '').toUpperCase();
  if (Object.hasOwn(LEVEL_INDEX, key)) return LEVEL_INDEX[key];
  return day.contributionCount > 0 ? 4 : 0;
}
const PALETTES = {
  dark:  { empty: '#0c2447', levels: ['#0c2447', '#123566', '#1e4f9e', '#4c73f8', '#8ea6ff'], snake: '#dbe9ff', food: '#6ccbf7', flash: '#6ccbf7' },
  light: { empty: '#edf3fb', levels: ['#edf3fb', '#dbe8ff', '#a9c6ff', '#6f8dff', '#2743d8'], snake: '#0a1b3d', food: '#4aa8dd', flash: '#6ccbf7' },
};

async function fetchCalendar() {
  if (process.env.SNAKE_TEST === '1') {
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

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 有机随机游走：直行偏好 + 向右推进 + 贡献格吸引 + 冷却防卡 */
function buildPath(W, grid, rng) {
  const T = W * H;
  const visit = new Map();
  const key = (r, c) => r * W + c;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]]; // [dc, dr]
  let r = Math.floor(H / 2), c = 0;
  let dir = [1, 0];
  const path = [];
  for (let t = 0; t < T; t++) {
    path.push([c, r]);
    visit.set(key(r, c), t);
    const cands = [];
    let total = 0;
    for (const d of DIRS) {
      if (d[0] === -dir[0] && d[1] === -dir[1]) continue; // 禁止掉头
      const nr = r + d[1], nc = c + d[0];
      if (nr < 0 || nr >= H || nc < 0 || nc >= W) continue;
      const last = visit.get(key(nr, nc));
      const cooled = last === undefined || (t - last) > COOLDOWN;
      let w = cooled ? 1 : 0.04;
      if (d[0] === dir[0] && d[1] === dir[1]) w *= 5;   // 偏好直行（长滑行）
      if (d[0] === 1) w *= 1.6;                          // 整体向右推进
      const day = grid[nr][nc];
      if (levelOf(day) > 0) w *= 1.6; // 被蓝色贡献格吸引
      cands.push({ d, w });
      total += w;
    }
    if (total === 0) { // 卡死兜底：掉头
      dir = [-dir[0], -dir[1]];
      r = Math.max(0, Math.min(H - 1, r + dir[1]));
      c = Math.max(0, Math.min(W - 1, c + dir[0]));
      continue;
    }
    let x = rng() * total;
    let pick = cands[cands.length - 1].d;
    for (const cd of cands) { x -= cd.w; if (x <= 0) { pick = cd.d; break; } }
    dir = pick;
    r += dir[1]; c += dir[0];
  }
  return { path, visit };
}

/** 选进食 tick：间隔均匀，并校验食物格在可见期间没被蛇提前路过 */
function pickEatTicks(path, T) {
  const eatTicks = [];
  for (const f of FOOD_FRACTIONS) {
    let e = Math.round(T * f);
    if (eatTicks.length) e = Math.max(e, eatTicks[eatTicks.length - 1] + 20);
    let guard = 0, ok = false;
    while (guard++ < 300 && e < T - FADE_OUT - 2) {
      const r0 = eatTicks.length === 0 ? FADE_IN + 2 : eatTicks[eatTicks.length - 1] + 4;
      if (e - r0 < 8) { e += 6; continue; }
      const [fc, fr] = path[e];
      let clash = false;
      for (let tt = r0; tt < e; tt++) { if (path[tt][0] === fc && path[tt][1] === fr) { clash = true; break; } }
      if (!clash) { ok = true; break; }
      e += 6;
    }
    if (!ok) break;
    eatTicks.push(e);
  }
  return eatTicks;
}

function buildSvg(weeks, pal) {
  const W = weeks.length;
  const pad = new Date(weeks[0].contributionDays[0].date + 'T00:00:00Z').getUTCDay();
  const grid = Array.from({ length: H }, () => Array(W).fill(null));
  weeks.forEach((week, c) => {
    week.contributionDays.forEach((day, k) => { grid[(pad + k) % H][c] = day; });
  });

  const seed = Math.floor(Date.now() / 86400000) ^ (W * 7919);
  const { path } = buildPath(W, grid, mulberry32(seed));
  const T = path.length;
  const dur = (T * DT).toFixed(2);
  const eatTicks = pickEatTicks(path, T);
  const nSeg = Math.min(MAX_LEN, START_LEN + eatTicks.length);
  const appear = i => (i < START_LEN ? 0 : eatTicks[i - START_LEN]);
  const cx = ([c, r]) => c * PITCH + PAD + CELL / 2;
  const cy = ([c, r]) => r * PITCH + PAD + CELL / 2;
  const kt = v => (Math.round(Math.min(Math.max(v, 0), 1) * 1e6) / 1e6).toFixed(6).replace(/0+$/, '0');

  let s = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W * PITCH + PAD * 2}" height="${H * PITCH + PAD * 2}" viewBox="0 0 ${W * PITCH + PAD * 2} ${H * PITCH + PAD * 2}" role="img" aria-label="contribution snake">`;
  s += `<defs><filter id="gl" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
  s += `<path id="route" d="M${path.map(([c, r]) => `${cx([c, r]) - CELL / 2} ${cy([c, r]) - CELL / 2}`).join('L')}"/></defs>`;

  // 贡献格子
  s += '<g>';
  for (let r = 0; r < H; r++) {
    for (let c = 0; c < W; c++) {
      const day = grid[r][c];
      const lv = levelOf(day);
      const tip = day && day.contributionCount > 0 ? `<title>${day.date} · ${day.contributionCount} contributions</title>` : '';
      s += `<rect x="${cx([c, r]) - CELL / 2}" y="${cy([c, r]) - CELL / 2}" width="${CELL}" height="${CELL}" rx="3" fill="${pal.levels[lv]}">${tip}</rect>`;
    }
  }
  s += '</g>';

  // 食物：待在格子里轻微等待 → 被吃瞬间放大爆开 + 冲击环
  s += '<g>';
  eatTicks.forEach((e, f) => {
    const r0 = f === 0 ? FADE_IN + 2 : eatTicks[f - 1] + 4;
    const x = cx(path[e]), y = cy(path[e]);
    s += `<g transform="translate(${x},${y})">`
      + `<rect x="${-CELL / 2}" y="${-CELL / 2}" width="${CELL}" height="${CELL}" rx="3" fill="${pal.food}" filter="url(#gl)" opacity="0">`
      + `<animate attributeName="opacity" dur="${dur}s" repeatCount="indefinite" calcMode="linear" keyTimes="0;${kt(r0 / T)};${kt((r0 + 1) / T)};${kt(e / T)};${kt((e + 3) / T)};1" values="0;0;1;1;0;0"/>`
      + `<animateTransform attributeName="transform" type="scale" dur="${dur}s" repeatCount="indefinite" calcMode="linear" keyTimes="0;${kt(e / T)};${kt((e + 3) / T)};1" values="1;1;1.9"/>`
      + `</rect>`
      + `<rect x="${-CELL / 2}" y="${-CELL / 2}" width="${CELL}" height="${CELL}" rx="3" fill="none" stroke="${pal.food}" stroke-width="2" opacity="0">`
      + `<animate attributeName="opacity" dur="${dur}s" repeatCount="indefinite" calcMode="linear" keyTimes="0;${kt(e / T)};${kt((e + 0.4) / T)};${kt((e + 3.5) / T)};1" values="0;0;0.9;0;0"/>`
      + `<animateTransform attributeName="transform" type="scale" dur="${dur}s" repeatCount="indefinite" calcMode="linear" keyTimes="0;${kt(e / T)};${kt((e + 3.5) / T)};1" values="1;1;2.4"/>`
      + `</rect></g>`;
  });
  s += '</g>';

  // 蛇：逐格滑行；到达出现 tick 时挂上尾巴；头在进食瞬间闪光
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
      + `<animate attributeName="opacity" dur="${dur}s" repeatCount="indefinite" calcMode="linear" keyTimes="${ktTail}" values="${vTail}"/>`;
    if (head) {
      const ft = [0], fv = [pal.snake];
      for (const e of eatTicks) { ft.push(kt(e / T), kt((e + 1) / T)); fv.push(pal.flash, pal.snake); }
      ft.push('1'); fv.push(pal.snake);
      s += `<animate attributeName="fill" dur="${dur}s" repeatCount="indefinite" calcMode="discrete" keyTimes="${ft.join(';')}" values="${fv.join(';')}"/>`;
    }
    s += '</rect>';
  }
  s += '</g></svg>';
  return s;
}

try {
  const weeks = await fetchCalendar();
  const VER = process.env.SNAKE_VER || '';
  const suffix = VER ? `.${VER}` : '';
  mkdirSync(OUT, { recursive: true });
  for (const [name, pal] of Object.entries(PALETTES)) {
    const svg = buildSvg(weeks, pal);
    writeFileSync(`${OUT}/contribution-snake-${name}${suffix}.svg`, svg);
    console.log(`contribution-snake-${name}${suffix}.svg  ${(svg.length / 1024).toFixed(1)}KB`);
  }
  console.log(`OK grid=${weeks.length}x${H}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
