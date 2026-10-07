/**
 * api-check.mjs —— 校验代码里用到的 three.js API 在本地版本里真实存在
 * 防止写出「本地没报错、浏览器一跑就 undefined」的调用。
 */
import * as THREE from '../vendor/three.module.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
console.log('three.js 版本：r' + THREE.REVISION);

const src = ['src/pomegranate.js', 'src/scene.js', 'src/main.js']
  .map((f) => readFileSync(join(ROOT, f), 'utf8'))
  .join('\n');

// 收集 THREE.Xxx 形式的引用
const used = [...new Set([...src.matchAll(/\bTHREE\.([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1]))].sort();

let bad = 0;
const missing = [];
for (const name of used) {
  const exists = name in THREE;
  if (!exists) { missing.push(name); bad++; }
}

console.log(`引用了 ${used.length} 个 THREE.* 符号`);
if (missing.length) {
  console.log('  ✗ 不存在：' + missing.join(', '));
} else {
  console.log('  ✓ 全部存在');
}

// 实例属性（在构造函数里赋值，不在 prototype 上）只能查源码定义
const threeSrc = readFileSync(join(ROOT, 'vendor/three.module.js'), 'utf8');
const attrChecks = [
  ['this.compile = function', 'WebGLRenderer.compile 定义'],
  ['this.setPixelRatio = function', 'WebGLRenderer.setPixelRatio 定义'],
  ['_this.shadowMap = shadowMap', 'WebGLRenderer.shadowMap 定义'],
  ['this.colorSpace = colorSpace', 'Texture.colorSpace 定义'],
];
for (const [needle, label] of attrChecks) {
  const ok = threeSrc.includes(needle);
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
  if (!ok) bad++;
}

// prototype 上的方法
for (const [cls, prop] of [['Vector3', 'projectOnPlane'], ['Matrix4', 'makeBasis']]) {
  const ok = prop in THREE[cls].prototype;
  console.log(`  ${ok ? '✓' : '✗'} ${cls}.${prop}`);
  if (!ok) bad++;
}

// 常量存在性
for (const k of ['SRGBColorSpace', 'ACESFilmicToneMapping', 'PCFSoftShadowMap', 'EquirectangularReflectionMapping', 'FogExp2', 'CanvasTexture', 'Sprite']) {
  const ok = k in THREE;
  console.log(`  ${ok ? '✓' : '✗'} THREE.${k}`);
  if (!ok) bad++;
}

// scene.environmentIntensity 是较新特性，确认版本支持
const rs = new THREE.Scene();
console.log(`  ${'environmentIntensity' in rs ? '✓' : '✗'} Scene.environmentIntensity (r169 应为 true)`);

console.log(bad ? `\n✗ ${bad} 项问题` : '\n✓ API 全部可用');
process.exit(bad ? 1 : 0);
