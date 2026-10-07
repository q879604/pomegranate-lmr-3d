/**
 * integration-test.mjs —— 无浏览器下的运行期集成测试
 *
 * 做法：给 three.js 打一层最小 DOM 桩（canvas / 2D context），
 * 然后真正实例化场景与角色，调用 update / setTheme / 着色器注入等真实路径，
 * 用来抓住"语法没错、一跑就炸"的问题。
 */

/* ---------------- 最小 DOM 桩 ---------------- */
const gradientStub = { addColorStop() {} };
const ctx2dStub = {
  createLinearGradient: () => gradientStub,
  createRadialGradient: () => gradientStub,
  fillRect() {}, clearRect() {}, drawImage() {},
  set fillStyle(v) {}, get fillStyle() { return ''; },
};

globalThis.document = {
  createElement(tag) {
    if (tag === 'canvas') {
      return { width: 0, height: 0, style: {}, getContext: () => ctx2dStub };
    }
    return { style: {}, appendChild() {} };
  },
  createElementNS() { return this.createElement('canvas'); },
};
globalThis.window = { devicePixelRatio: 1, addEventListener() {}, innerWidth: 1280, innerHeight: 800 };
globalThis.self = globalThis.window;

const THREE = await import('../vendor/three.module.js');
const { createScene } = await import('../src/scene.js');
const { createPomegranate } = await import('../src/pomegranate.js');

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

/* ================= 场景 ================= */
console.log('\n[场景]');
const world = createScene(null);
check('createScene 返回 scene', world.scene instanceof THREE.Scene);
check('天穹已加入场景', !!world.scene.getObjectByName('sky'));
check('天穹是 BackSide 的 ShaderMaterial',
  world.scene.getObjectByName('sky').material.side === THREE.BackSide);
check('地面已加入场景', !!world.scene.getObjectByName('ground'));
check('地面是扭曲色场着色器（不是规整网格）',
  !!world.floorUniforms && !!world.scene.getObjectByName('ground').material.uniforms.uTime);
check('场景里没有 GridHelper 网格', !world.scene.getObjectByName('grid'));
check('漂浮体数量 > 20', world.scene.getObjectByName('floaters').children.length > 20);
check('有环境贴图', !!world.scene.environment);
check('环境贴图是 equirect 映射',
  world.scene.environment.mapping === THREE.EquirectangularReflectionMapping);
check('有雾效', world.scene.fog instanceof THREE.FogExp2);
check('有阴影光源', world.lights.key.castShadow === true);
check('阴影相机投影矩阵已刷新（非默认 ±5/far500）',
  world.lights.key.shadow.camera.right !== 5 || world.lights.key.shadow.camera.far !== 500);
check('有碎片星域', !!world.scene.getObjectByName('starfield') &&
  world.scene.getObjectByName('starfield').geometry.attributes.position.count > 1000);
check('有断裂巨环', !!world.scene.getObjectByName('rings') &&
  world.scene.getObjectByName('rings').children.length >= 3);
check('有流体金属泡（metalness 高、roughness 低）', (() => {
  const blobs = world.floatGroup.children.filter((m) => m.material && !m.material.wireframe);
  return blobs.length >= 5 && blobs.every((m) => m.material.metalness > 0.4 && m.material.roughness < 0.25);
})());

/* ---- 巨环必须远离角色：环绕式大环会横穿角色身前把主体挡住 ---- */
{
  const rings = world.scene.getObjectByName('rings').children;
  const minDist = Math.min(...rings.map((r) => Math.hypot(r.position.x, r.position.z)));
  check('巨环都远离原点（水平距离 > 5，绝不环绕角色）', minDist > 5,
    `最近 ${minDist.toFixed(2)}`);
}

console.log('\n[场景更新与主题切换]');
let err = null;
try { for (let i = 0; i < 60; i++) world.update(1 / 60, i / 60); } catch (e) { err = e; }
check('update 连续调用 60 帧无异常', !err, err && err.message);
check('天穹跟随相机位置', world.sky.position.distanceTo(world.camera.position) < 1e-6);

const t0 = world.themeName;
const t1 = world.nextTheme();
const t2 = world.nextTheme();
const t3 = world.nextTheme();
check('主题循环切换回到初始值', t3 === t0, `${t0} -> ${t1} -> ${t2} -> ${t3}`);
check('切换后环境贴图已重建', !!world.scene.environment);

const floorC0 = world.floorUniforms.uColorC.value.getHex();
world.setTheme('gold');
const floorC1 = world.floorUniforms.uColorC.value.getHex();
check('换主题后地面色场颜色确实改变', floorC0 !== floorC1,
  `0x${floorC0.toString(16)} vs 0x${floorC1.toString(16)}`);
check('地面着色器带时间 uniform 且在推进', (() => {
  const before = world.floorUniforms.uTime.value;
  for (let i = 0; i < 5; i++) world.update(1 / 60, 10 + i / 60);
  return world.floorUniforms.uTime.value > before;
})());
check('星域随时间漂移', (() => {
  const pos = world.scene.getObjectByName('starfield').geometry.attributes.position;
  const before = pos.array[1];
  for (let i = 0; i < 10; i++) world.update(1 / 60, 20 + i / 60);
  return pos.array[1] !== before;
})());

/* ---- 角色中性环境：背景的彩色 envmap 不能染到主角身上 ---- */
{
  const man0 = createPomegranate();
  const before = man0.parts.body.material.envMap;
  world.setCharacterEnv(man0.group);
  check('setCharacterEnv 给角色材质挂上了独立环境贴图',
    man0.parts.body.material.envMap !== before && !!man0.parts.body.material.envMap);
  check('角色环境贴图不是场景那张彩色环境（避免被背景染色）',
    man0.parts.body.material.envMap !== world.scene.environment);
}

/* ================= 角色 ================= */
console.log('\n[角色]');
const man = createPomegranate();
let meshCount = 0, triCount = 0;
man.group.traverse((o) => {
  if (o.isMesh) {
    meshCount++;
    const g = o.geometry;
    triCount += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
  }
});
check('网格数量合理（20~50）', meshCount >= 20 && meshCount <= 50, `实际 ${meshCount}`);
check('三角形数量合理（2 万~8 万）', triCount > 20000 && triCount < 80000, `实际 ${Math.round(triCount)}`);
check('存在果身网格', !!man.parts.body);
check('存在果冠', !!man.parts.crownGroup);
check('存在左右手臂', !!man.parts.arms.armL && !!man.parts.arms.armR);
check('存在左右腿', !!man.parts.legs.legL && !!man.parts.legs.legR);
check('存在左右眼锚点', !!man.parts.faceAnchors.eyeL && !!man.parts.faceAnchors.eyeR);

const eye = man.parts.faceAnchors.eyeL;
check('眼睛暴露 pupil 引用', !!eye.userData.pupil);
check('眼睛暴露局部坐标轴', !!eye.userData.localX && !!eye.userData.localY);
check('暴露 setGaze（眼神跟随）', typeof man.setGaze === 'function');
check('setGaze 可调用且不抛错', (() => { try { man.setGaze(0.5, -0.3); man.update(2.0, 0, 1 / 60); return true; } catch (e) { return false; } })());

// 左右四肢必须等高（香蕉人项目踩过的真实缺陷）
const yL = man.parts.arms.armL.position.y;
const yR = man.parts.arms.armR.position.y;
check('左右手臂挂点等高', Math.abs(yL - yR) < 1e-6, `${yL} vs ${yR}`);
const lL = man.parts.legs.legL.position.y;
const lR = man.parts.legs.legR.position.y;
check('左右腿挂点等高', Math.abs(lL - lR) < 1e-6, `${lL} vs ${lR}`);

/* ---- 四肢挂点必须在「侧面」：果身是个宽球，挂点靠正面会被肚子挡住 ---- */
{
  const bodyR = man.surface.radius;
  for (const [name, g] of [['手臂', man.parts.arms.armL], ['腿', man.parts.legs.legL]]) {
    const horiz = Math.hypot(g.position.x, g.position.z);
    // 挂点离中轴的水平距离要足够大，四肢才有机会露在果身轮廓外
    check(`${name}挂点位于果身侧面（水平距离 > 60% 果身半径）`,
      horiz > bodyR * 0.60, `${horiz.toFixed(3)} vs ${(bodyR * 0.60).toFixed(3)}`);
  }
}

/* ---- 果冠：是一张连续曲面，不是一圈拼起来的圆锥 ---- */
{
  const crownShell = man.parts.crownGroup.getObjectByName('crownShell');
  check('果冠外壁是一张单一网格（crownShell）', !!crownShell);
  check('果冠外壁是开放式曲面（有独立内壁 crownInner）',
    !!man.parts.crownGroup.getObjectByName('crownInner'));
  check('果冠张开的半径大于果冠颈半径（真的外张）', (() => {
    const pos = crownShell.geometry.attributes.position;
    let maxR = 0;
    for (let i = 0; i < pos.count; i++) {
      maxR = Math.max(maxR, Math.hypot(pos.getX(i), pos.getZ(i)));
    }
    return maxR > man.crown.neckRadius * 1.15;
  })(), `颈半径 ${man.crown.neckRadius.toFixed(3)}`);

  // 齿状边缘：顶端高度沿角度必须有明显起伏（否则就是一个平口圆筒）
  check('果冠顶端呈齿状（高度沿角度起伏）', (() => {
    const pos = crownShell.geometry.attributes.position;
    const H = man.crown.baseY + man.crown.length;
    let hi = -Infinity, lo = Infinity;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > H * 0.80) { hi = Math.max(hi, y); lo = Math.min(lo, y); }
    }
    return Number.isFinite(hi) && Number.isFinite(lo) && (hi - lo) > man.crown.length * 0.15;
  })());

  check('果冠齿数与配置一致', man.crown.sepalCount >= 5 && man.crown.sepalCount <= 10,
    `实际 ${man.crown.sepalCount}`);

  // 果冠顶端必须是角色最高处
  man.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(man.group);
  check('果冠顶端就是角色最高处（差值 < 0.12）',
    Math.abs(box.max.y - man.crown.topY) < 0.12,
    `包围盒顶 ${box.max.y.toFixed(3)} vs 果冠顶 ${man.crown.topY.toFixed(3)}`);

  // 果身必须连续过渡到果冠颈。
  // 判据不能用「绝对跳变 < 常数」：果身中部本来就有最大斜率，
  // 加密采样时跳变会同比变小，用常数比会误报。
  // 真正要找的是"断裂"——某处跳变远大于整体分布，所以用离群比值判定。
  // （真实反例：早期底部是个平底圆盘，接缝处比值高达 5.56）
  {
    const N = 2000;
    const jumps = [];
    for (let i = 1; i <= N; i++) {
      jumps.push(Math.abs(man.surface.profile(i / N) - man.surface.profile((i - 1) / N)));
    }
    const sorted = [...jumps].sort((a, b) => a - b);
    const max = sorted[sorted.length - 1];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const ratio = max / Math.max(p99, 1e-9);
    check('果身半径沿高度无断裂（最大跳变不超过 99 分位的 2 倍）', ratio < 2.0,
      `比值 ${ratio.toFixed(2)}（最大 ${max.toFixed(6)} / 99分位 ${p99.toFixed(6)}）`);
  }
  check('果冠颈明显细于果身最粗处', man.crown.neckRadius < man.surface.radius * 0.5,
    `颈 ${man.crown.neckRadius.toFixed(3)} vs 果身 ${man.surface.radius.toFixed(3)}`);
}

/* ---- 果皮顶点色：底部果身红 -> 顶部果冠深红 ---- */
{
  const bodyGeo = man.parts.body.geometry;
  const cAttr = bodyGeo.getAttribute('color');
  check('果皮网格带顶点色（果身/果冠颈同网格区分颜色）', !!cAttr);
  check('果皮材质启用了顶点色', man.parts.body.material.vertexColors === true);
  if (cAttr) {
    const n = bodyGeo.attributes.position.count;
    const topIdx = n - 1;
    const midIdx = Math.floor(n * 0.35);
    const topLum = cAttr.getX(topIdx) + cAttr.getY(topIdx) + cAttr.getZ(topIdx);
    const midLum = cAttr.getX(midIdx) + cAttr.getY(midIdx) + cAttr.getZ(midIdx);
    check('顶部（果冠颈）顶点色暗于中段果身', topLum < midLum * 0.95,
      `顶部亮度和 ${topLum.toFixed(3)} vs 中段 ${midLum.toFixed(3)}`);
  }
}

/* ---- 腮红：必须左右等高，且都真的露出体表 ---- */
{
  const blushes = [];
  man.group.traverse((o) => { if (o.userData && o.userData.kind === 'blush') blushes.push(o); });
  check('有左右两块腮红', blushes.length === 2, `实际 ${blushes.length}`);
  if (blushes.length === 2) {
    const [b0, b1] = blushes;
    const dy = Math.abs(b0.userData.surfacePoint.y - b1.userData.surfacePoint.y);
    check('左右腮红在体表上等高（差值 < 1e-4）', dy < 1e-4, `差 ${dy}`);
    for (const [i, b] of blushes.entries()) {
      const sunk = b.userData.surfacePoint.clone().sub(b.position).dot(b.userData.normal);
      const halfThick = b.userData.radius * b.scale.z;
      const protrusion = halfThick - sunk;
      check(`腮红 ${i + 1} 确实露出体表（露出 ${protrusion.toFixed(4)}）`, protrusion > 0.008);
    }
  }
}

/* ---- 果冠摆动：必须跟身体一起动，不能是死的 ---- */
{
  const crown = man.parts.crownGroup;
  man.update(0.0, 0, 1 / 60);
  const r0 = crown.rotation.z, x0 = crown.rotation.x;
  man.update(1.0, 0, 1 / 60);
  const r1 = crown.rotation.z, x1 = crown.rotation.x;
  check('果冠会随时间摆动', Math.abs(r1 - r0) > 1e-4 || Math.abs(x1 - x0) > 1e-4,
    `z ${r0.toFixed(5)} -> ${r1.toFixed(5)}`);
  man.update(1.0, 4, 1 / 60);
  const r2 = crown.rotation.z;
  check('被点中（wobbleGain）时果冠摆动幅度同向放大', Math.abs(r2) > Math.abs(r1) + 1e-4,
    `|${r2.toFixed(5)}| > |${r1.toFixed(5)}|`);
}

/* ---- 腿的位置与长度：真实缺陷回归 ----
   第一版腿挂在 t=0.20（果身下三分之一，那正是果身还往外鼓的位置），
   且从挂点到鞋底有 0.74 而果身才高 1.2 —— 截图里一眼就能看出
   「大腿从肚子里长出来、还像踩高跷」。这里把两个约束都钉死。 */
{
  man.group.updateMatrixWorld(true);
  const H = man.surface.height;

  for (const [name, key] of [['左腿', 'legL'], ['右腿', 'legR']]) {
    const p = man.parts.legs[key].position;
    check(`${name}挂在果身底部区域（y < 果高 20%）`, p.y < H * 0.20,
      `y=${p.y.toFixed(3)} vs ${(H * 0.20).toFixed(3)}`);
  }

  // 腿长：从挂点到鞋底
  man.parts.legs.legL.children.forEach((c) => c.geometry.computeBoundingBox());
  const shoe = man.parts.legs.legL.children[2];
  const shoeBottomLocal = shoe.geometry.boundingBox.min.y * shoe.scale.y + shoe.position.y;
  const legLength = man.parts.legs.legL.position.y - shoeBottomLocal;
  const totalH = new THREE.Box3().setFromObject(man.group).max.y
    - new THREE.Box3().setFromObject(man.group).min.y;
  check('腿长不超过角色总高的 40%（不是高跷）', legLength < totalH * 0.40,
    `腿长 ${legLength.toFixed(3)} / 总高 ${totalH.toFixed(3)} = ${(legLength / totalH * 100).toFixed(0)}%`);

  // 双腿水平偏移不能叉太开
  const legSpread = Math.abs(man.parts.legs.legL.position.x) + Math.abs(man.parts.legs.legR.position.x);
  check('双腿水平张距不超过果身直径（不叉成蜘蛛）', legSpread < man.surface.radius * 2,
    `张距 ${legSpread.toFixed(3)} vs 直径 ${(man.surface.radius * 2).toFixed(3)}`);
}

check('身体包围盒正常（高度 1.4~2.2，含果冠）', (() => {
  const b = new THREE.Box3().setFromObject(man.group);
  const h = b.max.y - b.min.y;
  return h > 1.4 && h < 2.2;
})(), (() => {
  const b = new THREE.Box3().setFromObject(man.group);
  return (b.max.y - b.min.y).toFixed(3);
})());

/* ================= 动画与着色器注入 ================= */
console.log('\n[动画与着色器注入]');
err = null;
try { for (let i = 0; i < 60; i++) man.update(i / 60, 1.5, 1 / 60); } catch (e) { err = e; }
check('update 连续调用 60 帧无异常（含 wobbleGain）', !err, err && err.message);

err = null;
const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>' };
try { man.parts.body.material.onBeforeCompile(shader); } catch (e) { err = e; }
check('onBeforeCompile 可执行无异常', !err, err && err.message);
check('注入后声明了 uTime / uWobble',
  shader.vertexShader.includes('uniform float uTime') && shader.vertexShader.includes('uniform float uWobble'));
check('注入后 uniforms 已挂载', !!shader.uniforms.uTime && !!shader.uniforms.uWobble);
check('注入后仍保留 #include <begin_vertex> 锚点', shader.vertexShader.includes('#include <begin_vertex>'));
check('注入后加入了摇摆代码', shader.vertexShader.includes('transformed.x +='));
check('锚点只保留一次（注入没有重复插入）',
  shader.vertexShader.split('#include <begin_vertex>').length === 2);
check('摇摆代码插在锚点之后',
  shader.vertexShader.indexOf('#include <begin_vertex>') < shader.vertexShader.indexOf('transformed.x +='));

shader.uniforms.uWobble.value = 0;
man.update(1.0, 3, 1 / 60);
check('wobbleGain 会抬高 uWobble', shader.uniforms.uWobble.value > 1,
  `实际 ${shader.uniforms.uWobble.value}`);
man.update(1.0, 0, 1 / 60);
check('无增益时 uWobble 回落', Math.abs(shader.uniforms.uWobble.value - 1) < 1e-6,
  `实际 ${shader.uniforms.uWobble.value}`);

console.log(`\n结果：${pass} 项通过，${fail} 项失败\n`);
process.exit(fail ? 1 : 0);
