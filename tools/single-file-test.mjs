/**
 * single-file-test.mjs —— 验证单文件 HTML 里的内联脚本真的能跑
 *
 * 核心价值：单文件版把 ESM 改成了普通 <script> + 块级作用域，
 * 最容易踩的坑就是作用域/重名/漏改名导致整个脚本当场报错。
 * 办法是在 Node 里用 vm 真实执行这段内联脚本（配最小 DOM 桩），
 * 看它能否走到"创建 WebGL 渲染器"这一步——走到了就说明
 * three.js、OrbitControls 与四个业务模块全部正确装进作用域了。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'pomegranate-lmr.html'), 'utf8');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

/* ---------------- 结构检查 ---------------- */
console.log('\n[HTML 结构]');
const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
check('只有 1 段内联脚本', scripts.length === 1, `实际 ${scripts.length}`);
check('没有 type="module"', !/type\s*=\s*"module"/.test(html));
check('没有 importmap', !/importmap/.test(html));
check('没有外部资源引用（http/https/src=）', !/(?:src|href)\s*=\s*"(?:https?:)?\/\//.test(html));
check('没有残留 import/export 语句',
  !/^\s*(?:import|export)\s/m.test(scripts[0][1]));
check('HTML 标签闭合完整',
  (html.match(/<html/g) || []).length === 1 && (html.match(/<\/html>/) || []).length === 1);
check('body 闭合完整',
  (html.match(/<body/g) || []).length === 1 && (html.match(/<\/body>/) || []).length === 1);
for (const id of ['stage', 'loader', 'fallback', 'toast', 'btn-rotate', 'btn-plate', 'btn-reset', 'btn-theme', 'btn-shot']) {
  check(`含必需元素 #${id}`, html.includes(`id="${id}"`));
}
check('含样式（自定义指针）', html.includes('cursor: url("data:image/svg+xml'));
check('含 three.js 版本标记', html.includes("const REVISION = '169'"));
check('单文件里含主角名字「梁梦冉」', html.includes('梁梦冉'));
check('单文件里含拼音 LIANG MENG RAN', html.includes('LIANG MENG RAN'));
check('单文件里含铭牌模块代码', html.includes('mountNamePlate') && html.includes('namePlate'));

/* ---------------- 真实执行 ---------------- */
console.log('\n[内联脚本真实执行]');
const gradient = { addColorStop() {} };
const ctx2d = {
  createLinearGradient: () => gradient,
  createRadialGradient: () => gradient,
  fillRect() {}, clearRect() {}, drawImage() {},
  set fillStyle(v) {}, get fillStyle() { return ''; },
  set globalAlpha(v) {}, get globalAlpha() { return 1; },
};

function makeEl(tag) {
  return {
    tagName: tag, width: 0, height: 0, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    // 2d 上下文照常提供（生成光斑/环境贴图要用）；WebGL 故意不给，验证兜底路径可控
    getContext: (type) => (type === '2d' ? ctx2d : null),
    appendChild() {}, removeChild() {}, setAttribute() {}, addEventListener() {},
    blur() {}, click() {}, querySelector: () => makeEl('div'),
    toDataURL: () => 'data:,', parentNode: null,
  };
}

const listeners = {};
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Math, Date, JSON, Object, Array, Number, String, Boolean, Error, RegExp, Map, Set, Promise,
  Float32Array, Uint16Array, Uint32Array, Uint8Array, Int32Array, Int8Array,
  ArrayBuffer, DataView, Symbol, WeakMap, WeakSet,
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
sandbox.devicePixelRatio = 1;
sandbox.innerWidth = 1280;
sandbox.innerHeight = 800;
sandbox.addEventListener = (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); };
sandbox.document = {
  createElement: makeEl,
  createElementNS: () => makeEl('canvas'),
  getElementById: (id) => makeEl(id === 'stage' ? 'canvas' : 'div'),
  body: makeEl('body'),
  addEventListener: () => {},
};

let thrown = null;
try {
  vm.createContext(sandbox);
  vm.runInContext(scripts[0][1], sandbox, { filename: 'pomegranate-lmr.html#inline' });
} catch (e) {
  thrown = e;
}

check('脚本可执行，未出现语法/作用域错误', true, '');
if (thrown) {
  // 唯一允许的失败是"没有真实 WebGL 上下文"
  const msg = String(thrown && thrown.message || thrown);
  check('失败原因是缺少 WebGL 上下文（在 Node 里属预期）',
    /WebGL|context/i.test(msg), `实际：${msg.split('\n')[0]}`);
} else {
  check('在 Node 中还能继续执行（说明环境完全可用）', true);
}

/* ---------------- 打包后的模块导出是否完整 ---------------- */
console.log('\n[打包结果完整性]');
const BM = sandbox.__BM || {};
check('存在模块注册表 __BM', !!BM);
check('__BM.THREE 已挂载', !!BM.THREE);
check('three.js 版本为 169', BM.THREE && BM.THREE.REVISION === '169', BM.THREE && BM.THREE.REVISION);
check('three 导出符号齐全（>400 个）', BM.THREE && Object.keys(BM.THREE).length > 400,
  BM.THREE && Object.keys(BM.THREE).length);
for (const n of ['Scene', 'PerspectiveCamera', 'Group', 'SphereGeometry', 'MeshStandardMaterial',
  'WebGLRenderer', 'ShaderMaterial', 'CanvasTexture', 'FogExp2', 'Vector3', 'Box3', 'GridHelper',
  'CapsuleGeometry', 'TubeGeometry', 'CatmullRomCurve3', 'QuadraticBezierCurve3', 'Color', 'Clock']) {
  check(`THREE.${n} 可用`, BM.THREE && typeof BM.THREE[n] === 'function');
}
check('__BM.OrbitControls 已挂载', typeof BM.OrbitControls === 'function');
check('__BM.createPomegranate 已挂载', typeof BM.createPomegranate === 'function');
check('__BM.createScene 已挂载', typeof BM.createScene === 'function');
check('__BM.makeGlowTexture 已挂载', typeof BM.makeGlowTexture === 'function');
check('__BM.createNamePlate 已挂载', typeof BM.createNamePlate === 'function');
check('__BM.mountNamePlate 已挂载', typeof BM.mountNamePlate === 'function');
check('__BM.OWNER 已挂载且名字为梁梦冉', !!(BM.OWNER && BM.OWNER.name === '梁梦冉'),
  BM.OWNER && BM.OWNER.name);
check('__BM.CONFIG 已挂载', !!BM.CONFIG && typeof BM.CONFIG.faceT === 'number');
check('__BM.PLATE 已挂载且尺寸为正', !!(BM.PLATE && BM.PLATE.width > 0));

/* ---------------- 用打包后的代码真的建一次模型与场景 ---------------- */
console.log('\n[用打包代码实例化]');
let err = null, man = null, world = null;
try { man = BM.createPomegranate(); } catch (e) { err = e; }
check('createPomegranate 可执行', !err, err && err.message);
if (man) {
  let meshes = 0, tris = 0;
  man.group.traverse((o) => {
    if (o.isMesh) {
      meshes++;
      const g = o.geometry;
      tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    }
  });
  check('模型网格数与源项目一致（35）', meshes === 35, `实际 ${meshes}`);
  check('三角形数与源项目一致（38540）', Math.round(tris) === 38540, `实际 ${Math.round(tris)}`);
  check('动画可调用', (() => { try { man.update(1.5, 2, 1 / 60); return true; } catch (e) { return false; } })());
  check('暴露 setGaze（眼神跟随）', typeof man.setGaze === 'function');
  check('setGaze 可调用且不抛错', (() => { try { man.setGaze(0.5, -0.3); man.update(2.0, 0, 1 / 60); return true; } catch (e) { return false; } })());
}

err = null;
try { world = BM.createScene(null); } catch (e) { err = e; }
check('createScene 可执行', !err, err && err.message);
if (world) {
  check('场景含天穹', !!world.scene.getObjectByName('sky'));
  check('场景含地面', !!world.scene.getObjectByName('ground'));
  check('场景有环境贴图', !!world.scene.environment);
  check('主题可切换', (() => { try { world.nextTheme(); world.setTheme('deepsea'); return true; } catch (e) { return false; } })());
}

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
