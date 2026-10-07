/**
 * glsl-check.mjs —— 用真正的 GLSL 解析器校验着色器源码能否编译
 * 这是"没有 GPU 也能确认 shader 语法正确"的最强静态证据。
 */
import { parser } from '/tmp/glslcheck/node_modules/@shaderfrog/glsl-parser/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// 从源码里抓出所有带 glsl 注释标记的模板字符串
const files = ['src/scene.js', 'src/pomegranate.js'];
let shaders = [];

// 着色器之间共用的 GLSL 片段是以 ${名字} 插进模板串里的。
// 正则抓到的是源码文本，看到的是字面量 "${GLSL_SRGB}" 而不是展开后的代码，
// 直接丢给解析器必然报错——所以先把这些共用片段读出来，按同名替换还原。
const SNIPPET_RE = /const\s+(\w+)\s*=\s*\/\*\s*glsl\s*\*\/\s*`([\s\S]*?)`/g;
const snippets = new Map();
for (const f of files) {
  const src = readFileSync(join(ROOT, f), 'utf8');
  for (const m of src.matchAll(SNIPPET_RE)) {
    if (/\bvoid\s+main\s*\(/.test(m[2])) continue;   // 完整着色器不参与替换
    snippets.set(m[1], m[2]);
  }
}
if (snippets.size) console.log(`  · 已载入共用 GLSL 片段：${[...snippets.keys()].join(', ')}`);

function expandSnippets(code) {
  let out = code;
  for (let i = 0; i < 4; i++) {
    const before = out;
    for (const [name, body] of snippets) {
      out = out.split('${' + name + '}').join(body);
    }
    if (out === before) break;
  }
  return out;
}

for (const f of files) {
  const src = readFileSync(join(ROOT, f), 'utf8');

  // /* glsl */`...` 形式的完整着色器
  for (const m of src.matchAll(/\/\*\s*glsl\s*\*\/\s*`([\s\S]*?)`/g)) {
    const body = m[1];
    // 只有带 main() 的才是完整着色器；纯函数定义（共用片段）跳过，
    // 不能拿"名字在片段表里"当判据——片段表是按 const 名收集的，会把顶点着色器一起收进去。
    if (!/\bvoid\s+main\s*\(/.test(body)) continue;
    shaders.push({ file: f, kind: 'glsl 模板', code: expandSnippets(body) });
  }

  // onBeforeCompile 里注入的片段（在 JS 模板串里）
  // 这些片段里含 three 的 #include 占位符，不是合法 GLSL，
  // 因此包一层 main() 并把占位符替换成等价的声明，再做语法校验。
  for (const m of src.matchAll(/\.replace\('#include <(\w+)>',\s*`([\s\S]*?)`\)/g)) {
    const body = expandSnippets(m[2])
      .replace(/#include <begin_vertex>/g, 'vec3 transformed = position;')
      .replace(/#include <\w+>/g, '');
    const wrapped = [
      'precision highp float;',
      'uniform float uTime;',
      'uniform float uWobble;',
      'uniform vec3 position;',
      'void main() {',
      body,
      '}',
    ].join('\n');
    shaders.push({ file: f, kind: `注入 #include <${m[1]}>（包 main 后校验）`, code: wrapped });
  }
}

if (!shaders.length) {
  console.log('没抓到着色器，请检查匹配规则');
  process.exit(1);
}

let bad = 0;
for (const sh of shaders) {
  const label = `${sh.file} · ${sh.kind}`;
  try {
    parser.parse(sh.code);
    console.log(`  ✓ ${label} 语法正确（${sh.code.split('\n').length} 行）`);
  } catch (e) {
    bad++;
    console.log(`  ✗ ${label} 语法错误：${e.message.split('\n')[0]}`);
    if (/\$\{\w+\}/.test(sh.code)) {
      console.log(`      提示：代码里还有未展开的 JS 插值 ${sh.code.match(/\$\{\w+\}/)[0]}，检查共用片段名是否拼错`);
    }
    const line = e.location?.start?.line;
    if (line) {
      const lines = sh.code.split('\n');
      for (let i = Math.max(0, line - 3); i < Math.min(lines.length, line + 2); i++) {
        console.log(`      ${i + 1 === line ? '>' : ' '} ${lines[i]}`);
      }
    }
  }
}

/* ---------------- 语义检查：smoothstep 的边界顺序 ----------------
   GLSL 规范要求 edge0 < edge1，反着写属于未定义行为：
   有的驱动会算出反向结果，有的直接给 0，换台设备就不一样。
   这类错误语法解析器抓不到，只能自己扫。                        */
console.log('\n[语义检查]');
let semantic = 0;
for (const sh of shaders) {
  const re = /smoothstep\s*\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,/g;
  for (const m of sh.code.matchAll(re)) {
    const [, e0, e1] = m;
    if (Number(e0) > Number(e1)) {
      semantic++;
      console.log(`  ✗ ${sh.file} · ${sh.kind}: smoothstep(${e0}, ${e1}, ...) 边界反序（未定义行为）`);
    }
  }
}
if (!semantic) console.log('  ✓ 没有 smoothstep 边界反序');

console.log(bad ? `\n✗ ${bad} 个着色器有语法错误` : `\n✓ 全部 ${shaders.length} 个着色器语法通过`);
if (semantic) process.exit(1);
process.exit(bad ? 1 : 0);
