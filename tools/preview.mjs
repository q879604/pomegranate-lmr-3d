/**
 * preview.mjs —— 纯软件光栅化预览器
 *
 * 容器里没有可用的浏览器/GPU，用 node 直接把 three.js 的几何体
 * 做一次 Z-buffer 光栅化，输出 PNG，用于目视检查造型是否到位。
 *
 * 用法：node tools/preview.mjs
 */
import * as THREE from '../vendor/three.module.js';
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createPomegranate } from '../src/pomegranate.js';

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgb) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  return Buffer.concat([
    sig, chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 光栅化渲染 ---------------- */
const LIGHT = new THREE.Vector3(0.55, 0.78, 0.62).normalize();
const LIGHT2 = new THREE.Vector3(-0.6, 0.3, -0.7).normalize();

function render(root, opts) {
  const {
    width = 700, height = 860, fov = 32,
    camPos = new THREE.Vector3(2.6, 2.0, 4.4),
    target = new THREE.Vector3(0.1, 1.35, 0),
    bgTop = [0.16, 0.13, 0.30],
    bgBottom = [0.05, 0.04, 0.10],
    time = 0,
  } = opts;

  const color = Buffer.alloc(width * height * 3);
  const depth = new Float32Array(width * height).fill(Infinity);

  // 背景渐变
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    const r = bgTop[0] + (bgBottom[0] - bgTop[0]) * t;
    const g = bgTop[1] + (bgBottom[1] - bgTop[1]) * t;
    const b = bgTop[2] + (bgBottom[2] - bgTop[2]) * t;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      color[i] = Math.round(r * 255);
      color[i + 1] = Math.round(g * 255);
      color[i + 2] = Math.round(b * 255);
    }
  }

  root.updateMatrixWorld(true);

  // 相机基
  const forward = target.clone().sub(camPos).normalize();
  const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, forward).normalize();
  const f = (height / 2) / Math.tan((fov * Math.PI) / 360);

  const project = (p) => {
    const d = p.clone().sub(camPos);
    const z = d.dot(forward);
    if (z <= 0.05) return null;
    return {
      x: width / 2 + (d.dot(right) / z) * f,
      y: height / 2 - (d.dot(up) / z) * f,
      z,
    };
  };

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const nrm = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();

  root.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry;
    const pos = geo.attributes.position;
    const idx = geo.index;
    const mw = o.matrixWorld;
    const col = o.material.color;
    // 顶点色：果皮网格用顶点色区分「果身黄 / 顶部果柄褐」，
    // 预览器必须跟浏览器一样把顶点色乘上去，否则整个身体会渲成白色。
    const vcol = o.material.vertexColors ? geo.attributes.color : null;
    const n = idx ? idx.count : pos.count;

    for (let i = 0; i < n; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, i0).applyMatrix4(mw);
      b.fromBufferAttribute(pos, i1).applyMatrix4(mw);
      c.fromBufferAttribute(pos, i2).applyMatrix4(mw);

      e1.subVectors(b, a);
      e2.subVectors(c, a);
      nrm.crossVectors(e1, e2).normalize();

      const pa = project(a), pb = project(b), pc = project(c);
      if (!pa || !pb || !pc) continue;

      // 背面剔除
      const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
      if (area >= 0) continue;

      // 光照
      // 取三角形三个角的顶点色平均（够用，预览只为看造型）
      let vr = col.r, vg = col.g, vb = col.b;
      if (vcol) {
        vr = (vcol.getX(i0) + vcol.getX(i1) + vcol.getX(i2)) / 3;
        vg = (vcol.getY(i0) + vcol.getY(i1) + vcol.getY(i2)) / 3;
        vb = (vcol.getZ(i0) + vcol.getZ(i1) + vcol.getZ(i2)) / 3;
      }
      const lam = Math.max(0, nrm.dot(LIGHT));
      const fill = Math.max(0, nrm.dot(LIGHT2)) * 0.35;
      const shade = 0.30 + 0.78 * lam + fill;
      const rim = Math.pow(1 - Math.max(0, nrm.dot(forward.clone().negate())), 3) * 0.25;
      const cr = Math.min(1, vr * col.r * (shade + rim));
      const cg = Math.min(1, vg * col.g * (shade + rim));
      const cb = Math.min(1, vb * col.b * (shade + rim));

      const minX = Math.max(0, Math.floor(Math.min(pa.x, pb.x, pc.x)));
      const maxX = Math.min(width - 1, Math.ceil(Math.max(pa.x, pb.x, pc.x)));
      const minY = Math.max(0, Math.floor(Math.min(pa.y, pb.y, pc.y)));
      const maxY = Math.min(height - 1, Math.ceil(Math.max(pa.y, pb.y, pc.y)));
      if (maxX < minX || maxY < minY) continue;

      const invArea = 1 / area;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5, py = y + 0.5;
          let w0 = ((pb.x - pa.x) * (py - pa.y) - (px - pa.x) * (pb.y - pa.y)) * invArea;
          let w1 = ((px - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (py - pa.y)) * invArea;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = pa.z * w2 + pb.z * w1 + pc.z * w0;
          const pi = y * width + x;
          if (z >= depth[pi]) continue;
          depth[pi] = z;
          const o3 = pi * 3;
          color[o3] = Math.round(cr * 255);
          color[o3 + 1] = Math.round(cg * 255);
          color[o3 + 2] = Math.round(cb * 255);
        }
      }
    }
  });

  return encodePNG(width, height, color);
}

/* ---------------- 主流程 ---------------- */
mkdirSync(new URL('../shots/', import.meta.url), { recursive: true });
const man = createPomegranate();
man.update(0.6);

// 石榴身形比香蕉矮胖，取景相应调整
// 角色总高：鞋底约 -0.9 ～ 果冠尖约 1.9，取景中心放在 0.5 附近
const BODY_TARGET = new THREE.Vector3(0.0, 0.52, 0);
const VIEWS = {
  front: { camPos: new THREE.Vector3(0.10, 0.95, 5.2), target: BODY_TARGET },
  threequarter: { camPos: new THREE.Vector3(3.3, 1.55, 3.9), target: BODY_TARGET },
  side: { camPos: new THREE.Vector3(5.2, 0.95, 0.2), target: BODY_TARGET },
  back: { camPos: new THREE.Vector3(0.2, 1.05, -5.2), target: BODY_TARGET },
  face: { camPos: new THREE.Vector3(0.10, 1.05, 2.6), target: new THREE.Vector3(0.0, 0.85, 0), fov: 26 },
  crown: { camPos: new THREE.Vector3(1.25, 2.10, 1.55), target: new THREE.Vector3(0.0, 1.42, 0), fov: 30 },
};

for (const [name, v] of Object.entries(VIEWS)) {
  const png = render(man.group, {
    ...v,
    width: (name === 'face' || name === 'crown') ? 660 : 680,
    height: (name === 'face' || name === 'crown') ? 620 : 880,
    target: v.target || BODY_TARGET,
    time: 0.6,
  });
  const out = new URL(`../shots/${name}.png`, import.meta.url);
  writeFileSync(out, png);
  console.log('wrote', out.pathname, png.length, 'bytes');
}
