/**
 * scene.js —— 抽象背景 / 灯光 / 环境
 *
 * 与香蕉人那套同源（全程序化、零贴图），配色换成石榴主题：
 * 宝石红 / 酒红 / 金 —— 温暖、有果肉汁水的质感。
 *
 *   · 天穹：大球体（BackSide）+ fbm 流动的暗红金色场
 *   · 地面：扭曲色场，fbm 驱动的环流色带向外溶解于虚空（不用规整网格）
 *   · 流体金属泡：高金属度、低粗糙度的异形几何体，靠环境贴图出流动高光
 *   · 石榴籽星域：上千个点粒子缓慢漂移
 *   · 断裂巨环：远处侧后方的抽象弧线（绝不围绕角色，否则会横穿主体）
 *   · 光斑：canvas 现场生成的径向渐变 Sprite，克制使用
 */

import * as THREE from '../vendor/three.module.js';

/* ------------------------------------------------------------------ */
/* 程序化生成径向渐变光斑贴图                                           */
/* ------------------------------------------------------------------ */
export function makeGlowTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, inner.replace(/[\d.]+\)$/, '0.45)'));
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------------ */
/* 共用 GLSL 片段：自包含的线性 -> sRGB 转换 + 值噪声 + fbm             */
/*   不依赖 three 动态注入的 linearToOutputTexel，语法自检能独立解析       */
/* ------------------------------------------------------------------ */
const GLSL_COMMON = /* glsl */`
vec3 bmToSRGB(vec3 c) {
  return mix(
    c * 12.92,
    1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), c)
  );
}

float bmHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.23, 0.37));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float bmNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(bmHash(i + vec3(0,0,0)), bmHash(i + vec3(1,0,0)), f.x),
        mix(bmHash(i + vec3(0,1,0)), bmHash(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(bmHash(i + vec3(0,0,1)), bmHash(i + vec3(1,0,1)), f.x),
        mix(bmHash(i + vec3(0,1,1)), bmHash(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}
float bmFbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    v += a * bmNoise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return v;
}
`;

/* ------------------------------------------------------------------ */
/* 天穹                                                                */
/* ------------------------------------------------------------------ */
const SKY_VERT = /* glsl */`
  varying vec3 vWorldPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const SKY_FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3  uColorA;   // 顶部深色
  uniform vec3  uColorB;   // 中部主色
  uniform vec3  uColorC;   // 地平线亮色
  uniform vec3  uColorD;   // 点缀（金）
  varying vec3  vWorldPos;
${GLSL_COMMON}
  void main() {
    vec3 dir = normalize(vWorldPos);
    float h = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);

    vec3 col = mix(uColorC, uColorB, smoothstep(0.28, 0.62, h));
    col = mix(col, uColorA, smoothstep(0.58, 1.0, h));

    // 金色流带：只做提亮，不能整片刷上去（那会把整个天穹洗成一种颜色）
    float az = atan(dir.z, dir.x);
    vec3 q = vec3(cos(az) * 2.2, dir.y * 2.6, sin(az) * 2.2);
    float band = bmFbm(q + vec3(0.0, uTime * 0.045, uTime * 0.03));
    band = smoothstep(0.42, 0.92, band);
    float horizon = smoothstep(0.18, 0.55, h) * (1.0 - smoothstep(0.62, 1.0, h));
    col = mix(col, uColorD, band * horizon * 0.30);

    // 第二层：大尺度色团，混向主色造出「酒红 / 金」对比
    float warp = bmFbm(vec3(dir.x * 1.1, dir.y * 1.4 + uTime * 0.02, dir.z * 1.1));
    col = mix(col, uColorB, smoothstep(0.55, 1.0, warp) * 0.40);
    float ridge = 1.0 - smoothstep(0.0, 0.16, abs(warp - 0.45));
    col = mix(col, uColorD, ridge * 0.14);

    col += uColorC * pow(1.0 - smoothstep(0.0, 0.30, h), 3.0) * 0.20;

    // 暗角（边界顺序必须递增，1 - smoothstep 才是"越靠下越暗"）
    float vig = 1.0 - smoothstep(0.02, 0.20, h);
    col *= 1.0 - vig * 0.15;

    gl_FragColor = vec4(bmToSRGB(col), 1.0);
  }
`;

/* ------------------------------------------------------------------ */
/* 地面：扭曲色场                                                       */
/* ------------------------------------------------------------------ */
const FLOOR_VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FLOOR_FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3  uColorA;
  uniform vec3  uColorB;
  uniform vec3  uColorC;
  uniform float uOpacity;
  varying vec2  vUv;
  varying vec3  vWorldPos;
${GLSL_COMMON}
  void main() {
    vec2 p = vUv * 2.0 - 1.0;
    float r = length(p);
    float a = atan(p.y, p.x);

    float w = bmFbm(vec3(p * 2.6, uTime * 0.05));
    float w2 = bmFbm(vec3(p * 5.2 + 13.0, uTime * 0.08));
    float rr = r + (w - 0.5) * 0.30;
    float rings = sin(rr * 12.0 - uTime * 0.80 + w2 * 5.0) * 0.5 + 0.5;
    rings = pow(rings, 2.6);

    float swirl = sin(a * 6.0 + r * 9.0 - uTime * 0.50 + w * 4.0) * 0.5 + 0.5;
    swirl = pow(swirl, 3.0);

    vec3 col = mix(uColorA, uColorB, smoothstep(0.0, 1.0, r));
    col = mix(col, uColorC, rings * 0.30);
    col = mix(col, uColorC, swirl * 0.18 * (1.0 - smoothstep(0.1, 0.9, r)));
    col += uColorC * pow(1.0 - clamp(r, 0.0, 1.0), 3.0) * 0.20;

    // 向外溶解于虚空：地面没有硬边界
    float alpha = uOpacity * (1.0 - smoothstep(0.32, 0.98, r));
    gl_FragColor = vec4(bmToSRGB(col), alpha);
  }
`;

/* ------------------------------------------------------------------ */
/* 程序化环境贴图                                                       */
/*   neutral=true 时返回「亮灰中性天光」，专供角色照明——              */
/*   背景再花也不该把主角染成背景色（这是香蕉人踩过的坑）。             */
/* ------------------------------------------------------------------ */
function makeEnvTexture(theme, opts = {}) {
  const { neutral = false } = opts;
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');

  const g = ctx.createLinearGradient(0, 0, 0, H);
  const hex = (v) => '#' + new THREE.Color(v).getHexString();
  if (neutral) {
    g.addColorStop(0.00, '#eef0ff');
    g.addColorStop(0.45, '#c2c6da');
    g.addColorStop(0.70, '#74778e');
    g.addColorStop(1.00, '#2a2430');
  } else {
    g.addColorStop(0.00, hex(theme.skyA));
    g.addColorStop(0.42, hex(theme.skyB));
    g.addColorStop(0.62, hex(theme.skyC));
    g.addColorStop(0.80, hex(theme.ground));
    g.addColorStop(1.00, '#0d0409');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  const spots = [
    [0.30, 0.22, 90, theme.key],
    [0.74, 0.40, 70, theme.fill],
    [0.52, 0.30, 76, theme.rimc],
  ];
  for (const [u, v, r, color] of spots) {
    const rg = ctx.createRadialGradient(u * W, v * H, 0, u * W, v * H, r);
    const col = new THREE.Color(color);
    const rgb = `${(col.r * 255) | 0},${(col.g * 255) | 0},${(col.b * 255) | 0}`;
    rg.addColorStop(0, `rgba(${rgb},0.95)`);
    rg.addColorStop(0.45, `rgba(${rgb},0.30)`);
    rg.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, W, H);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ------------------------------------------------------------------ */
/* 主构建函数                                                          */
/* ------------------------------------------------------------------ */
export function createScene(renderer) {
  const scene = new THREE.Scene();

  /* ---------- 配色：石榴主题 ---------- */
  const THEMES = {
    ruby: {   // 宝石红（默认）
      skyA: 0x2a0710, skyB: 0x8e1430, skyC: 0x3d0d22, skyD: 0xffb43a,
      fog: 0x2a0a16, grid: 0xff5f7a, ground: 0x25060f,
      key: 0xfff0c8, fill: 0xff5f7a, rimc: 0xffb43a,
      floorA: 0x4a0f22, floorB: 0x14040c, floorC: 0xffa53a,
    },
    gold: {   // 蜜金
      skyA: 0x2b1a04, skyB: 0xb06a12, skyC: 0x4a2a06, skyD: 0xffe08a,
      fog: 0x2a1a05, grid: 0xffc247, ground: 0x241505,
      key: 0xfff6d8, fill: 0xffa53a, rimc: 0xffe08a,
      floorA: 0x5a3608, floorB: 0x180d02, floorC: 0xffd35e,
    },
    juice: {  // 果汁紫红
      skyA: 0x1c0526, skyB: 0x7a1050, skyC: 0x2e0838, skyD: 0xff7ab8,
      fog: 0x1e0722, grid: 0xd44bff, ground: 0x180520,
      key: 0xffe6f6, fill: 0xff4f9e, rimc: 0xd47aff,
      floorA: 0x360a3c, floorB: 0x100310, floorC: 0xff7ab8,
    },
  };
  let themeName = 'ruby';
  let theme = THEMES[themeName];

  /* ---------- 天穹 ---------- */
  const skyUniforms = {
    uTime: { value: 0 },
    uColorA: { value: new THREE.Color(theme.skyA) },
    uColorB: { value: new THREE.Color(theme.skyB) },
    uColorC: { value: new THREE.Color(theme.skyC) },
    uColorD: { value: new THREE.Color(theme.skyD) },
  };
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(60, 48, 32),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  sky.name = 'sky';
  scene.add(sky);

  scene.fog = new THREE.FogExp2(theme.fog, 0.034);

  // 背景环境（彩色，金属泡用）
  let envTex = makeEnvTexture(theme);
  scene.environment = envTex;
  scene.environmentIntensity = 0.85;

  // 角色专用中性环境
  let characterEnv = makeEnvTexture(theme, { neutral: true });
  function setCharacterEnv(target) {
    target.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (m && 'envMap' in m) {
          m.envMap = characterEnv;
          m.envMapIntensity = 1.15;
          m.needsUpdate = true;
        }
      }
    });
  }

  /* ---------- 灯光 ---------- */
  const hemi = new THREE.HemisphereLight(0xffe4dc, 0x6b5460, 0.74);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(theme.key, 1.55);
  key.position.set(4.2, 7.5, 5.0);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 26;
  const sc = 5.2;
  key.shadow.camera.left = -sc;
  key.shadow.camera.right = sc;
  key.shadow.camera.top = sc;
  key.shadow.camera.bottom = -sc;
  key.shadow.bias = -0.0016;
  key.shadow.normalBias = 0.022;
  // 改完 near/far/left/right 必须刷新投影矩阵，否则阴影仍按默认视锥计算
  key.shadow.camera.updateProjectionMatrix();
  scene.add(key);

  // 补光用偏中性的方向光：彩色点光源会把角色一侧直接染成主题色
  const fill = new THREE.DirectionalLight(0xffd8d8, 0.80);
  fill.position.set(-4.0, 3.0, -3.2);
  scene.add(fill);

  const rim = new THREE.DirectionalLight(theme.rimc, 0.75);
  rim.position.set(3.0, 1.2, -4.4);
  scene.add(rim);

  const back = new THREE.DirectionalLight(0xffffff, 0.55);
  back.position.set(-1.5, 2.4, -5.0);
  scene.add(back);

  /* ---------- 地面：扭曲色场 ---------- */
  const floorUniforms = {
    uTime: { value: 0 },
    uColorA: { value: new THREE.Color(theme.floorA) },
    uColorB: { value: new THREE.Color(theme.floorB) },
    uColorC: { value: new THREE.Color(theme.floorC) },
    uOpacity: { value: 0.60 },
  };
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(56, 56, 1, 1),
    new THREE.ShaderMaterial({
      uniforms: floorUniforms,
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      transparent: true,
      depthWrite: false,
      fog: false,
      side: THREE.DoubleSide,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.085;
  ground.name = 'ground';
  ground.receiveShadow = false;
  scene.add(ground);

  /* ---------- 抽象漂浮体 ---------- */
  const floatGroup = new THREE.Group();
  floatGroup.name = 'floaters';
  scene.add(floatGroup);
  const floaters = [];

  const rnd = (() => {
    let s = 20261007;
    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
  })();

  // 石榴籽造型的金属泡：用球体压扁/拉长做「籽」，再混几个扭结体
  const blobGeo = [
    new THREE.SphereGeometry(0.72, 26, 20),
    new THREE.TorusKnotGeometry(0.52, 0.17, 128, 20, 2, 3),
    new THREE.IcosahedronGeometry(0.76, 1),
    new THREE.TorusGeometry(0.68, 0.22, 20, 64),
    new THREE.SphereGeometry(0.60, 24, 18),
    new THREE.TorusKnotGeometry(0.46, 0.15, 96, 16, 3, 5),
  ];
  const blobColors = [theme.grid, 0xffb43a, 0xff5f7a, 0xffe08a, 0xd44bff, 0xff3a6a];

  for (let i = 0; i < blobGeo.length; i++) {
    const isSeed = i === 0 || i === 4;
    const m = new THREE.Mesh(blobGeo[i], new THREE.MeshStandardMaterial({
      color: new THREE.Color(blobColors[i % blobColors.length]).offsetHSL(0, 0, 0.05),
      metalness: isSeed ? 0.55 : 0.96,
      roughness: isSeed ? 0.18 : 0.14,
      envMapIntensity: 1.7,
      emissive: new THREE.Color(blobColors[i % blobColors.length]).multiplyScalar(0.16),
      flatShading: i % 3 === 1,
    }));
    if (isSeed) m.scale.set(1, 1.35, 1);   // 压成石榴籽那种水滴形
    const radius = 5.0 + rnd() * 4.6;
    const angle = (i / blobGeo.length) * Math.PI * 2 + rnd() * 0.6;
    const height = -0.5 + rnd() * 5.6;
    m.position.set(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
    m.scale.multiplyScalar(0.85 + rnd() * 0.9);
    m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    floatGroup.add(m);
    floaters.push({
      mesh: m, kind: 'blob',
      spin: new THREE.Vector3((rnd() - 0.5) * 0.34, (rnd() - 0.5) * 0.34, (rnd() - 0.5) * 0.34),
      bobAmp: 0.26 + rnd() * 0.48,
      bobSpeed: 0.22 + rnd() * 0.4,
      phase: rnd() * Math.PI * 2,
      baseY: height,
      pulse: 0.9 + rnd() * 0.5,
      baseScale: m.scale.clone(),
    });
  }

  // 细线框碎片
  const shardGeo = [
    new THREE.TetrahedronGeometry(0.44, 0),
    new THREE.OctahedronGeometry(0.40, 0),
    new THREE.BoxGeometry(0.42, 0.42, 0.42),
    new THREE.ConeGeometry(0.32, 0.60, 5),
    new THREE.IcosahedronGeometry(0.36, 0),
  ];
  const shardColors = [theme.grid, 0xffb43a, 0xff5f7a, 0xffe08a, 0xd44bff, 0xff9ec4];
  for (let i = 0; i < 24; i++) {
    const color = shardColors[i % shardColors.length];
    const m = new THREE.Mesh(
      shardGeo[i % shardGeo.length],
      new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.38 }),
    );
    const radius = 3.2 + rnd() * 6.2;
    const angle = rnd() * Math.PI * 2;
    const height = -0.7 + rnd() * 6.0;
    m.position.set(Math.cos(angle) * radius, height, Math.sin(angle) * radius);
    m.scale.setScalar(0.5 + rnd() * 1.1);
    m.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
    floatGroup.add(m);
    floaters.push({
      mesh: m, kind: 'shard',
      spin: new THREE.Vector3((rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 0.6),
      bobAmp: 0.2 + rnd() * 0.5,
      bobSpeed: 0.35 + rnd() * 0.6,
      phase: rnd() * Math.PI * 2,
      baseY: height,
      pulse: 1,
      baseScale: m.scale.clone(),
    });
  }

  /* ---------- 断裂巨环：远处侧后方，绝不围绕角色 ---------- */
  const ringGroup = new THREE.Group();
  ringGroup.name = 'rings';
  scene.add(ringGroup);
  const rings = [];
  const RING_DEFS = [
    [[-7.2, 4.4, -5.2], 3.4, [1.15, 0.42, 0.25], 0.24],
    [[7.4, 2.1, -6.4], 4.2, [1.42, -0.55, -0.18], 0.19],
    [[0.6, 7.0, -9.4], 5.2, [1.75, 0.20, 0.55], 0.14],
  ];
  RING_DEFS.forEach(([pos, radius, rot, opacity], i) => {
    const r = new THREE.Mesh(
      new THREE.TorusGeometry(radius, 0.030 - i * 0.004, 8, 150),
      new THREE.MeshBasicMaterial({
        color: i % 2 ? theme.rimc : theme.grid,
        transparent: true,
        opacity,
        depthWrite: false,
      }),
    );
    r.position.set(...pos);
    r.rotation.set(...rot);
    ringGroup.add(r);
    rings.push({ mesh: r, speed: (0.05 + rnd() * 0.09) * (i % 2 ? -1 : 1) });
  });

  /* ---------- 石榴籽星域 ---------- */
  const STAR_COUNT = 1400;
  const starPos = new Float32Array(STAR_COUNT * 3);
  const starCol = new Float32Array(STAR_COUNT * 3);
  const starBase = new Float32Array(STAR_COUNT * 3);
  const tmpColor = new THREE.Color();
  for (let i = 0; i < STAR_COUNT; i++) {
    const radius = 4.5 + rnd() * 16;
    const angle = rnd() * Math.PI * 2;
    const height = -2.5 + rnd() * 12;
    starBase[i * 3] = Math.cos(angle) * radius;
    starBase[i * 3 + 1] = height;
    starBase[i * 3 + 2] = Math.sin(angle) * radius;
    starPos[i * 3] = starBase[i * 3];
    starPos[i * 3 + 1] = starBase[i * 3 + 1];
    starPos[i * 3 + 2] = starBase[i * 3 + 2];
    tmpColor.setHex(shardColors[i % shardColors.length]);
    starCol[i * 3] = tmpColor.r;
    starCol[i * 3 + 1] = tmpColor.g;
    starCol[i * 3 + 2] = tmpColor.b;
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('color', new THREE.BufferAttribute(starCol, 3));
  const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
    size: 0.13,
    map: makeGlowTexture('rgba(255,255,255,0.95)'),
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  }));
  stars.name = 'starfield';
  scene.add(stars);

  /* ---------- 光斑（克制使用：大尺寸 + 加法混合会糊满全屏） ---------- */
  const glows = [];
  const glowDefs = [
    [theme.rimc, 3.6, [5.6, 3.4, -4.6]],
    [theme.fill, 3.2, [-5.8, 2.2, -3.0]],
    [theme.grid, 2.8, [1.2, 5.4, -6.2]],
  ];
  for (const [color, size, pos] of glowDefs) {
    const c = new THREE.Color(color);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(`rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},0.85)`),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      opacity: 0.55,
    }));
    sp.scale.set(size, size, 1);
    sp.position.set(...pos);
    scene.add(sp);
    glows.push({ sp, base: size, phase: glows.length * 1.7 });
  }

  /* ---------- 更新 ---------- */
  function update(dt, elapsed) {
    skyUniforms.uTime.value = elapsed;
    sky.position.copy(camera.position);   // 天穹永远跟着相机
    floorUniforms.uTime.value = elapsed;

    for (const f of floaters) {
      f.mesh.rotation.x += f.spin.x * dt;
      f.mesh.rotation.y += f.spin.y * dt;
      f.mesh.rotation.z += f.spin.z * dt;
      f.mesh.position.y = f.baseY + Math.sin(elapsed * f.bobSpeed + f.phase) * f.bobAmp;
      if (f.kind === 'blob') {
        const k = 1 + Math.sin(elapsed * 0.5 * f.pulse + f.phase) * 0.10;
        f.mesh.scale.copy(f.baseScale).multiplyScalar(k);
      }
    }

    for (const r of rings) {
      r.mesh.rotation.z += r.speed * dt;
      r.mesh.rotation.x += r.speed * 0.4 * dt;
    }

    stars.rotation.y += dt * 0.012;
    const pos = starGeo.attributes.position;
    for (let i = 0; i < STAR_COUNT; i++) {
      pos.array[i * 3 + 1] = starBase[i * 3 + 1] + Math.sin(elapsed * 0.35 + i * 0.7) * 0.22;
    }
    pos.needsUpdate = true;

    for (const g of glows) {
      const k = 1 + Math.sin(elapsed * 0.6 + g.phase) * 0.16;
      g.sp.scale.set(g.base * k, g.base * k, 1);
    }
  }

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);

  /* ---------- 主题切换 ---------- */
  function setTheme(name) {
    if (!THEMES[name]) return;
    themeName = name;
    theme = THEMES[name];
    skyUniforms.uColorA.value.setHex(theme.skyA);
    skyUniforms.uColorB.value.setHex(theme.skyB);
    skyUniforms.uColorC.value.setHex(theme.skyC);
    skyUniforms.uColorD.value.setHex(theme.skyD);
    floorUniforms.uColorA.value.setHex(theme.floorA);
    floorUniforms.uColorB.value.setHex(theme.floorB);
    floorUniforms.uColorC.value.setHex(theme.floorC);
    scene.fog.color.setHex(theme.fog);
    key.color.setHex(theme.key);
    fill.color.setHex(theme.fill);
    rim.color.setHex(theme.rimc);
    glows[0].sp.material.color.setHex(theme.rimc);
    glows[1].sp.material.color.setHex(theme.fill);
    glows[2].sp.material.color.setHex(theme.grid);

    floaters.forEach((f, i) => {
      const m = f.mesh.material;
      if (m.wireframe) {
        m.color.setHex(i % 2 ? theme.grid : theme.rimc);
      } else {
        const c = new THREE.Color(i % 2 ? theme.fill : theme.skyD);
        m.color.copy(c).offsetHSL(0, 0, 0.05);
        m.emissive.copy(c).multiplyScalar(0.16);
      }
    });

    rings.forEach((r, i) => {
      r.mesh.material.color.setHex(i % 2 ? theme.rimc : theme.grid);
    });

    const old = scene.environment;
    envTex = makeEnvTexture(theme);
    scene.environment = envTex;
    if (old && old !== envTex && old.dispose) old.dispose();
  }

  function nextTheme() {
    const keys = Object.keys(THEMES);
    const i = keys.indexOf(themeName);
    setTheme(keys[(i + 1) % keys.length]);
    return themeName;
  }

  return {
    scene, camera, sky, ground, floatGroup, ringGroup, stars,
    update, setTheme, nextTheme,
    get themeName() { return themeName; },
    lights: { hemi, key, fill, rim, back },
    fog: scene.fog,
    floorUniforms,
    setCharacterEnv,
  };
}
