/**
 * main.js —— 入口：渲染循环、轨道控制、交互与 UI
 *
 * 交互设计：
 *   · 单指拖动 / 鼠标左键拖动  -> 环绕旋转（OrbitControls）
 *   · 滚轮 / 双指捏合          -> 缩放
 *   · 单指点击角色             -> 触发一次弹跳 + 鬼脸
 *   · 空格                     -> 暂停/继续自转
 *   · R                        -> 复位视角
 *   · T                        -> 切换背景主题
 *   · N                        -> 显示/隐藏头顶铭牌
 *   · 自动旋转                 -> 默认开启，手指触碰时暂停，松手 2.2 秒后恢复
 *
 * 另含：头顶悬浮的名字铭牌，以及"眼睛永远看着镜头"的眼神跟随。
 */

import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { createPomegranate, CONFIG } from './pomegranate.js';
import { createScene, makeGlowTexture } from './scene.js';
import { mountNamePlate, OWNER } from './plate.js';

/* ------------------------------------------------------------------ */
/* 渲染器                                                              */
/* ------------------------------------------------------------------ */
const canvas = document.getElementById('stage');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.outputColorSpace = THREE.SRGBColorSpace;

/* ------------------------------------------------------------------ */
/* 场景与角色                                                          */
/* ------------------------------------------------------------------ */
const world = createScene(renderer);
const { scene, camera } = world;

const man = createPomegranate();
// 背景环境贴图是彩色的（金属泡要用），但主角不能吃它：
// 挂一份中性照明环境到角色身上，避免果皮被背景色染暗、染色。
world.setCharacterEnv(man.group);
scene.add(man.group);

// 把模型摆到地面上：让最低点（鞋底）正好落在地面圆盘上
{
  const bbox = new THREE.Box3().setFromObject(man.group);
  man.group.position.y = -bbox.min.y + world.ground.position.y;
}

/* ------------------------------------------------------------------ */
/* 头顶名字铭牌                                                        */
/* ------------------------------------------------------------------ */
const { plate: namePlate } = mountNamePlate(man.group);
namePlate.castShadow = false;
man.parts.plate = namePlate;

// 铭牌背后的柔光，让它在暗背景下也能看清
{
  const c = new THREE.Color(0xffb43a);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: makeGlowTexture(`rgba(${(c.r * 255) | 0},${(c.g * 255) | 0},${(c.b * 255) | 0},0.55)`),
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.42,
    fog: false,
  }));
  halo.scale.set(2.6, 2.6, 1);
  halo.position.copy(namePlate.position);
  halo.name = 'plateHalo';
  man.group.add(halo);
  man.parts.plateHalo = halo;
}

/* ------------------------------------------------------------------ */
/* 轨道控制                                                            */
/* ------------------------------------------------------------------ */
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.62, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.075;
controls.rotateSpeed = 0.85;
controls.zoomSpeed = 0.9;
controls.enablePan = false;              // 只允许环绕与缩放，避免"甩丢"
controls.minDistance = 2.6;
controls.maxDistance = 14.0;
controls.minPolarAngle = 0.30;
controls.maxPolarAngle = Math.PI * 0.86;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.05;

const HOME = {
  pos: new THREE.Vector3(2.1, 1.9, 5.4),
  target: controls.target.clone(),
};
camera.position.copy(HOME.pos);

/* ------------------------------------------------------------------ */
/* 交互：点角色触发动作                                                */
/* ------------------------------------------------------------------ */
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pointerDownAt = null;
let action = null;         // 当前触发的动作 { kind, start }
let paused = false;

function pickBody(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(man.group, true);
  return hits.length > 0 ? hits[0] : null;
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDownAt = { x: e.clientX, y: e.clientY, t: performance.now() };
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (!pointerDownAt) return;
  const moved = Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y);
  const held = performance.now() - pointerDownAt.t;
  pointerDownAt = null;
  // 只在"轻点"时触发，拖动旋转时不误触
  if (moved > 8 || held > 420) return;
  if (!pickBody(e)) return;
  const kinds = ['hop', 'spin', 'wobble'];
  const kind = kinds[(Math.random() * kinds.length) | 0];
  action = { kind, start: performance.now() / 1000 };
  playGlint();
});

/* ---------------- 拖拽时暂停自转，松手后恢复 ---------------- */
let resumeTimer = null;
controls.addEventListener('start', () => {
  clearTimeout(resumeTimer);
  controls.autoRotate = false;
});
controls.addEventListener('end', () => {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(() => {
    controls.autoRotate = !paused;
  }, 2200);
});

/* ---------------- 眼神跟随：眼睛永远看向镜头 ---------------- */
const _camLocal = new THREE.Vector3();
const _faceCenter = man.surface.point(CONFIG.faceT, CONFIG.faceTheta);

function updateGazeTowardCamera() {
  const anchors = man.parts.faceAnchors;
  const eyeL = anchors.eyeL;
  if (!eyeL) return;
  _camLocal.copy(camera.position);
  man.group.worldToLocal(_camLocal);
  const dir = _camLocal.sub(_faceCenter).normalize();
  const dx = dir.dot(eyeL.userData.localX);
  const dy = dir.dot(eyeL.userData.localY);
  man.setGaze(dx * 0.85, dy * 0.85 + 0.06);
}

/* ---------------- 闪光反馈 ---------------- */
const GLINT_TEXTURE = makeGlowTexture('rgba(255,255,255,0.95)');

function playGlint() {
  const colors = [0xff5f7a, 0xffb43a, 0xffe08a, 0xd44bff];
  const c = colors[(Math.random() * colors.length) | 0];
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({
    color: c, transparent: true, opacity: 0.9,
    map: GLINT_TEXTURE, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  sp.scale.set(0.6, 0.6, 1);
  sp.position.set(0, 1.05, 0.35);
  scene.add(sp);
  const t0 = performance.now() / 1000;
  let raf;
  const tick = () => {
    const k = performance.now() / 1000 - t0;
    if (k > 0.75) { scene.remove(sp); sp.material.dispose(); cancelAnimationFrame(raf); return; }
    const s = 0.6 + k * 4.2;
    sp.scale.set(s, s, 1);
    sp.material.opacity = 0.9 * (1 - k / 0.75);
    raf = requestAnimationFrame(tick);
  };
  tick();
}

/* ------------------------------------------------------------------ */
/* 键盘快捷键                                                          */
/* ------------------------------------------------------------------ */
const toastEl = document.getElementById('toast');
let toastTimer = null;
function toast(text) {
  if (!toastEl) return;
  toastEl.textContent = text;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1600);
}

function resetView() {
  camera.position.copy(HOME.pos);
  controls.target.copy(HOME.target);
  controls.update();
  toast('视角已复位');
}

function togglePause() {
  paused = !paused;
  controls.autoRotate = !paused;
  const btn = document.getElementById('btn-rotate');
  if (btn) btn.classList.toggle('on', !paused);
  toast(paused ? '已暂停自转' : '继续自转');
}

function cycleTheme() {
  const name = world.nextTheme();
  const label = { ruby: '宝石红', gold: '蜜金', juice: '果汁紫' }[name] || name;
  toast('背景主题：' + label);
}

const btnRotate = document.getElementById('btn-rotate');
const btnReset = document.getElementById('btn-reset');
const btnTheme = document.getElementById('btn-theme');
const btnShot = document.getElementById('btn-shot');
const btnPlate = document.getElementById('btn-plate');

function togglePlate() {
  namePlate.visible = !namePlate.visible;
  if (man.parts.plateHalo) man.parts.plateHalo.visible = namePlate.visible;
  if (btnPlate) btnPlate.classList.toggle('on', namePlate.visible);
  toast(namePlate.visible ? `铭牌已显示：${OWNER.name}` : '铭牌已隐藏');
}

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  else if (e.key === 'r' || e.key === 'R') resetView();
  else if (e.key === 't' || e.key === 'T') cycleTheme();
  else if (e.key === 'n' || e.key === 'N') togglePlate();
});

/* ------------------------------------------------------------------ */
/* UI 接线                                                             */
/* ------------------------------------------------------------------ */
if (btnRotate) {
  btnRotate.classList.add('on');
  btnRotate.addEventListener('click', () => { togglePause(); btnRotate.blur(); });
}
if (btnReset) btnReset.addEventListener('click', () => { resetView(); btnReset.blur(); });
if (btnTheme) btnTheme.addEventListener('click', () => { cycleTheme(); btnTheme.blur(); });
if (btnPlate) {
  btnPlate.classList.add('on');
  btnPlate.addEventListener('click', () => { togglePlate(); btnPlate.blur(); });
}
if (btnShot) {
  btnShot.addEventListener('click', () => {
    // 先渲染一帧，再取像素，确保拿到的是当前画面
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url;
    a.download = `pomegranate-${Date.now()}.png`;
    a.click();
    toast('已保存 PNG 截图');
    btnShot.blur();
  });
}

/* ------------------------------------------------------------------ */
/* 尺寸自适应                                                          */
/* ------------------------------------------------------------------ */
function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // 窄屏时拉远一点，保证角色完整入镜
  camera.fov = w / h < 0.85 ? 46 : 38;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 120));
resize();

/* ------------------------------------------------------------------ */
/* 主循环                                                              */
/* ------------------------------------------------------------------ */
const clock = new THREE.Clock();
const groupBaseY = man.group.position.y;
const groupBaseRotY = 0;

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;

  // 顶部飘浮 + 呼吸式缩放
  man.group.position.y = groupBaseY + Math.sin(t * 1.35) * 0.050;
  const breathe = 1 + Math.sin(t * 1.9) * 0.012;
  man.group.scale.set(breathe, 2 - breathe, breathe);

  // 点按动作
  if (action) {
    const k = t - action.start;
    if (action.kind === 'hop') {
      if (k > 1.05) action = null;
      else man.group.position.y = groupBaseY + Math.abs(Math.sin(k * Math.PI * 2.1)) * 0.34 *
        (1 - Math.max(0, (k - 0.55) / 0.5));
    } else if (action.kind === 'spin') {
      if (k > 1.5) { man.group.rotation.y = groupBaseRotY; action = null; }
      else {
        const p = k / 1.5;
        man.group.rotation.y = groupBaseRotY + Math.PI * 2 * (1 - Math.pow(1 - p, 3));
      }
    } else if (action.kind === 'wobble') {
      if (k > 1.3) action = null;
    }
  } else {
    man.group.rotation.y = groupBaseRotY;
  }

  // 被点中"软弹"时给顶点着色器加一个衰减增益
  const wobbleGain = action && action.kind === 'wobble'
    ? 3.4 * Math.max(0, 1 - (t - action.start) / 1.3)
    : 0;

  // 软弹动作额外做一次纵向挤压回弹（卡通式 squash & stretch）
  if (action && action.kind === 'wobble') {
    const p = (t - action.start) / 1.3;
    const squash = 1 + Math.sin(p * Math.PI * 2.4) * 0.055 * (1 - p);
    man.group.scale.set(breathe * squash, (2 - breathe) / squash, breathe * squash);
  }

  man.update(t, wobbleGain, dt);
  updateGazeTowardCamera();

  // 铭牌水平朝向镜头，任何角度看都是正的
  if (namePlate.visible) {
    _camLocal.copy(camera.position);
    man.group.worldToLocal(_camLocal);
    namePlate.rotation.y = Math.atan2(
      _camLocal.x - namePlate.position.x,
      _camLocal.z - namePlate.position.z,
    );
    if (man.parts.plateHalo) {
      man.parts.plateHalo.scale.setScalar(2.5 + Math.sin(t * 1.6) * 0.16);
    }
  }

  world.update(dt, t);
  controls.update();

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

// 预热：编译着色器，避免首帧卡顿
renderer.compile(scene, camera);
animate();
