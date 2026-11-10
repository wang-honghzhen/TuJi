/* ============================================================
 * 程序化「星团 / 螺旋星系」标记生成器
 *
 * 用于会话列表左侧的星团图标（NewLeftSidebar.tsx 的 NEW_SESSION_MARK）。
 *
 * 思路：不依赖外部图片，用固定种子的伪随机数在模块加载时生成一张
 *      螺旋星系的 SVG，转成 data URI 使用：
 *        · 零图片文件、零额外网络请求
 *        · 矢量内容 → 在任意显示尺寸下都清晰（浏览器按实际显示尺寸光栅化）
 *        · 种子固定 → 每次刷新完全一致
 *        · 背景天然透明（不像位图那样带着黑底方块）
 *        · 颜色刻意取自项目的星空调色板，与背景星野同源
 *
 * 结构（自下而上）：
 *   1. 核心光晕   三层同心径向渐变（暖白 → 金 → 橙 → 透明）
 *   2. 旋臂光晕   沿三条臂中心线铺的蓝色径向柔光（垫在尘埃下面）
 *   3. 旋臂尘埃   颗粒沿对数螺旋分布，颜色随半径由暖转冷
 *   4. 外围亮斑   紫 + 蓝两种亮斑，概率随半径递增（核心保持纯暖金）
 *   5. 外围星点   随机散布的小星点
 *   6. 明亮星芒   少量带 X 形锥状光芒的亮星
 *
 * 核心与旋臂都是「粒子 + 光晕」两层结构：
 *   核心 = 金色粒子 + 金色径向渐变
 *   旋臂 = 冷暖渐变粒子 + 蓝色径向柔光
 * ============================================================ */

// 与项目星空调色板同源
const CORE_WHITE = '#fff6e0'; // 核心暖白（也用于星芒）
const CORE_GOLD = '#ffd27a'; // 核心金
const CORE_AMBER = '#f7a44b'; // 核心橙
const ARM_BLUE = '#4f7dfb'; // 外臂深蓝（也用于星点冷色）
const SPOT_PURPLE = '#bf00ff'; // 纯紫亮斑（色相约 285°，落在紫罗兰与品红之间，离深蓝星点足够远）
const SPOT_BLUE = '#00a6ff'; // 蓝亮斑（色相约 200°，比旋臂外缘的 #4f7dfb 更亮更偏青，压在蓝色旋臂上仍能跳出来）
const ARM_GLOW_BLUE = '#3f8cff'; // 旋臂蓝色光晕（比亮斑蓝更深一档，做背景弥漫光而非亮点）

// hover 激活态：亮斑与光带整体转金
const SPOT_GOLD = '#ffd166'; // 激活态亮斑
const ARM_GLOW_GOLD = '#ffb84d'; // 激活态光带

/** 半径 → 颜色 的色带（0 = 星系中心，1 = 最外缘）
 *  注：这里用裸 RGB 而非上面的常量，是为了能在相邻档位之间做线性插值 */
const COLOR_RAMP: Array<[number, [number, number, number]]> = [
  [0.0, [255, 246, 224]], // 暖白核心
  [0.28, [255, 210, 122]], // 金
  [0.55, [247, 164, 75]], // 橙
  [0.78, [127, 157, 255]], // 蓝紫
  [1.0, [79, 125, 251]], // 深蓝
];

function rampColor(t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  for (let i = 0; i < COLOR_RAMP.length - 1; i += 1) {
    const [t0, c0] = COLOR_RAMP[i];
    const [t1, c1] = COLOR_RAMP[i + 1];
    if (clamped <= t1) {
      const k = (clamped - t0) / (t1 - t0);
      const rgb = c0.map((v, j) => Math.round(v + (c1[j] - v) * k));
      return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
    }
  }
  return ARM_BLUE;
}

export interface NewGalaxySpotColor {
  color: string;
  /** 权重（0~1），数组内所有权重之和应为 1 */
  weight: number;
}

/** 默认亮斑配色：紫 + 蓝 */
const DEFAULT_SPOT_PALETTE: NewGalaxySpotColor[] = [
  { color: SPOT_PURPLE, weight: 0.55 },
  { color: SPOT_BLUE, weight: 0.45 },
];

// 按权重取色，直接使用给定的随机值。
function pickWeighted(roll: number, palette: NewGalaxySpotColor[]): string {
  let acc = 0;
  for (const item of palette) {
    acc += item.weight;
    if (roll <= acc) return item.color;
  }
  return palette[palette.length - 1].color;
}

// 固定种子的确定性伪随机算法。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface NewGalaxyOptions {
  /** 画布边长（SVG 用户单位，与显示尺寸无关 —— 矢量内容会自动缩放） */
  size?: number;
  /** 旋臂数量 */
  arms?: number;
  /** 旋臂尘埃颗粒数 */
  dust?: number;
  /** 背景星点数 */
  fieldStars?: number;
  /** 带十字光芒的亮星数 */
  sparkles?: number;
  /** 螺旋缠绕度（越大旋臂卷得越紧） */
  twist?: number;
  /**
   * 外缘亮斑占比（0~1）：这些亮斑会在色带着色之外按概率替换掉一部分尘埃颗粒。
   * 默认配合 spotRadialBias = 1 使用 —— 核心保持纯暖金，亮斑只出现在外缘。
   */
  spotRatio?: number;
  /**
   * 亮斑的径向偏置：
   *   0 = 全盘均匀混合
   *   1 = 只在外缘出现，核心保持纯暖金（默认）
   */
  spotRadialBias?: number;
  /** 亮斑配色与占比（权重和应为 1）。不传则用默认的「紫 + 蓝」 */
  spotPalette?: NewGalaxySpotColor[];
  /**
   * 旋臂蓝色光晕强度（0 = 关闭），默认 1。
   * 核心的金色是「粒子 + 径向渐变」两层，这个参数给三条旋臂补上同样性质的
   * 第二层 —— 沿臂中心线铺一串柔和径向光斑，垫在尘埃下面当弥漫光。
   */
  armGlowStrength?: number;
  /** 旋臂光带的颜色，默认淡蓝 */
  armGlowColor?: string;
  /** 固定种子 */
  seed?: number;
}

/** 把一条中心线 + 各点半宽，转成一条「会收窄的带」的闭合填充路径
 *  stroke 描边的宽度恒定、无法沿路径收窄，所以末端渐隐必须用填充实现：
 *  逐点求切线 → 取法线 → 向两侧偏移半宽，去程走一边、回程走另一边 */
function bandPath(
  pts: Array<[number, number]>,
  halfWidths: number[]
): string {
  const left: string[] = [];
  const right: string[] = [];

  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];

    let tx = next[0] - prev[0];
    let ty = next[1] - prev[1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;

    const nx = -ty; // 法线
    const ny = tx;
    const w = halfWidths[i];

    left.push(`${(p[0] + nx * w).toFixed(1)},${(p[1] + ny * w).toFixed(1)}`);
    right.push(`${(p[0] - nx * w).toFixed(1)},${(p[1] - ny * w).toFixed(1)}`);
  }

  return `M${left.join(' L')} L${right.reverse().join(' L')} Z`;
}

/** 生成螺旋星系的 SVG 源码 */
export function buildGalaxySvg({
  size = 100,
  arms = 3,
  dust = 1400,
  fieldStars = 130,
  sparkles = 5,
  twist = 3.0,
  spotRatio = 0.4,
  spotRadialBias = 1,
  spotPalette,
  armGlowStrength = 1,
  armGlowColor,
  seed = 20240816,
}: NewGalaxyOptions = {}): string {
  const spots = spotPalette && spotPalette.length > 0 ? spotPalette : DEFAULT_SPOT_PALETTE;
  const glowColor = armGlowColor ?? ARM_GLOW_BLUE;
  const rand = mulberry32(seed);
  // 三个均匀随机数求和 → 近似正态，落在约 [-1, 1]
  const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;

  const c = size / 2;
  const maxR = size * 0.45;
  const minR = size * 0.05;

  const defs: string[] = [];
  const body: string[] = [];

  // ---------- 1. 核心光晕 ----------
  defs.push(
    '<radialGradient id="gc">' +
      `<stop offset="0" stop-color="${CORE_WHITE}" stop-opacity="1"/>` +
      `<stop offset="0.22" stop-color="${CORE_GOLD}" stop-opacity="0.85"/>` +
      `<stop offset="0.52" stop-color="${CORE_AMBER}" stop-opacity="0.3"/>` +
      `<stop offset="1" stop-color="${CORE_AMBER}" stop-opacity="0"/>` +
      '</radialGradient>'
  );
  body.push(
    `<circle cx="${c.toFixed(2)}" cy="${c.toFixed(2)}" r="${(size * 0.28).toFixed(2)}" fill="url(#gc)"/>`
  );

  // ---------- 2. 旋臂蓝色光晕 ----------
  // 沿每条臂的中心线描一条高斯模糊的曲线 —— 得到连续的弥漫光带。
  // （试过「沿臂撒一串大半径径向渐变圆斑」，每个圆斑自带亮心，叠起来就是
  //   一堆肉眼可辨的蓝色圆盘，所以改用模糊路径。）
  // 用三段不同长度的曲线叠加：内段只铺最淡的一层，越往外叠加得越多，
  // 于是自然形成「核心留给金色、光晕向外渐强」。
  if (armGlowStrength > 0) {
    defs.push(
      '<filter id="ga" x="-30%" y="-30%" width="160%" height="160%">' +
        '<feGaussianBlur stdDeviation="5"/>' +
        '</filter>'
    );

    // 线宽比早期版本加宽约三成，模糊同步放大以保持柔和
    const LAYERS = [
      { from: 0.3, width: 0.18, opacity: 0.07 },
      { from: 0.58, width: 0.14, opacity: 0.08 },
      { from: 0.8, width: 0.1, opacity: 0.09 },
    ];
    const STEPS = 18;
    /** 末端渐隐的起点（按归一化半径 t）：从 0.75 起把带宽平滑收到 0 */
    const TAPER_FROM = 0.75;

    for (let a = 0; a < arms; a += 1) {
      for (const layer of LAYERS) {
        const pts: Array<[number, number]> = [];
        const halfWidths: number[] = [];

        for (let k = 0; k <= STEPS; k += 1) {
          const t = layer.from + ((1 - layer.from) * k) / STEPS;
          const r = minR + (maxR - minR) * t;
          const angle =
            (a * 2 * Math.PI) / arms + twist * Math.log(r / minR + 0.001);
          pts.push([c + Math.cos(angle) * r, c + Math.sin(angle) * r]);

          // smoothstep 收窄：0.75 之前满宽，之后平滑收到 0
          const k2 = Math.min(1, Math.max(0, (1 - t) / (1 - TAPER_FROM)));
          const taper = k2 * k2 * (3 - 2 * k2);
          halfWidths.push((size * layer.width * taper) / 2);
        }

        body.push(
          `<path d="${bandPath(pts, halfWidths)}" fill="${glowColor}" ` +
            `fill-opacity="${(layer.opacity * armGlowStrength).toFixed(3)}" ` +
            `filter="url(#ga)"/>`
        );
      }
    }
  }

  // ---------- 3. 旋臂尘埃 ----------
  // 颗粒要「多而细」：数量够多才能在视觉上连成连续的旋臂曲线，
  // 单颗够小才不会糊成块状
  for (let i = 0; i < dust; i += 1) {
    const t = Math.pow(rand(), 1.35); // 偏向中心，外围渐稀
    const r = minR + (maxR - minR) * t;

    const armIndex = i % arms;
    const baseAngle =
      (armIndex * 2 * Math.PI) / arms + twist * Math.log(r / minR + 0.001);
    const spread = 0.2 + 0.55 * t; // 旋臂越往外越宽
    const angle = baseAngle + gauss() * spread;

    const rr = r + gauss() * size * 0.014;
    const x = c + Math.cos(angle) * rr;
    const y = c + Math.sin(angle) * rr;

    const radius0 = 0.16 + Math.pow(rand(), 1.6) * 0.55;
    const opacity0 = (0.2 + rand() * 0.55) * (1 - 0.45 * t);

    /* 外圈亮斑：紫 + 蓝两种混搭，尺寸小、贴着旋臂当彩色颗粒。
     * spotRadialBias = 1 —— 概率随半径递增，核心保持纯暖金、亮斑只在外缘。
     * 两次 rand() 都无条件抽取，保证随机序列的推进不受分支影响 */
    const spotRoll = rand();
    const shadeRoll = rand();
    const radialWeight = spotRadialBias * (0.3 + 1.0 * t);
    const spotChance = spotRatio * (1 - spotRadialBias + radialWeight);
    const isSpot = spotRoll < spotChance;

    const radius = isSpot ? radius0 * 1.55 : radius0;
    const opacity = isSpot ? Math.min(1, opacity0 * 1.7) : opacity0;
    const fill = isSpot ? pickWeighted(shadeRoll, spots) : rampColor(t);

    body.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(2)}" ` +
        `fill="${fill}" fill-opacity="${opacity.toFixed(2)}"/>`
    );
  }

  // ---------- 4. 背景星点 ----------
  for (let i = 0; i < fieldStars; i += 1) {
    const angle = rand() * Math.PI * 2;
    // sqrt 分布 → 圆面内均匀撒点
    const rr = Math.sqrt(rand()) * size * 0.49;
    const x = c + Math.cos(angle) * rr;
    const y = c + Math.sin(angle) * rr;
    const radius = 0.14 + Math.pow(rand(), 3) * 0.5;
    const opacity = 0.22 + rand() * 0.55;
    // 星点也掺一点冷色：深蓝为主，少量亮斑紫
    const tintRoll = rand();
    const tint =
      tintRoll < 0.26 ? ARM_BLUE : tintRoll < 0.38 ? spots[0].color : '#ffffff';
    body.push(
      `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${radius.toFixed(2)}" ` +
        `fill="${tint}" fill-opacity="${opacity.toFixed(2)}"/>`
    );
  }

  // ---------- 5. 明亮星芒（中心宽、两端收尖的锥形 X） ----------
  // 尺寸要克制：这是 32px 的小图标，星芒一大就变成扎眼的白色叉号
  for (let i = 0; i < sparkles; i += 1) {
    const angle = rand() * Math.PI * 2;
    const rr = size * (0.18 + rand() * 0.32);
    const x = c + Math.cos(angle) * rr;
    const y = c + Math.sin(angle) * rr;
    const half = 0.7 + rand() * 1.0;
    const waist = 0.11 + rand() * 0.1;
    const opacity = 0.35 + rand() * 0.35;
    const px = x.toFixed(1);
    const py = y.toFixed(1);
    const points =
      `${(x - half).toFixed(2)},${py} ${px},${(y - waist).toFixed(2)} ` +
      `${(x + half).toFixed(2)},${py} ${px},${(y + waist).toFixed(2)}`;

    body.push(
      `<circle cx="${px}" cy="${py}" r="${(waist * 3.2).toFixed(2)}" fill="#ffffff" fill-opacity="0.16"/>`,
      `<polygon points="${points}" fill="${CORE_WHITE}" fill-opacity="${opacity.toFixed(2)}" ` +
        `transform="rotate(45 ${px} ${py})"/>`,
      `<polygon points="${points}" fill="${CORE_WHITE}" fill-opacity="${opacity.toFixed(2)}" ` +
        `transform="rotate(135 ${px} ${py})"/>`
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${size} ${size}">` +
    `<defs>${defs.join('')}</defs>` +
    body.join('') +
    `</svg>`
  );
}

/** 裸 data URI —— 给 <img src> 用（注意不能带 url("") 包装） */
export function buildGalaxySrc(options: NewGalaxyOptions = {}): string {
  return `data:image/svg+xml,${encodeURIComponent(buildGalaxySvg(options))}`;
}

/* ---------- 预设档位 ----------
 * 实测：在 32px 的显示尺寸下，500 / 1400 两档肉眼无法区分
 *      （旋臂细节在这个尺寸下本来就不成立），
 *      差异要到 150px 以上才显现。所以图标用精简档。
 */

/** 会话列表图标：精简档，data URI ≈ 93 KB
 *  3 条旋臂；核心纯暖金，外缘混入紫 / 蓝两种小颗粒亮斑，旋臂带淡蓝光带。
 *  注：spotRatio 是名义值，概率随半径加权（核心不出亮斑），实际约为 0.65 倍 */
export const GALAXY_PRESET_MARK: NewGalaxyOptions = {
  arms: 3,
  dust: 600,
  fieldStars: 90,
  sparkles: 5,
  spotRatio: 0.4,
  spotRadialBias: 1,
};

/** 会话列表里用的星团标记（模块加载时生成一次，之后只是一个字符串常量） */
export const NEW_SESSION_MARK = buildGalaxySrc(GALAXY_PRESET_MARK);

/** 画布按钮和会话图共用的星团显示尺寸。 */
export const GALAXY_MARK_SIZE = 34;

/** 会话按钮 hover / 选中态：同样的几何，但亮斑与旋臂光带全部换成金色。
 *  为什么不做成「只叠一层金色亮斑」：光带是半透明的，叠上去会让底下的
 *  蓝色透出来混成浑浊色，而不是变成金色。所以必须整图交叉淡入淡出。
 *  激活版额外把星芒从 5 颗加到 9 颗 —— 「耀眼」很大程度来自这些闪光点。 */
export const NEW_SESSION_MARK_ACTIVE = buildGalaxySrc({
  ...GALAXY_PRESET_MARK,
  spotPalette: [{ color: SPOT_GOLD, weight: 1 }],
  armGlowColor: ARM_GLOW_GOLD,
  sparkles: 9,
});
