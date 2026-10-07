/**
 * build-single.mjs —— 把整套项目打包成【单个自包含 HTML 文件】
 *
 * 为什么不用 <script type="module">：
 *   ES module 支持 importmap 与相对导入，但 file:// 下浏览器会以 CORS 拒绝加载
 *   模块文件。既然要合并成一个文件，就干脆用 classic script + 块级作用域，
 *   这样双击直接打开（file://）也能跑，不需要起服务器。
 *   为保持 ESM 的严格语义，每个块内首行都加 'use strict'。
 *
 * 做法：
 *   · three.js 末尾只有一行 `export { ... }`，替换成 `__BM.THREE = { ... }`
 *   · OrbitControls 的 `import {...} from 'three'` 换成从 __BM 解构
 *   · 自研模块的 import 换成从 __BM 取，export 关键字去掉，末尾挂到 __BM
 *   · CSS / DOM / 启动兜底逻辑一并内联
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/* ---------------- 1. three.js ---------------- */
let three = read('vendor/three.module.js');

// 抓出末尾那行 export 的名字列表
const exportMatch = three.match(/^export \{([\s\S]*?)\};?\s*$/m);
if (!exportMatch) throw new Error('未能定位 three.js 的 export 语句');
const exportedNames = exportMatch[1].trim();
console.log('three.js 导出符号数：', exportedNames.split(',').length);

three = three.replace(exportMatch[0], `__BM.THREE = {\n${exportedNames}\n};`);

/* ---------------- 2. OrbitControls ---------------- */
let orbit = read('vendor/OrbitControls.js');
const orbitImport = orbit.match(/^import \{([\s\S]*?)\} from 'three';/m);
if (!orbitImport) throw new Error('未能定位 OrbitControls 的 import 语句');
const orbitNames = orbitImport[1].replace(/\s+/g, ' ').trim();
orbit = orbit
  .replace(orbitImport[0], `const { ${orbitNames} } = __BM.THREE;`)
  .replace(/^export \{ OrbitControls \};?\s*$/m, '__BM.OrbitControls = OrbitControls;');

/* ---------------- 3. 自研模块 ---------------- */
function toBlock(src, { exports = [], trailer = '' } = {}) {
  let code = src
    // 统一把 import 换成从 __BM 取
    .replace(/^import \* as THREE from '[^']+';$/m, 'const THREE = __BM.THREE;')
    .replace(/^import \{ OrbitControls \} from '[^']+';$/m, 'const { OrbitControls } = __BM;')
    .replace(/^import \{ ([^}]+) \} from '\.\/(pomegranate|scene|plate)\.js';$/m,
      (m, names) => `const { ${names.replace(/\s+/g, ' ').trim()} } = __BM;`)
    // 去掉 export 关键字
    .replace(/^export /gm, '');

  if (/^\s*(import|export)\s/m.test(code)) {
    throw new Error('仍有未处理的 import/export：' + code.match(/^\s*(import|export)\s.*$/m)[0]);
  }
  const tail = exports.map((n) => `__BM.${n} = ${n};`).join('\n');
  return `{ 'use strict';\n${code}\n${tail}${trailer ? '\n' + trailer : ''}\n}`;
}

const pomegranate = toBlock(read('src/pomegranate.js'), {
  exports: ['PALETTE', 'CONFIG', 'makeBodyGeometry', 'makeSurface', 'createPomegranate'],
});
const scene = toBlock(read('src/scene.js'), {
  exports: ['makeGlowTexture', 'createScene'],
});
const plate = toBlock(read('src/plate.js'), {
  exports: ['OWNER', 'PLATE', 'drawPlateCanvas', 'makePlateTexture', 'createNamePlate', 'mountNamePlate'],
});
const mainRaw = read('src/main.js').replace(/^import .*$/gm, '').replace(/^export /gm, '');
const main = `{ 'use strict';\nconst THREE = __BM.THREE;\nconst { OrbitControls, createPomegranate, CONFIG, createScene, makeGlowTexture, mountNamePlate, OWNER } = __BM;\n${mainRaw}\n}`;

/* ---------------- 3.5 统一包装成块 ----------------
   关键：three.js 与 OrbitControls 也必须在各自块里。
   它们原本是 ESM，顶层各自声明了 Controls / MOUSE / Vector3 等名字，
   若直接平铺进同一个 <script> 会立刻撞名报
   "Identifier 'Controls' has already been declared"。
------------------------------------------------------- */
function wrap(code) {
  return `{ 'use strict';\n${code}\n}`;
}

/* ---------------- 4. CSS 与 DOM ---------------- */
const css = read('style.css');
let html = read('index.html');

// 取 <body> 内容，并删掉里面原有的 script（importmap 与模块加载器）
let bodyInner = html.match(/<body>([\s\S]*?)<\/body>/)[1]
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim();

// 单文件版不再需要"请起本地服务器"，
// 它双击就能跑，兜底只该说明浏览器不支持 WebGL2 这一种情况。
bodyInner = bodyInner.replace(
  /<div class="fallback-box">[\s\S]*?<\/div>/,
  `<div class="fallback-box">
    <h2>这个浏览器没能启动 3D 场景</h2>
    <p>最可能的原因是浏览器不支持 <b>WebGL2</b>，或者显卡加速被禁用了。</p>
    <p>可以试试：换 Chrome / Edge / Firefox 等现代浏览器打开；在浏览器设置里开启硬件加速；或把本文件放到手机上用系统浏览器打开。</p>
    <p class="hint">本页面是完全自包含的，不需要联网，也不需要本地服务器。</p>
  </div>`,
);

// 取 head 里的 meta 信息（title / description / viewport / favicon / theme-color）
const metas = (html.match(/<meta[^>]*>/g) || []).join('\n  ');
const title = html.match(/<title>([\s\S]*?)<\/title>/)[1];
const icon = html.match(/<link rel="icon"[^>]*>/)[0];

/* ---------------- 5. 拼装 ---------------- */
// 注意：横幅必须用 JS 块注释。写成 HTML 的 <!-- 会被 JS 当作单行注释，
// 导致横幅后面几行变成非法代码（这正是第一版构建时的真实报错）。
const banner = `/*
  石榴人 3D · 梁梦冉 —— 单文件版
  整套项目（three.js r169 + 建模 + 场景 + 交互 + 样式）已内联在这一个文件里。
  · 直接双击打开即可（file:// 也能跑，无需服务器、无需联网、无外部依赖）
  · 也可以丢到任意静态托管直接部署
  生成方式：node tools/build-single.mjs（源文件在 src/ 与 vendor/）
*/`;

const single = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
  ${metas.replace(/\n  /g, '\n  ')}
  <title>${title}</title>
  ${icon}
<style>
${css}
/* 单文件版：不需要外部样式表，兜底说明里不再提示起服务器 */
</style>
</head>
<body>

${bodyInner}

<script>
${banner}
/* ==================================================================
   单文件版：所有代码内联。顶层只有一个全局变量 __BM（模块注册表），
   每个库/模块各自包在一个块里，靠 'use strict' 保持 ESM 的严格语义，
   互不污染全局作用域。
   ================================================================== */
var __BM = {};
var __BM_READY = false;

/* ============ 1/6  three.js r169（MIT） ============ */
${wrap(three)}

/* ============ 2/6  OrbitControls ============ */
${wrap(orbit)}

/* ============ 3/6  石榴人建模 ============ */
${pomegranate}

/* ============ 4/6  抽象背景场景 ============ */
${scene}

/* ============ 5/6  名字铭牌 ============ */
${plate}

/* ============ 6/6  启动、交互与兜底 ============ */
(function () {
  var loader = document.getElementById('loader');
  var fallback = document.getElementById('fallback');

  function showFallback(msg) {
    if (loader) loader.classList.add('done');
    if (!fallback) return;
    fallback.hidden = false;
    var box = fallback.querySelector('.fallback-box');
    if (box && msg) {
      var p = document.createElement('p');
      p.className = 'err';
      p.textContent = '错误详情：' + msg;
      box.appendChild(p);
    }
  }

  try {
${main}
    __BM_READY = true;
    window.__pomegranateReady = true;
    if (loader) {
      setTimeout(function () { loader.classList.add('done'); }, 260);
      setTimeout(function () { if (loader.parentNode) loader.parentNode.removeChild(loader); }, 1200);
    }
  } catch (err) {
    console.error('[pomegranate] 启动失败：', err);
    showFallback(err && err.message ? err.message : String(err));
  }
})();
</script>
</body>
</html>
`;

const out = join(ROOT, 'pomegranate-lmr.html');
writeFileSync(out, single, 'utf8');

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log('\n已生成：' + out);
console.log('大小：' + kb(Buffer.byteLength(single)) + '（源项目 ' +
  kb(['index.html', 'style.css', 'src/pomegranate.js', 'src/scene.js', 'src/plate.js', 'src/main.js', 'vendor/three.module.js', 'vendor/OrbitControls.js']
    .reduce((s, f) => s + Buffer.byteLength(read(f)), 0)) + '）');
