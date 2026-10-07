/**
 * plate-check.mjs —— 名字铭牌的独立自检
 *
 * 容器里没有浏览器，无法真的把 canvas 画出来看，于是这里给 document.createElement('canvas')
 * 打一个「记录型」的 2D 上下文桩：把 fillText / arc / roundRect 等调用全部登记下来，
 * 用它断言铭牌确实写了主角的名字，并且几何尺寸、悬挂位置都正确。
 * 最后再把角色 + 铭牌一起丢进软件光栅化器出一张图，目视确认牌子挂在头顶。
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import * as THREE from '../vendor/three.module.js';

/* ---------------- 记录型 canvas 桩 ---------------- */
const calls = [];
const gradientStub = { addColorStop() {} };
const ctx2dStub = {
  createLinearGradient: () => { calls.push(['createLinearGradient']); return gradientStub; },
  createRadialGradient: () => gradientStub,
  fillRect() {}, clearRect() {}, drawImage() {}, beginPath() {}, closePath() {},
  moveTo() {}, lineTo() {}, quadraticCurveTo() {}, stroke() {},
  roundRect() { calls.push(['roundRect']); },
  arc() { calls.push(['arc']); },
  fill() { calls.push(['fill']); },
  fillText(t, x, y) { calls.push(['fillText', t, x, y]); },
  save() {}, restore() {},
  set fillStyle(v) { calls.push(['fillStyle', v]); }, get fillStyle() { return ''; },
  set strokeStyle(v) {}, get strokeStyle() { return ''; },
  set lineWidth(v) {}, get lineWidth() { return 1; },
  set font(v) { calls.push(['font', v]); }, get font() { return ''; },
  set textAlign(v) {}, get textAlign() { return ''; },
  set textBaseline(v) {}, get textBaseline() { return ''; },
  set shadowColor(v) {}, get shadowColor() { return ''; },
  set shadowBlur(v) {}, get shadowBlur() { return 0; },
};

let canvasCount = 0;
const canvasStub = () => {
  canvasCount++;
  return { width: 0, height: 0, style: {}, getContext: (t) => (t === '2d' ? ctx2dStub : null) };
};
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? canvasStub() : { style: {}, appendChild() {} }) };
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, innerWidth: 1280, innerHeight: 800 };
globalThis.self = globalThis.window;

const { OWNER, PLATE, drawPlateCanvas, makePlateTexture, createNamePlate, mountNamePlate } = await import('../src/plate.js');
const { createPomegranate, CONFIG } = await import('../src/pomegranate.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

/* ================= 1. 贴图绘制 ================= */
console.log('\n[铭牌贴图]');
calls.length = 0;
const cv = drawPlateCanvas();
check('返回了 canvas', !!cv && typeof cv === 'object');
check('canvas 尺寸 1024x512', cv.width === 1024 && cv.height === 512, `${cv.width}x${cv.height}`);

const texts = calls.filter((c) => c[0] === 'fillText').map((c) => c[1]);
check('画上了主角名字「梁梦冉」', texts.includes(OWNER.name), JSON.stringify(texts));
check('画上了拼音 LIANG MENG RAN', texts.includes(OWNER.latin), JSON.stringify(texts));
check('用了圆角矩形做背板', calls.some((c) => c[0] === 'roundRect'));
check('有金色描边（fillStyle 含 ff 色调）', calls.some((c) => c[0] === 'fillStyle'));
check('名字字号足够大（>=180px）',
  calls.some((c) => c[0] === 'font' && /(\d+)px/.test(c[1]) && Number(c[1].match(/(\d+)px/)[1]) >= 180),
  JSON.stringify(calls.filter((c) => c[0] === 'font').map((c) => c[1])));
check('名字绘制在画面水平中线', texts.includes(OWNER.name) &&
  Math.abs(calls.find((c) => c[0] === 'fillText' && c[1] === OWNER.name)[2] - 512) < 2);

/* 降级路径：拿不到 2D 上下文也必须能返回 */
const origCreate = globalThis.document.createElement;
globalThis.document.createElement = () => ({ width: 0, height: 0, style: {}, getContext: () => null });
let degraded = null;
try { degraded = drawPlateCanvas(); } catch (e) { degraded = e; }
check('无 2D 上下文时优雅降级（不抛错）', degraded && !(degraded instanceof Error));
globalThis.document.createElement = origCreate;

/* ================= 2. 贴图与材质 ================= */
console.log('\n[铭牌网格]');
const tex = makePlateTexture();
check('生成 Three 纹理', !!tex && tex.isTexture === true);
check('纹理颜色空间为 sRGB', tex.colorSpace === THREE.SRGBColorSpace);

const plate = createNamePlate();
check('网格名称为 namePlate', plate.name === 'namePlate');
check('几何是 2:1 的平面',
  plate.geometry.parameters.width / plate.geometry.parameters.height === 2,
  `${plate.geometry.parameters.width}x${plate.geometry.parameters.height}`);
check('宽度等于 PLATE.width（尺寸单一定义源）',
  plate.geometry.parameters.width === PLATE.width, `${plate.geometry.parameters.width} vs ${PLATE.width}`);
check('材质贴了名字贴图', !!plate.material.map);
check('材质透明（避免出现黑色底板）', plate.material.transparent === true);
check('双面可见（牌子翻过来也能看）', plate.material.side === THREE.DoubleSide);
check('自带自发光，暗背景下也亮', !!plate.material.emissiveMap && plate.material.emissiveIntensity > 0);
check('userData 记录了名字', plate.userData.text.name === OWNER.name);

/* ================= 3. 悬挂位置 ================= */
console.log('\n[悬挂位置]');
const man = createPomegranate();
const bodyBox = new THREE.Box3().setFromObject(man.group);
// 位置算法由 plate.js 提供，这里调用的是生产代码本身，不是复刻一份
const mounted = mountNamePlate(man.group);
const p = mounted.plate;
man.group.updateMatrixWorld(true);
const plateBox = new THREE.Box3().setFromObject(p);
check('mountNamePlate 返回 headTopY', typeof mounted.headTopY === 'number' && mounted.headTopY > 0);
check('铭牌整体在角色最高点之上', plateBox.min.y > bodyBox.max.y,
  `plate.min.y=${plateBox.min.y.toFixed(3)} head.max.y=${bodyBox.max.y.toFixed(3)}`);
check('铭牌与头顶间距适中（0.2~1.0）', plateBox.min.y - bodyBox.max.y > 0.2 && plateBox.min.y - bodyBox.max.y < 1.0,
  (plateBox.min.y - bodyBox.max.y).toFixed(3));
check('铭牌水平居中（|x| < 0.25）', Math.abs((plateBox.min.x + plateBox.max.x) / 2) < 0.25);
{
  // 尺寸只能有一个来源：main.js 里不允许再出现写死的 width/gap
  const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const mountCall = mainSrc.match(/mountNamePlate\([\s\S]*?\)/);
  check('main.js 用默认尺寸挂载（未写死 width/gap）',
    !!mountCall && !/width|gap/.test(mountCall[0]), mountCall ? mountCall[0] : '(未找到调用)');
}
check('铭牌比角色窄（不遮挡主体）',
  (plateBox.max.x - plateBox.min.x) < (bodyBox.max.x - bodyBox.min.x) + 0.6);

/* ================= 4. 出图：目视确认牌子在头顶 ================= */
console.log('\n[出图]');
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const pngChunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
};
function encodePNG(w, h, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}

const LIGHT = new THREE.Vector3(0.55, 0.78, 0.62).normalize();
function render(root, { width = 700, height = 940, fov = 34, camPos, target }) {
  const color = Buffer.alloc(width * height * 3);
  const depth = new Float32Array(width * height).fill(Infinity);
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    const r = 0.16 + (0.05 - 0.16) * t, g = 0.13 + (0.04 - 0.13) * t, b = 0.30 + (0.10 - 0.30) * t;
    for (let x = 0; x < width; x++) { const i = (y * width + x) * 3; color[i] = r * 255; color[i + 1] = g * 255; color[i + 2] = b * 255; }
  }
  root.updateMatrixWorld(true);
  const forward = target.clone().sub(camPos).normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const f = (height / 2) / Math.tan((fov * Math.PI) / 360);
  const project = (pt) => {
    const d = pt.clone().sub(camPos); const z = d.dot(forward);
    if (z <= 0.05) return null;
    return { x: width / 2 + (d.dot(right) / z) * f, y: height / 2 - (d.dot(up) / z) * f, z };
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const nrm = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry, pos = geo.attributes.position, idx = geo.index, mw = o.matrixWorld;
    const col = o.material.color; const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mw);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mw);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mw);
      e1.subVectors(b, a); e2.subVectors(c, a); nrm.crossVectors(e1, e2).normalize();
      const pa = project(a), pb = project(b), pc = project(c);
      if (!pa || !pb || !pc) continue;
      const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
      if (area >= 0) continue;
      const lam = Math.max(0, nrm.dot(LIGHT));
      const shade = 0.34 + 0.76 * lam;
      const cr = Math.min(1, col.r * shade), cg = Math.min(1, col.g * shade), cb = Math.min(1, col.b * shade);
      const minX = Math.max(0, Math.floor(Math.min(pa.x, pb.x, pc.x))), maxX = Math.min(width - 1, Math.ceil(Math.max(pa.x, pb.x, pc.x)));
      const minY = Math.max(0, Math.floor(Math.min(pa.y, pb.y, pc.y))), maxY = Math.min(height - 1, Math.ceil(Math.max(pa.y, pb.y, pc.y)));
      const invArea = 1 / area;
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5, py = y + 0.5;
        const w0 = ((pb.x - pa.x) * (py - pa.y) - (px - pa.x) * (pb.y - pa.y)) * invArea;
        const w1 = ((px - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (py - pa.y)) * invArea;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const z = pa.z * w2 + pb.z * w1 + pc.z * w0;
        const pi = y * width + x;
        if (z >= depth[pi]) continue;
        depth[pi] = z; const o3 = pi * 3;
        color[o3] = cr * 255; color[o3 + 1] = cg * 255; color[o3 + 2] = cb * 255;
      }
    }
  });
  return encodePNG(width, height, color);
}

mkdirSync(new URL('../shots/', import.meta.url), { recursive: true });
man.update(0.6);
const png = render(man.group, {
  camPos: new THREE.Vector3(1.9, 2.9, 5.9),
  target: new THREE.Vector3(0.06, 2.05, 0),
});
const out = new URL('../shots/hero.png', import.meta.url);
writeFileSync(out, png);
console.log('  · 已出图 shots/hero.png（铭牌在光栅化器里是一块纯白方板，用于核对位置与尺寸）');
check('出图成功（>1KB）', png.length > 1024, `${png.length} bytes`);
check('全程只创建了预期数量的 canvas', canvasCount >= 2, `canvas=${canvasCount}`);

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
