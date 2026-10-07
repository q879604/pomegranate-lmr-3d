/**
 * verify.mjs —— 静态集成自检
 * 在缺少浏览器的情况下，尽可能抓住"部署后才会暴露"的低级错误：
 *   ① index.html 引用的静态资源是否存在
 *   ② 所有 ES module 的 import 路径是否存在、被导入的符号是否真的导出
 *   ③ main.js 里 getElementById 的 id 是否都在 index.html 中出现
 *   ④ CSS 里的关键类名是否与 HTML 对应
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let errors = 0;
let checks = 0;

const ok = (m) => { checks++; console.log('  ✓', m); };
const bad = (m) => { errors++; console.log('  ✗', m); };

console.log('\n[1] index.html 引用的资源');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1]);
const importMap = [...html.matchAll(/"three":\s*"\.\/([^"]+)"/g)].map((m) => m[1]);
const allRefs = [...new Set([...refs, ...importMap])];
for (const r of allRefs) {
  existsSync(join(ROOT, r)) ? ok(`存在 ${r}`) : bad(`缺失 ${r}`);
}

console.log('\n[2] ES module 的 import 完整性');
const MODULES = ['src/pomegranate.js', 'src/scene.js', 'src/plate.js', 'src/main.js'];
const RE_IMPORT = /import\s+(?:(\*\s+as\s+\w+)|(\{[^}]*\})|(\w+))\s+from\s+['"]([^'"]+)['"]/g;

for (const file of MODULES) {
  const code = readFileSync(join(ROOT, file), 'utf8');
  const dir = dirname(join(ROOT, file));
  for (const m of code.matchAll(RE_IMPORT)) {
    const spec = m[4];
    let target;
    if (spec === 'three') target = join(ROOT, 'vendor/three.module.js');
    else if (spec.startsWith('.')) target = resolve(dir, spec);
    else { bad(`${file}: 裸包名 "${spec}" 无法在静态部署中解析`); continue; }

    if (!existsSync(target)) { bad(`${file}: 找不到 ${spec} -> ${target}`); continue; }
    ok(`${file} 的 "${spec}" 可解析`);

    // 被导入的具名符号是否真的导出
    if (m[2]) {
      const names = m[2].replace(/[{}]/g, '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      const src = readFileSync(target, 'utf8');
      for (const n of names) {
        const hasExport = new RegExp(`export\\s+(?:async\\s+)?(?:function|class|const|let|var)\\s+${n}\\b`).test(src)
          || new RegExp(`export\\s*\\{[^}]*\\b${n}\\b`).test(src);
        hasExport ? ok(`${spec} 导出 ${n}`) : bad(`${spec} 未导出 ${n}（${file} 却在导入）`);
      }
    }
  }
}

console.log('\n[3] main.js 用到的 DOM id 是否都在 HTML 里');
const mainSrc = readFileSync(join(ROOT, 'src/main.js'), 'utf8');
const ids = [...mainSrc.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
for (const id of [...new Set(ids)]) {
  htmlIds.has(id) ? ok(`#${id} 存在于 HTML`) : bad(`#${id} 在 HTML 中不存在`);
}

console.log('\n[4] CSS 关键类与 HTML 对应');
const css = readFileSync(join(ROOT, 'style.css'), 'utf8');
for (const cls of ['loader', 'toolbar', 'tbtn', 'toast', 'fallback', 'hud']) {
  const inCss = new RegExp(`\\.${cls}\\b`).test(css);
  const inHtml = new RegExp(`class="[^"]*\\b${cls}\\b`).test(html);
  if (!inCss && !inHtml) bad(`类 .${cls} 既不在 CSS 也不在 HTML`);
  else if (!inCss) bad(`HTML 用了 .${cls} 但 CSS 里没有定义`);
  else if (!inHtml) bad(`CSS 定义了 .${cls} 但 HTML 没用`);
  else ok(`.${cls} 两端一致`);
}

console.log('\n[5] 禁止项检查（离线可部署）');
// 允许：w3.org 命名空间、SVG 的 xmlns、以及文档里作为示例的 localhost
const ALLOW = /^(https?:\/\/)?(www\.w3\.org|localhost|127\.0\.0\.1)\b|^https?:\/\/www\.w3\.org/;
const banned = [
  [/https?:\/\/[^\s'"`)]+/g, '外部网络请求'],
  [/fonts\.googleapis|cdn\.jsdelivr|unpkg\.com|cdnjs|googleapis\.com/g, 'CDN 引用'],
];
for (const file of ['index.html', 'style.css', ...MODULES]) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const body = src.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, '');
  for (const [re, label] of banned) {
    const hits = (body.match(re) || []).filter((h) => !ALLOW.test(h.replace(/&amp;/g, '&')));
    if (hits.length) bad(`${file}: 发现${label} -> ${hits.slice(0, 3).join(', ')}`);
  }
}
if (!errors) ok('无外部依赖，可完全离线部署');

console.log(`\n结果：${checks} 项通过，${errors} 项失败\n`);
process.exit(errors ? 1 : 0);
