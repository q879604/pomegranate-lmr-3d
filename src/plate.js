/**
 * plate.js —— 悬浮名字铭牌（纯 Canvas 程序化生成，零外部素材）
 *
 * 这块牌子挂在角色头顶，跟着角色一起转，正面刻着主角的名字。
 * 贴图用 canvas 现场画，部署时不需要任何图片文件，也不会发起网络请求。
 * 文本绘制在少数无文本能力的宿主里会失败，这里全程做能力探测与 try/catch，
 * 保证「画不出来」最多是没字，绝不让整个页面挂掉。
 */

import * as THREE from '../vendor/three.module.js';

export const OWNER = {
  name: '梁梦冉',
  latin: 'LIANG MENG RAN',
};

// 铭牌的几何尺寸只有这一处定义，main.js 与自检脚本都用它，避免两边各写一份
export const PLATE = {
  width: 1.18,     // 世界单位；2:1 比例，所以高 = width / 2
  gap: 0.42,       // 牌底与角色最高点之间的空隙
};

// 石榴主题的牌子配色：宝石红底 + 金边
export const PLATE_COLORS = {
  bgA: 'rgba(58, 10, 24, 0.95)',
  bgB: 'rgba(28, 6, 16, 0.95)',
  edge: 'rgba(255, 180, 58, 0.94)',
  inner: 'rgba(255, 95, 122, 0.45)',
  name: '#ffd166',
  latin: 'rgba(255, 236, 226, 0.82)',
  dot: 'rgba(255, 95, 122, 0.9)',
};

const FONT_STACK = '"PingFang SC", "HarmonyOS Sans SC", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === 'function') {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/**
 * 画铭牌贴图。返回 canvas（供测试断言/调试），绘制失败时也返回 canvas，
 * 只是内容可能只有背板。
 */
export function drawPlateCanvas(opts = {}) {
  const {
    name = OWNER.name,
    latin = OWNER.latin,
    width = 1024,
    height = 512,
    colors = PLATE_COLORS,
  } = opts;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  try {
    const W = width;
    const H = height;
    ctx.clearRect(0, 0, W, H);

    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, colors.bgA);
    g.addColorStop(1, colors.bgB);
    roundRect(ctx, 10, 10, W - 20, H - 20, 54);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 7;
    ctx.strokeStyle = colors.edge;
    ctx.stroke();

    roundRect(ctx, 34, 34, W - 68, H - 68, 38);
    ctx.lineWidth = 2;
    ctx.strokeStyle = colors.inner;
    ctx.stroke();

    if (typeof ctx.fillText !== 'function') return canvas;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.55)';

    ctx.shadowBlur = 22;
    ctx.fillStyle = colors.name;
    ctx.font = `900 206px ${FONT_STACK}`;
    ctx.fillText(name, W / 2, H / 2 - 34);

    ctx.shadowBlur = 8;
    ctx.fillStyle = colors.latin;
    ctx.font = `600 54px ${FONT_STACK}`;
    ctx.fillText(latin, W / 2, H / 2 + 116);

    // 两角装饰点
    ctx.shadowBlur = 0;
    ctx.fillStyle = colors.dot;
    for (const [cx, cy] of [[92, H / 2], [W - 92, H / 2]]) {
      ctx.beginPath();
      ctx.arc(cx, cy, 11, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  } catch (err) {
    // 宿主缺少文本/路径能力时静默降级：牌子还在，只是没有字
  }
  return canvas;
}

/** 生成铭牌贴图（Three 纹理） */
export function makePlateTexture(opts = {}) {
  const canvas = drawPlateCanvas(opts);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 生成铭牌网格。尺寸按物理比例（宽:高 = 2:1）给，位置由 mountNamePlate 摆放。
 */
export function createNamePlate(opts = {}) {
  const { width = PLATE.width, name = OWNER.name, latin = OWNER.latin } = opts;
  const height = width / 2;
  const tex = makePlateTexture({ name, latin });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width, height),
    new THREE.MeshStandardMaterial({
      map: tex,
      transparent: true,
      roughness: 0.50,
      metalness: 0.06,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: 0.46,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.name = 'namePlate';
  mesh.userData.size = { width, height };
  mesh.userData.text = { name, latin };
  mesh.userData.texture = tex;
  return mesh;
}

/**
 * 把铭牌挂到角色 group 的头顶。位置的算法只在这里写一份，
 * main.js 与自检脚本共用，避免两边各算一次导致不一致。
 */
export function mountNamePlate(target, opts = {}) {
  const { width = PLATE.width, gap = PLATE.gap, name = OWNER.name, latin = OWNER.latin } = opts;
  const box = new THREE.Box3().setFromObject(target);
  const plate = createNamePlate({ width, name, latin });
  const halfH = width / 4;               // 牌子是 2:1，半高 = 宽/4
  const centerY = box.max.y + gap + halfH;
  plate.position.set(0, centerY, 0);
  target.add(plate);
  return { plate, box, headTopY: box.max.y, gap, centerY, halfH };
}
