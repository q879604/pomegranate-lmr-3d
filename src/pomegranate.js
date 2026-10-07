/**
 * pomegranate.js —— 石榴人的程序化建模
 *
 * 和香蕉人同一套思路（表情包风格的拟人水果），但主体换成石榴：
 *   · 果身 = 绕 Y 轴的旋转对称曲面包（下圆上收，肚子最鼓）
 *   · 果冠 = 石榴最标志性的那个「皇冠」，由果皮曲面自身在顶端收口、
 *            再长出一圈萼片组成——不是单独扣上去的零件（见下方注释）
 *   · 正面一张夸张的脸（大眼 + 笑嘴 + 腮红），细长四肢 + 白手套白鞋
 *
 * 全部几何用 three.js 参数化生成，零外部素材、可离线单目录部署。
 * 标架固定：绕 Y 轴旋转，theta = PI/2 永远指向 +Z，也就是角色的「正脸朝向」。
 *
 * 教训沿用：香蕉人早期把「果柄」做成独立零件，位置反复对不准、还不跟身体一起动。
 * 这里果冠的底部直接是果皮曲面向上延续收出来的，只有萼片是独立的，
 * 而萼片是挂在果身 group 上的，天然跟着身体一起晃。
 */

import * as THREE from '../vendor/three.module.js';

/* ------------------------------------------------------------------ */
/* 调色板                                                              */
/* ------------------------------------------------------------------ */
export const PALETTE = {
  skin: 0xd8394a,        // 石榴红
  skinDeep: 0xa8233a,    // 果身暗部 / 顶部过渡
  crown: 0xc0394a,       // 果冠（花萼）：比果身略深，但不该是黑的
  crownTip: 0x74212a,    // 萼尖
  eyeWhite: 0xffffff,
  pupil: 0x211620,
  mouth: 0x3a1420,
  tongue: 0xff7a9c,
  blush: 0xff8fa8,
  glove: 0xfdfdfd,
  shoe: 0x2f2f38,
};

/* ------------------------------------------------------------------ */
/* 造型参数（改这里微调体型）                                          */
/* ------------------------------------------------------------------ */
export const CONFIG = {
  // 果身：绕 Y 轴旋转，t = 0 是底部、t = 1 是顶端
  bodyRadius: 0.62,
  bodyHeight: 1.20,
  radialSegs: 64,
  heightSegs: 96,
  bumpAmp: 0.010,        // 果皮表面的轻微起伏（石榴不是完美球）
  bumpCount: 7,

  // 果冠：顶端先由果皮曲面收成一个短颈，再从这里长出萼片
  crownLifeT: 0.88,      // 果皮开始向果冠收口的参数
  crownNeckR: 0.235,     // 收口后的半径（相对 bodyRadius）
  crownSepals: 8,        // 萼片数量
  crownSepalLen: 0.155,   // 萼片长度（世界单位）
  crownTilt: 0.52,       // 萼片外张的角度（弧度）

  faceT: 0.62,
  faceTheta: Math.PI / 2,
  eyeOffsetX: 0.192,
  eyeRadius: 0.178,
  pupilRadius: 0.096,

  armT: 0.46,
  legT: 0.085,        // 腿挂在果身最底部：挂点太高会像从肚子里长出来
  wobble: 1.0,
  gazeRange: 0.034,
};

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */
function smoothstep(a, b, x) {
  const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * 果身母线：给出 t（0 底 -> 1 顶）处的半径系数（1 = bodyRadius）。
 * 用几段解析曲线拼出石榴的轮廓：底部收、肚子鼓、顶部再向果冠收口。
 */
function makeProfileFn(cfg) {
  const { crownLifeT, crownNeckR } = cfg;
  // 底部站立用的圆底半径系数
  const BASE_R = 0.50;
  // 平滑取大的过渡宽度
  const SOFT = 0.11;

  /**
   * 平滑取大：max(a, b) 的软版本。
   * 直接写 if (r < BASE_R) r = BASE_R 会在交界处留下一圈折角，
   * 渲染出来就是「果身坐在一个盆里」的盆沿（视觉上非常显眼）。
   * 软取大把拐角抹成圆弧，底部自然收成圆底。
   */
  function smoothMax(a, b, k) {
    return 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + k * k));
  }

  return (t) => {
    const tt = THREE.MathUtils.clamp(t, 0, 1);
    // 主体用超椭圆轮廓：肚子圆、两端自然收。
    // 别写成 sin(pi * t^a)^b 那种形式——它在 t->0 处上升极陡，
    // 相当于给果身接了一个「平底圆盘 + 直角」，半径沿高度会突变（自检抓到过）。
    const x = tt * 2 - 1;                       // -1 底 -> +1 顶
    let r = Math.pow(Math.max(0, 1 - x * x), 0.40);
    r *= 0.92 + 0.08 * (1 - tt);                // 上部略收，让肚子偏下
    // 底部平滑收成能站稳的圆底（软取大，不留折角）
    r = smoothMax(r, BASE_R, SOFT);
    // 顶部向果冠颈收口：这一段的果皮是连续的，果冠不是另扣上去的零件
    const w = smoothstep(crownLifeT, 1.0, tt);
    r = r * (1 - w) + crownNeckR * w;
    return r;
  };
}

/**
 * 果皮表面的轻微起伏：石榴果皮不是完美回转体。
 * 只用于径向扰动，保证 theta 方向仍有定义（脸、手臂都靠 theta 定位）。
 */
function bumpAt(t, theta, cfg) {
  return 1 + cfg.bumpAmp * (
    Math.cos(cfg.bumpCount * theta) * Math.sin(Math.PI * t) * 0.6 +
    Math.sin(cfg.bumpCount * 1.7 * theta + 2.1) * Math.sin(Math.PI * t) * 0.4
  );
}

/** 生成绕 Y 轴的旋转对称果身（带顶点色，供「果身红 -> 果冠深红」过渡） */
export function makeBodyGeometry(cfg, colorFn = null) {
  const profile = makeProfileFn(cfg);
  const R = cfg.bodyRadius;
  const H = cfg.bodyHeight;

  const radialSegments = cfg.radialSegs;
  const heightSegments = cfg.heightSegs;

  const positions = [];
  const uvs = [];
  const indices = [];
  const colors = colorFn ? [] : null;

  for (let i = 0; i <= heightSegments; i++) {
    const t = i / heightSegments;
    const y = t * H;
    const base = profile(t) * R;

    for (let j = 0; j <= radialSegments; j++) {
      const theta = (j / radialSegments) * Math.PI * 2;
      const r = base * bumpAt(t, theta, cfg);
      positions.push(Math.cos(theta) * r, y, Math.sin(theta) * r);
      uvs.push(j / radialSegments, t);
      if (colors) {
        const c = colorFn(t, theta);
        colors.push(c[0], c[1], c[2]);
      }
    }
  }

  const stride = radialSegments + 1;
  for (let i = 0; i < heightSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = i * stride + j;
      const b = a + stride;
      indices.push(a, b, a + 1);
      indices.push(b, b + 1, a + 1);
    }
  }

  // 上下封盖
  const bottomIdx = positions.length / 3;
  positions.push(0, 0, 0);
  uvs.push(0.5, 0);
  if (colors) colors.push(...(colorFn ? colorFn(0, 0) : [1, 1, 1]));
  const topIdx = positions.length / 3;
  positions.push(0, H, 0);
  uvs.push(0.5, 1);
  if (colors) colors.push(...(colorFn ? colorFn(1, 0) : [1, 1, 1]));

  const topBase = heightSegments * stride;
  for (let j = 0; j < radialSegments; j++) {
    indices.push(bottomIdx, j + 1, j);
    indices.push(topIdx, topBase + j, topBase + j + 1);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}

/* ------------------------------------------------------------------ */
/* 体表采样（供摆脸、腮红、四肢挂点使用）                               */
/* ------------------------------------------------------------------ */
export function makeSurface(cfg) {
  const profile = makeProfileFn(cfg);
  const R = cfg.bodyRadius;
  const H = cfg.bodyHeight;

  function point(t, theta) {
    const tc = THREE.MathUtils.clamp(t, 0, 1);
    const r = profile(tc) * R * bumpAt(tc, theta, cfg);
    return new THREE.Vector3(Math.cos(theta) * r, tc * H, Math.sin(theta) * r);
  }

  function normal(t, theta) {
    const e = 0.006;
    const du = point(t, theta + e).sub(point(t, theta - e));
    const dv = point(Math.min(1, t + e), theta).sub(point(Math.max(0, t - e), theta));
    const n = new THREE.Vector3().crossVectors(dv, du).normalize();
    const outward = new THREE.Vector3(point(t, theta).x, 0, point(t, theta).z);
    if (outward.lengthSq() > 1e-8 && n.dot(outward) < 0) n.negate();
    if (n.y < 0 && t > 0.9) n.set(0, 1, 0);
    return n;
  }

  return { profile, point, normal, height: H, radius: R };
}

/* ------------------------------------------------------------------ */
/* 主入口：组装完整的石榴人                                             */
/* ------------------------------------------------------------------ */
export function createPomegranate(cfg = CONFIG) {
  const group = new THREE.Group();
  group.name = 'Pomegranate';
  const S = makeSurface(cfg);
  const { point, normal } = S;

  /* ------- 材质 ------- */
  const cSkin = new THREE.Color(PALETTE.skin);
  const cDeep = new THREE.Color(PALETTE.skinDeep);
  const matSkin = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.42,
    metalness: 0.03,
  });
  const matCrown = new THREE.MeshStandardMaterial({ color: PALETTE.crown, roughness: 0.72, metalness: 0.02 });
  // 四肢用果身色：用果冠的深红会让整条四肢发黑
  const matLimb = new THREE.MeshStandardMaterial({ color: 0xc42a3e, roughness: 0.56, metalness: 0.02 });
  const matCrownTip = new THREE.MeshStandardMaterial({ color: PALETTE.crownTip, roughness: 0.78 });
  const matEye = new THREE.MeshStandardMaterial({ color: PALETTE.eyeWhite, roughness: 0.16 });
  const matPupil = new THREE.MeshStandardMaterial({ color: PALETTE.pupil, roughness: 0.10 });
  const matMouth = new THREE.MeshStandardMaterial({ color: PALETTE.mouth, roughness: 0.35 });
  const matTongue = new THREE.MeshStandardMaterial({ color: PALETTE.tongue, roughness: 0.5 });
  const matBlush = new THREE.MeshStandardMaterial({ color: PALETTE.blush, roughness: 0.85 });
  const matGlove = new THREE.MeshStandardMaterial({ color: PALETTE.glove, roughness: 0.42 });
  const matShoe = new THREE.MeshStandardMaterial({ color: PALETTE.shoe, roughness: 0.5, metalness: 0.05 });

  /* ------- 果身（含向果冠收口的短颈）------- */
  const wobbleUniforms = { uTime: { value: 0 }, uWobble: { value: cfg.wobble } };
  // 果身红 -> 顶部（果冠颈）深红，用顶点色过渡，接缝天然不存在
  const bodyGeo = makeBodyGeometry(cfg, (t) => {
    const w = smoothstep(cfg.crownLifeT - 0.12, 1.0, t);
    return [
      cSkin.r * (1 - w) + cDeep.r * w,
      cSkin.g * (1 - w) + cDeep.g * w,
      cSkin.b * (1 - w) + cDeep.b * w,
    ];
  });

  matSkin.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = wobbleUniforms.uTime;
    shader.uniforms.uWobble = wobbleUniforms.uWobble;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWobble;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          // 越靠近顶端晃得越明显（果冠跟着一起摇）
          // 归一化高度范围写死成字面量：着色器源码里不要出现 JS 模板插值，
          // 否则静态语法检查工具拿到的就是带插值标记的文本，根本没法解析。
          float h = clamp((transformed.y - 0.10) / 1.14, 0.0, 1.0);
          float w = h * h * uWobble;
          transformed.x += sin(uTime * 1.6 + h * 2.8) * 0.055 * w;
          transformed.z += cos(uTime * 1.25 + 1.4 + h * 2.1) * 0.040 * w;
          // 整体呼吸：肚子的轻微起伏，像在打呼
          float breathe = sin(uTime * 1.9) * 0.006 * uWobble;
          transformed.x *= 1.0 + breathe;
          transformed.z *= 1.0 + breathe;
        }`);
  };

  const body = new THREE.Mesh(bodyGeo, matSkin);
  body.name = 'body';
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  /* ------- 果冠（花萼）：一整片「扇贝状外张曲面」 -------
     第一版是用一圈小圆锥拼的萼片，问题是：
       · 基座半径给不对就会挤成一撮，像头发或小火焰；
       · 每个圆锥各自是个封闭小体，侧面法线很容易朝外，渲染出来发黑。
     真石榴的果冠其实是同一张曲面：从果颈向上、向外张开，
     顶端边缘按角度起伏成 5~7 个尖齿（高的是齿、低的是齿间）。
     所以这里用一张自定义网格直接把「外张 + 齿状边缘」建出来，
     法线连续、没有拼接感，从任何角度看都是同一个杯状皇冠。
  --------------------------------------------------- */
  const crownGroup = new THREE.Group();
  crownGroup.name = 'crown';
  const crownNeckRadius = cfg.bodyRadius * cfg.crownNeckR;
  const crownBaseY = cfg.bodyHeight * 0.955;
  const crownLen = cfg.crownSepalLen * 1.35;

  /** 齿形：每个萼片一个齿，齿心最高、齿间最低 */
  function lobeAt(theta) {
    const phase = (theta / (Math.PI * 2)) * cfg.crownSepals;
    const frac = phase - Math.floor(phase);
    // frac=0.5 是齿尖，0/1 是齿间；用三角波做出清晰的尖齿
    const tri = 1 - Math.abs(frac * 2 - 1);
    return 0.45 + 0.55 * Math.pow(tri, 0.70);
  }

  {
    const vSegs = 26;
    const uSegs = cfg.radialSegs;
    const positions = [];
    const uvs = [];
    const indices = [];
    // 果冠整体转一点，让齿尖不正好顶在正脸中线上
    const phaseOffset = Math.PI / cfg.crownSepals;

    for (let i = 0; i <= vSegs; i++) {
      const v = i / vSegs;
      for (let j = 0; j <= uSegs; j++) {
        const theta = (j / uSegs) * Math.PI * 2;
        const lobe = lobeAt(theta + phaseOffset);
        // 高度：齿心长到 crownLen，齿间只到 45%（矮而清楚的三角齿）
        const y = crownBaseY + v * crownLen * lobe;
        // 半径：明显向外张开（真石榴的冠是个敞口杯），顶端再略收成齿尖
        const flare = 1 + 1.45 * v;
        const taper = 1 - 0.42 * Math.pow(v, 2.6);
        const r = crownNeckRadius * flare * taper * (0.78 + 0.22 * lobe);
        positions.push(Math.cos(theta) * r, y, Math.sin(theta) * r);
        uvs.push(j / uSegs, v);
      }
    }

    const stride = uSegs + 1;
    for (let i = 0; i < vSegs; i++) {
      for (let j = 0; j < uSegs; j++) {
        const a = i * stride + j;
        const b = a + stride;
        indices.push(a, b, a + 1);
        indices.push(b, b + 1, a + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();

    // 果冠是中空的杯（真石榴就是这样，能看进去），所以必须双面渲染，
    // 否则从侧上方看会直接看穿到内壁的背面而被剔除掉。
    const matCrownShell = new THREE.MeshStandardMaterial({
      color: PALETTE.crown,
      roughness: 0.66,
      metalness: 0.02,
      side: THREE.DoubleSide,   // 齿尖很薄，双面避免边缘穿透
    });
    const shell = new THREE.Mesh(geo, matCrownShell);
    shell.name = 'crownShell';
    shell.castShadow = true;
    shell.receiveShadow = true;
    crownGroup.add(shell);
  }

  // 杯口的内壁：真石榴的冠是空心的，能看到里面。
  // 只画外壁的话，从侧上方看进去会看到外壁的背面（法线朝外 -> 发黑）。
  {
    const vSegs = 12;
    const uSegs = cfg.radialSegs;
    const positions = [];
    const uvs = [];
    const indices = [];
    const phaseOffset = Math.PI / cfg.crownSepals;
    for (let i = 0; i <= vSegs; i++) {
      const v = i / vSegs;
      for (let j = 0; j <= uSegs; j++) {
        const theta = (j / uSegs) * Math.PI * 2;
        const lobe = lobeAt(theta + phaseOffset);
        const y = crownBaseY + v * crownLen * lobe * 0.94;
        // 内壁半径比外壁小一个壁厚，越往上越薄
        const flare = 1 + 1.45 * v;
        const taper = 1 - 0.42 * Math.pow(v, 2.6);
        const r = crownNeckRadius * flare * taper * (0.78 + 0.22 * lobe) * 0.62;
        positions.push(Math.cos(theta) * r, y, Math.sin(theta) * r);
        uvs.push(j / uSegs, v);
      }
    }
    const stride = uSegs + 1;
    for (let i = 0; i < vSegs; i++) {
      for (let j = 0; j < uSegs; j++) {
        const a = i * stride + j;
        const b = a + stride;
        // 内壁的绕序与外壁相反（法线朝内）
        indices.push(a, a + 1, b);
        indices.push(b, a + 1, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const inner = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      color: PALETTE.crownTip,
      roughness: 0.80,
      side: THREE.BackSide,
    }));
    inner.name = 'crownInner';
    crownGroup.add(inner);
  }

  // 杯底的收口：把果冠颈与果身之间的过渡盖住，避免看到缝隙
  const crownCore = new THREE.Mesh(
    new THREE.SphereGeometry(crownNeckRadius * 1.02, 22, 14),
    matCrown,
  );
  crownCore.position.y = crownBaseY + crownLen * 0.10;
  crownCore.scale.set(1, 0.55, 1);
  crownCore.castShadow = true;
  crownGroup.add(crownCore);
  group.add(crownGroup);

  /* ------- 果皮斑点（石榴皮上的深色小点） ------- */
  const spotGeo = new THREE.SphereGeometry(1, 12, 10);
  const spots = [
    [0.30, 1.15, 0.019], [0.50, 2.40, 0.016], [0.72, 0.55, 0.017],
    [0.24, 3.60, 0.015], [0.62, 4.30, 0.018], [0.40, 5.10, 0.014],
    [0.78, 2.90, 0.013], [0.16, 5.60, 0.014], [0.55, 3.30, 0.012],
  ];
  for (const [t, theta, r] of spots) {
    const p = point(t, theta);
    const n = normal(t, theta);
    const m = new THREE.Mesh(spotGeo, matCrownTip);
    m.position.copy(p).addScaledVector(n, -r * 0.45);
    m.scale.setScalar(r);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
    group.add(m);
  }

  /* ------- 脸 ------- */
  const faceCenter = point(cfg.faceT, cfg.faceTheta);
  const faceNormal = normal(cfg.faceT, cfg.faceTheta);
  const localZ = faceNormal.clone().normalize();
  const localX = new THREE.Vector3(1, 0, 0).projectOnPlane(localZ).normalize();
  const localY = new THREE.Vector3().crossVectors(localZ, localX).normalize();
  const faceQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(localX, localY, localZ),
  );

  const eyeGeo = new THREE.SphereGeometry(cfg.eyeRadius, 28, 22);
  const pupilGeo = new THREE.SphereGeometry(cfg.pupilRadius, 24, 18);
  const glintGeo = new THREE.SphereGeometry(cfg.pupilRadius * 0.36, 12, 10);
  const faceAnchors = {};

  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(eyeGeo, matEye);
    eye.position.copy(faceCenter)
      .addScaledVector(localX, sx * cfg.eyeOffsetX)
      .addScaledVector(localY, 0.085)
      .addScaledVector(localZ, cfg.eyeRadius * 0.16);
    eye.scale.set(1.02, 1.10, 0.50);
    eye.quaternion.copy(faceQuat);
    eye.castShadow = true;
    group.add(eye);

    const pupil = new THREE.Mesh(pupilGeo, matPupil);
    pupil.position.copy(eye.position)
      .addScaledVector(localZ, cfg.eyeRadius * 0.47)
      .addScaledVector(localX, sx * 0.015);
    pupil.scale.set(1, 1.04, 0.42);
    pupil.quaternion.copy(faceQuat);
    pupil.userData.home = pupil.position.clone();
    group.add(pupil);

    const glint = new THREE.Mesh(glintGeo, matEye);
    glint.position.copy(pupil.position)
      .addScaledVector(localZ, cfg.pupilRadius * 0.40)
      .addScaledVector(localX, -sx * 0.042)
      .addScaledVector(localY, 0.044);
    glint.quaternion.copy(faceQuat);
    group.add(glint);

    eye.userData.pupil = pupil;
    eye.userData.glint = glint;
    eye.userData.localX = localX.clone();
    eye.userData.localY = localY.clone();
    eye.userData.localZ = localZ.clone();
    eye.userData.side = sx;
    faceAnchors[sx < 0 ? 'eyeL' : 'eyeR'] = eye;
  }

  /* ------- 笑嘴 + 舌头 ------- */
  const smilePts = [];
  for (let i = 0; i <= 26; i++) {
    const a = Math.PI * (1.14 + (0.72 * i) / 26);
    smilePts.push(new THREE.Vector3(Math.cos(a) * 0.168, Math.sin(a) * 0.132, 0));
  }
  const smile = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(smilePts), 36, 0.033, 12, false),
    matMouth,
  );
  smile.position.copy(faceCenter)
    .addScaledVector(localY, -0.150)
    .addScaledVector(localZ, 0.012);
  smile.quaternion.copy(faceQuat);
  group.add(smile);

  const tongue = new THREE.Mesh(new THREE.SphereGeometry(0.056, 20, 14), matTongue);
  tongue.position.copy(faceCenter)
    .addScaledVector(localY, -0.276)
    .addScaledVector(localZ, 0.020);
  tongue.scale.set(1.30, 0.56, 0.50);
  tongue.quaternion.copy(faceQuat);
  group.add(tongue);

  /* ------- 腮红：左右必须等高，且都要真的露出体表 ------- */
  const BLUSH_R = 0.092;
  const blushGeo = new THREE.SphereGeometry(BLUSH_R, 20, 14);
  const blushT0 = cfg.faceT - 0.055;
  const blushDelta = 0.74;
  const blushY = (
    point(blushT0, cfg.faceTheta - blushDelta).y +
    point(blushT0, cfg.faceTheta + blushDelta).y
  ) * 0.5;

  /** 在体表上反解出 Y ≈ yTarget 的参数 t（本曲面 Y 随 t 单调） */
  function surfaceTAtY(theta, yTarget) {
    let lo = 0.02, hi = 0.98;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) * 0.5;
      if (point(mid, theta).y < yTarget) lo = mid; else hi = mid;
    }
    return (lo + hi) * 0.5;
  }

  for (const sx of [-1, 1]) {
    const bth = cfg.faceTheta + sx * blushDelta;
    const bt = surfaceTAtY(bth, blushY);
    const p = point(bt, bth);
    const n = normal(bt, bth);
    const b = new THREE.Mesh(blushGeo, matBlush);
    const halfThickness = BLUSH_R * 0.55;
    // 固定埋一半露一半：否则可不可见完全取决于曲面曲率，换个角度就"少一块腮红"
    b.position.copy(p).addScaledVector(n, -halfThickness * 0.52);
    b.scale.set(1.32, 0.70, 0.55);
    b.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    b.userData.kind = 'blush';
    b.userData.side = sx;
    b.userData.normal = n.clone();
    b.userData.surfacePoint = p.clone();
    b.userData.radius = BLUSH_R;
    group.add(b);
  }

  /* ------- 手臂 ------- */
  const arms = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    // 挂点角度：offset 越接近 PI/2，点越靠「正面」；越接近 0，越靠「侧面」。
    // 果身是个很宽的球，挂点必须靠侧面，否则整条手臂会埋进肚子轮廓里看不见。
    // 注意 x = cos(theta)*r，所以右边(+x)对应 theta 更小 —— 这里用减号。
    const ARM_OFF = 1.38;
    const armTh = cfg.faceTheta - sx * ARM_OFF;
    // 左右两侧体表高低不同 -> 取平均值拉齐，否则会一肩高一肩低
    const armL = point(cfg.armT, cfg.faceTheta - ARM_OFF);
    const armR = point(cfg.armT, cfg.faceTheta + ARM_OFF);
    const armY = (armL.y + armR.y) * 0.5;
    const ap = point(cfg.armT, armTh).addScaledVector(normal(cfg.armT, armTh), -0.030);
    pivot.position.set(ap.x, armY, ap.z);
    pivot.userData.side = sx;

    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.072, 0.30, 8, 18), matLimb);
    upper.position.set(sx * 0.075, -0.21, 0);
    upper.rotation.z = sx * 0.15;
    upper.castShadow = true;
    pivot.add(upper);

    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.064, 0.25, 8, 18), matLimb);
    fore.position.set(sx * 0.170, -0.52, 0.02);
    fore.rotation.z = sx * 0.09;
    fore.castShadow = true;
    pivot.add(fore);

    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.108, 20, 16), matGlove);
    glove.position.set(sx * 0.205, -0.705, 0.028);
    glove.scale.set(1, 1.06, 0.94);
    glove.castShadow = true;
    pivot.add(glove);

    group.add(pivot);
    arms[sx < 0 ? 'armL' : 'armR'] = pivot;
  }

  /* ------- 腿 -------
     两条真实约束（第一版都违反了，截图里一眼能看出腿"从肚子里长出来"）：
       ① 挂点必须在果身**最底部**附近。第一版挂在 t=0.20（果身下三分之一），
          那正是果身还往外鼓的位置，整条大腿都埋在果身轮廓里。
       ② 腿不能太长。第一版从挂点到鞋底有 0.74，而果身才高 1.2，
          腿快赶上身高的一半，看着像高跷。现在收到约 0.50。
     另外腿的水平偏移也一并收拢，避免双腿叉得像蜘蛛。
  --------------------------------------------------- */
  const legs = {};
  for (const sx of [-1, 1]) {
    const pivot = new THREE.Group();
    const LEG_OFF = 0.95;
    const anchorL = point(cfg.legT, cfg.faceTheta - LEG_OFF);
    const anchorR = point(cfg.legT, cfg.faceTheta + LEG_OFF);
    const legY = (anchorL.y + anchorR.y) * 0.5;
    const anchor = point(cfg.legT, cfg.faceTheta - sx * LEG_OFF);
    // 稍微往上坐一点，让大腿顶端埋进果身、不留悬空缝
    pivot.position.set(anchor.x, legY + 0.035, anchor.z);
    pivot.userData.side = sx;

    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.080, 0.16, 8, 18), matLimb);
    thigh.position.set(sx * 0.070, -0.125, 0);
    thigh.rotation.z = sx * -0.10;
    thigh.castShadow = true;
    pivot.add(thigh);

    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.072, 0.15, 8, 18), matLimb);
    shin.position.set(sx * 0.104, -0.315, 0);
    shin.castShadow = true;
    pivot.add(shin);

    const shoe = new THREE.Mesh(new THREE.SphereGeometry(0.115, 20, 16), matShoe);
    shoe.position.set(sx * 0.126, -0.455, 0.072);
    shoe.scale.set(0.92, 0.60, 1.42);
    shoe.rotation.y = sx * 0.06;
    shoe.castShadow = true;
    pivot.add(shoe);

    group.add(pivot);
    legs[sx < 0 ? 'legL' : 'legR'] = pivot;
  }

  /* ------- 眼神：瞳孔朝向（可由外部驱动，实现"看镜头"） ------- */
  const gaze = { target: new THREE.Vector2(0, 0), cur: new THREE.Vector2(0, 0) };

  function setGaze(dx, dy) {
    gaze.target.set(
      THREE.MathUtils.clamp(dx, -1, 1),
      THREE.MathUtils.clamp(dy, -1, 1),
    );
  }

  function applyGaze(rate = 0.16) {
    gaze.cur.lerp(gaze.target, rate);
    const px = gaze.cur.x * cfg.gazeRange;
    const py = gaze.cur.y * cfg.gazeRange * 0.85;
    for (const k of ['eyeL', 'eyeR']) {
      const eye = faceAnchors[k];
      const pupil = eye.userData.pupil;
      const glint = eye.userData.glint;
      const home = pupil.userData.home;
      pupil.position.copy(home)
        .addScaledVector(eye.userData.localX, px)
        .addScaledVector(eye.userData.localY, py);
      glint.position.copy(home)
        .addScaledVector(eye.userData.localZ, cfg.pupilRadius * 0.40)
        .addScaledVector(eye.userData.localX, px + eye.userData.side * -0.042)
        .addScaledVector(eye.userData.localY, py + 0.044);
    }
  }

  /* ------- 动画 ------- */
  function update(time, wobbleGain = 0, dt = 1 / 60) {
    wobbleUniforms.uTime.value = time;
    wobbleUniforms.uWobble.value = cfg.wobble + wobbleGain;

    for (const k of ['armL', 'armR']) {
      const a = arms[k];
      const sx = a.userData.side;
      a.rotation.z = Math.sin(time * 1.5 + (sx > 0 ? 0 : 1.1)) * 0.16 * sx;
      a.rotation.x = Math.sin(time * 1.1 + (sx > 0 ? 2.0 : 0.4)) * 0.11;
    }
    for (const k of ['legL', 'legR']) {
      const l = legs[k];
      const sx = l.userData.side;
      l.rotation.x = Math.sin(time * 1.5 + (sx > 0 ? 0 : 0.9)) * 0.08;
    }

    // 果冠整体轻微摇摆，相位比果身的顶点位移略滞后一点，看起来更"活"
    const wob = cfg.wobble + wobbleGain;
    crownGroup.rotation.z = -Math.sin(time * 1.6 + 2.8 - 0.35) * 0.055 * wob;
    crownGroup.rotation.x = Math.cos(time * 1.25 + 1.4 + 2.1 - 0.35) * 0.040 * wob;

    const s = 1 + Math.sin(time * 2.0) * 0.04;
    smile.scale.set(s, s, 1);

    applyGaze(Math.min(1, dt * 9));
  }

  const crownTopY = cfg.bodyHeight * 0.955 + cfg.crownSepalLen;

  return {
    group,
    surface: S,
    crown: {
      sepalCount: cfg.crownSepals,
      neckRadius: crownNeckRadius,
      baseY: crownBaseY,
      length: crownLen,
      topY: crownTopY,
    },
    parts: {
      body,
      crownGroup,
      crownCore,
      smile,
      tongue,
      arms,
      legs,
      faceAnchors,
    },
    update,
    setGaze,
  };
}
