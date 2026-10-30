// 储能变电站 · three.js WebGPURenderer + TSL
// ------------------------------------------------------------
import * as THREE from 'three/webgpu';
import {
  color, float, mix, smoothstep, pow, max, dot,
  positionLocal, positionWorld, normalWorld, texture, vec2, vec3, uniform,
  mx_noise_float
} from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

const $ = (id) => document.getElementById(id);
const SITE = { radius: 60 };

// ---------- 渲染器 ----------
let renderer;
try {
  renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
  await renderer.init();
} catch (e) {
  $('err').style.display = 'block';
  $('err').textContent = '初始化失败：' + e.message;
  throw e;
}
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.AgXToneMapping;         // 与 Blender 一致：AgX
renderer.toneMappingExposure = Math.pow(2, -0.28);   // Blender view exposure -0.28
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const isWebGPU = renderer.backend?.isWebGPUBackend === true;
$('backend').textContent = isWebGPU ? 'WebGPU' : 'WebGL2';
document.body.appendChild(renderer.domElement);

// ---------- 场景 / 相机 ----------
const scene = new THREE.Scene();
scene.fog = null;   // Blender 场景没有雾，保持一致（HUD 里仍可手动开）

const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.5, 6000);
camera.position.set(120, 70, 150);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.maxPolarAngle = Math.PI * 0.495;
controls.minDistance = 6;
controls.maxDistance = 900;

// ---------- 世界光：与 Blender 完全一致的 HDRI 环境（qwantani 2K × 暖色 1.0/0.965/0.905） ----------
const pmrem = new THREE.PMREMGenerator(renderer);
const HDRI_TINT = [1.02, 0.985, 0.885];   // 环境偏暖，柔和的同时白面不泛蓝

// 半浮点 HDR 数据上做乘法，等价 Blender 里 world 的 Mix(Multiply) 节点
function tintHDR(tex, mul) {
  const data = tex.image?.data;
  if (!data) return;
  const { fromHalfFloat, toHalfFloat } = THREE.DataUtils;
  for (let i = 0; i < data.length; i += 4) {
    data[i]     = toHalfFloat(fromHalfFloat(data[i])     * mul[0]);
    data[i + 1] = toHalfFloat(fromHalfFloat(data[i + 1]) * mul[1]);
    data[i + 2] = toHalfFloat(fromHalfFloat(data[i + 2]) * mul[2]);
  }
  tex.needsUpdate = true;
}

// 把 HDR 做盒式降采样，用作“柔光版”环境（反射不再有刺眼的高光点）
function blurHDR(tex, factor = 8) {
  const img = tex.image, w = img.width, h = img.height;
  const src = img.data;
  const bw = Math.floor(w / factor), bh = Math.floor(h / factor);
  const out = new Uint16Array(bw * bh * 4);
  const { fromHalfFloat, toHalfFloat } = THREE.DataUtils;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let j = 0; j < factor; j++) {
        for (let i = 0; i < factor; i++) {
          const k = (((y * factor + j) * w) + (x * factor + i)) * 4;
          r += fromHalfFloat(src[k]); g += fromHalfFloat(src[k + 1]);
          b += fromHalfFloat(src[k + 2]); a += fromHalfFloat(src[k + 3]); n++;
        }
      }
      const o = (y * bw + x) * 4;
      out[o] = toHalfFloat(r / n); out[o + 1] = toHalfFloat(g / n);
      out[o + 2] = toHalfFloat(b / n); out[o + 3] = toHalfFloat(a / n);
    }
  }
  const blur = new THREE.DataTexture(out, bw, bh, THREE.RGBAFormat, THREE.HalfFloatType);
  blur.mapping = THREE.EquirectangularReflectionMapping;
  blur.needsUpdate = true;
  return blur;
}

new HDRLoader().load('./assets/qwantani_2k.hdr', (tex) => {
  tintHDR(tex, HDRI_TINT);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  scene.background = tex;              // Blender 里 world 的 HDRI 就是背景
  // 天空不额外旋转：保持原始 HDRI 构图（太阳光晕在画外/柔和，不必强行对齐）
  scene.backgroundRotation = new THREE.Euler(0, 0, 0);
  scene.environmentRotation = new THREE.Euler(0, 0, 0);
  scene.backgroundIntensity = 1.0;
  scene.environment = pmrem.fromEquirectangular(blurHDR(tex, 8)).texture;   // 柔和版 IBL
  scene.environmentIntensity = 1.10;   // 环境光 +10%（其余柔和度由暖色漫射与软阴影提供）
  console.log('HDRI 已应用: qwantani_2k.hdr', tex.image?.width + 'x' + tex.image?.height);
}, undefined, (err) => console.warn('HDRI 加载失败:', err?.message || err));

// ---------- 灯光：按 Blender 场景 1:1 复刻 ----------
// 主光_太阳：SUN energy 3.4，color (1.0, 0.915, 0.815)，rot (35.5°, 0, -43°) → 仰角 54.5°
// 太阳从大门口（站区正南，z≈+20.6）方向照进来
const SUN_AZIMUTH = THREE.MathUtils.degToRad(86);
const SUN_DIR = new THREE.Vector3(
  Math.cos(THREE.MathUtils.degToRad(54.5)) * Math.cos(SUN_AZIMUTH),
  Math.sin(THREE.MathUtils.degToRad(54.5)),
  Math.cos(THREE.MathUtils.degToRad(54.5)) * Math.sin(SUN_AZIMUTH)
).normalize();
const SUN_ELEVATION = THREE.MathUtils.radToDeg(Math.asin(SUN_DIR.y));   // ≈ 54.5

const SUN_INTENSITY = 3.4 * 0.72;   // 太阳降 28%（配合软阴影 ≈ 柔和度 +40%）
const sun = new THREE.DirectionalLight(0xffe9d0, SUN_INTENSITY);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.045;
sun.shadow.radius = 8;           // 柔和阴影边缘（更软的半影）
sun.shadow.blurSamples = 12;
{
  const c = sun.shadow.camera;
  c.left = -80; c.right = 80; c.top = 80; c.bottom = -80; c.near = 1; c.far = 420;
  c.updateProjectionMatrix();
}
scene.add(sun);
scene.add(sun.target);

// 辅光_天光（AREA 60W / size 60）与 轮廓光（AREA 800W / size 25）用平行光近似
// 暖色漫射补光：让背光面不发灰蓝，同时保持柔和
const ambient = new THREE.AmbientLight(0xffeddc, 0.30);
scene.add(ambient);

const fill = new THREE.DirectionalLight(0xfff6ea, 0.45);
fill.position.set(-0.413, 0.766, -0.492).normalize().multiplyScalar(120);
fill.target.position.set(-4.5, 0, 0);
scene.add(fill); scene.add(fill.target);

const rim = new THREE.DirectionalLight(0xe1f0ff, 0.72);
rim.position.set(0.485, 0.291, -0.825).normalize().multiplyScalar(120);
rim.target.position.set(-4.5, 0, 0);
scene.add(rim); scene.add(rim.target);

const sunDir = new THREE.Vector3().copy(SUN_DIR);
let nightMode = false;

function setSunElevation(deg) {
  const el = THREE.MathUtils.degToRad(deg);
  sunDir.set(Math.cos(el) * Math.cos(SUN_AZIMUTH), Math.sin(el), Math.cos(el) * Math.sin(SUN_AZIMUTH)).normalize();
  sun.position.copy(sunDir).multiplyScalar(240);
  sun.target.position.set(-4.5, 0, 0);
  sun.target.updateMatrixWorld();
  // 强度由 applyNight() 统一插值，这里只改方向
}
setSunElevation(SUN_ELEVATION);

// ---------- TSL 材质：三向投影（triplanar）采样原贴图 ----------
// Blender 里箱体材质用的是 Object 坐标 + BOX 投影，这种采样方式 glTF 表达不了，
// 导出后 UV 与贴图没有对应关系。这里在 shader 里自己做三向投影，
// 用世界坐标沿 X/Y/Z 三个平面分别采样同一张贴图，再按法线权重混合。
function triplanar(tex, worldScale) {
  const p = positionWorld;
  const n = normalWorld.normalize();
  const w = n.abs().pow(3).toVar();          // 三个方向权重（立方锐化，接缝更干净）
  const s = float(worldScale);
  const cx = texture(tex, p.zy.mul(s));
  const cy = texture(tex, p.xz.mul(s));
  const cz = texture(tex, p.xy.mul(s));
  const sum = w.x.add(w.y).add(w.z).max(0.0001);
  return cx.rgb.mul(w.x).add(cy.rgb.mul(w.y)).add(cz.rgb.mul(w.z)).div(sum);
}

// baseHex：漆面基色；grimeHex：污渍色；map：GLB 里的 baseColor 贴图（可能为 null）
function paintedSteel({ baseHex, grimeHex, map, tile = 2.4, metalness = 0.02, roughA = 0.36, roughB = 0.70, dirt = 0.55 }) {
  const m = new THREE.MeshStandardNodeMaterial({ metalness, roughness: roughA });

  // 底色：有贴图就三向投影采样，没有就退回纯色
  let base = color(baseHex);
  if (map) {
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.anisotropy = Math.min(16, renderer.getMaxAnisotropy?.() ?? 16);
    // 贴图偏冷偏暗：提亮 + 与白漆基色混合，避免整箱发蓝发花
    const tex = triplanar(map, 1 / tile).mul(color(1.18, 1.15, 1.10));
    base = mix(color(baseHex), tex.mul(color(baseHex).mul(2.15)), float(0.68));
  }

  // 竖向脏污：地面附近更脏
  const grime = smoothstep(0.10, 2.4, positionWorld.y).oneMinus();
  // 大尺度斑驳（米级）+ 小尺度漆面颗粒
  const blotch = mx_noise_float(positionWorld.mul(0.42)).mul(0.5).add(0.5);

  const dirtMask = grime.mul(0.72).add(blotch.mul(0.30)).mul(dirt).min(1.0);
  m.colorNode = mix(base, color(grimeHex), dirtMask);
  m.roughnessNode = mix(float(roughA), float(roughB), dirtMask);
  return m;
}

// 纯色做旧（给没有贴图的深色件用）
function weatheredPaint(baseHex, grimeHex, metalness, roughA, roughB, dirtStrength) {
  const m = new THREE.MeshStandardNodeMaterial({ metalness, roughness: roughA });
  const grime = smoothstep(0.10, 2.2, positionWorld.y).oneMinus();
  const blotch = mx_noise_float(positionWorld.mul(0.42)).mul(0.5).add(0.5);
  const dirtMask = grime.mul(0.7).add(blotch.mul(0.3)).mul(dirtStrength).min(1.0);
  m.colorNode = mix(color(baseHex), color(grimeHex), dirtMask);
  m.roughnessNode = mix(float(roughA), float(roughB), dirtMask);
  return m;
}

// ---------- 载入 GLB ----------
const loader = new GLTFLoader();
const draco = new DRACOLoader();
draco.setDecoderPath('./vendor/three/libs/draco/');
loader.setDRACOLoader(draco);
const bar = document.querySelector('#bar i');
const pct = $('pct');
const loaderEl = $('loader');
const slowTimer = setTimeout(() => {
  if (!window.__ready) loaderEl.style.display = 'flex';
}, 400);

const gltf = await new Promise((resolve, reject) => {
  loader.load('./model/ess-substation.glb?v=7', resolve, (ev) => {
    if (ev.total) {
      const p = Math.min(100, Math.round(ev.loaded / ev.total * 100));
      bar.style.width = p + '%';
      pct.textContent = p + '%';
    } else {
      pct.textContent = (ev.loaded / 1048576).toFixed(1) + ' MB';
    }
  }, reject);
});

const model = gltf.scene;
scene.add(model);

// 材质替换 / 参数修正
const matCache = new Map();
model.traverse((o) => {
  if (!o.isMesh) return;
  o.castShadow = true;
  o.receiveShadow = true;
  o.frustumCulled = false;

  const apply = (mat) => {
    if (!mat) return mat;
    if (matCache.has(mat.name)) return matCache.get(mat.name);
    let out = mat;
    switch (mat.name) {
      // 新模型已在 Blender 侧用真实 UV + 扫描 PBR 贴图，直接使用 glTF 材质
      case '草坪_贴图': {
        if (mat.map) {
          mat.map.anisotropy = Math.min(16, renderer.getMaxAnisotropy?.() ?? 16);
          mat.map.colorSpace = THREE.SRGBColorSpace;
          mat.map.wrapS = mat.map.wrapT = THREE.RepeatWrapping;
        }
        // Blender 里草地有 Hue/Sat 节点（色相 +0.085、饱和 1.18），glTF 导不出来，这里用颜色乘算等效
        mat.color = new THREE.Color(0.68, 1.30, 0.33);
        mat.roughness = 0.96;
        mat.metalness = 0.0;
        out = mat;
        break;
      }
      default: {
        if (mat.map) {
          mat.map.colorSpace = THREE.SRGBColorSpace;
          mat.map.anisotropy = Math.min(16, renderer.getMaxAnisotropy?.() ?? 16);
        }
        const n = mat.name || '';
        if (/sapling|twig|branch/i.test(n)) {
          mat.alphaTest = 0.42;
          mat.transparent = false;
          mat.side = THREE.DoubleSide;
          mat.depthWrite = true;
          mat.metalness = 0.0;
          if (/twig|branch/i.test(n)) mat.roughness = 0.85;
          else mat.roughness = 0.72;
        }
        out = mat;
      }
    }
    matCache.set(mat.name, out);
    return out;
  };

  o.material = Array.isArray(o.material) ? o.material.map(apply) : apply(o.material);

  // 草坪大地不投影（省 shadow 开销）
  if (o.name.includes('草坪')) o.castShadow = false;
});

// ---------- 取景 ----------
const siteRef = model.getObjectByName('储能单元_R2C2');
const center = new THREE.Vector3();
if (siteRef) siteRef.getWorldPosition(center);
if (center.lengthSq() < 1e-6) {
  const b = new THREE.Box3().setFromObject(model);
  b.getCenter(center);
}
center.y = 0;

const VIEWS = {
  pano:   { pos: [center.x + 27, 9.5, center.z + 40], tgt: [center.x - 1, 6, center.z - 1], fov: 44 },
  aerial: { pos: [center.x + 34, 74, center.z + 46], tgt: [center.x, 0, center.z], fov: 40 },
  close:  { pos: [center.x - 17, 2.3, center.z + 17], tgt: [center.x + 8, 2.6, center.z - 2], fov: 40 },
  detail: { pos: [center.x - 0.75, 1.85, center.z + 5.8], tgt: [center.x - 1.55, 1.45, center.z + 1.30], fov: 34 }
};

let camAnim = null;
function goView(name) {
  const v = VIEWS[name];
  if (!v) return;
  document.querySelectorAll('#views button').forEach(b =>
    b.classList.toggle('active', b.dataset.view === name));
  camAnim = {
    t: 0,
    fromPos: camera.position.clone(), toPos: new THREE.Vector3(...v.pos),
    fromTgt: controls.target.clone(), toTgt: new THREE.Vector3(...v.tgt),
    fromFov: camera.fov, toFov: v.fov
  };
}
document.querySelectorAll('#views button[data-view]').forEach(b =>
  b.addEventListener('click', () => goView(b.dataset.view)));

controls.target.set(...VIEWS.pano.tgt);
camera.position.set(...VIEWS.pano.pos);
camera.fov = VIEWS.pano.fov;
camera.updateProjectionMatrix();

// ---------- 大门开闭 + 进站运镜 ----------
const gateL = model.getObjectByName('大门_左扇');
const gateR = model.getObjectByName('大门_右扇');
const gateL0 = gateL ? gateL.position.clone() : null;
const gateR0 = gateR ? gateR.position.clone() : null;
const GATE_SLIDE = 4.65;                 // 每扇横向滑开距离（m）
console.log('大门节点:', gateL?.name, gateR?.name);

// 由马路 → 门洞 → 站内通道的相机路径（世界坐标）
// 车位布局：列 x = -13.6 / -4.5 / 4.5 / 13.6，列间通道 x ≈ -9 / 0 / 9
// 行 z = 11 / 0 / -11，行间通道 z ≈ 5.5 / -5.5；大门 z ≈ 20.6
const ENTER_POS = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-3.0, 3.4, 34.5),
  new THREE.Vector3(-3.0, 2.9, 28.0),
  new THREE.Vector3(-3.0, 2.5, 22.0),
  new THREE.Vector3(-4.8, 2.4, 17.6),
  new THREE.Vector3(-8.5, 2.3, 13.6),
  new THREE.Vector3(-9.0, 2.3, 8.0),
  new THREE.Vector3(-8.7, 2.35, 2.0)
], false, 'catmullrom', 0.25);
const ENTER_TGT = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-3.0, 1.9, 20.6),
  new THREE.Vector3(-3.0, 1.9, 18.0),
  new THREE.Vector3(-5.0, 1.8, 12.0),
  new THREE.Vector3(-8.2, 1.8, 9.0),
  new THREE.Vector3(-9.0, 1.8, 3.0),
  new THREE.Vector3(-8.8, 1.8, -3.0),
  new THREE.Vector3(-8.7, 1.8, -9.0)
], false, 'catmullrom', 0.25);

const T_OPEN = [0.5, 2.4];     // 开门
const T_MOVE = [0.9, 8.2];     // 相机推进
const T_CLOSE = [8.8, 10.2];   // 关门
const T_END = 10.4;
let enterAnim = null;

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoother = (v) => { v = clamp01(v); return v * v * v * (v * (v * 6 - 15) + 10); };
const seg = (t, a, b) => smoother((t - a) / (b - a));

function playEnter() {
  camAnim = null;
  controls.autoRotate = false;
  const rb = $('rotate'); if (rb) rb.classList.remove('on');
  state.rotate = false;
  controls.enabled = false;
  enterAnim = { t: 0 };
}

function updateEnter(dt) {
  if (!enterAnim) return;
  enterAnim.t += dt;
  const t = enterAnim.t;

  // 门扇横向开 / 关
  const go = seg(t, T_OPEN[0], T_OPEN[1]) - seg(t, T_CLOSE[0], T_CLOSE[1]);
  if (gateL) gateL.position.x = gateL0.x - GATE_SLIDE * go;
  if (gateR) gateR.position.x = gateR0.x + GATE_SLIDE * go;

  // 相机路径
  const p = clamp01((t - T_MOVE[0]) / (T_MOVE[1] - T_MOVE[0]));
  const e = smoother(p);
  camera.position.copy(ENTER_POS.getPoint(e));
  controls.target.copy(ENTER_TGT.getPoint(e));
  camera.lookAt(controls.target);

  if (t >= T_END) {
    enterAnim = null;
    controls.enabled = true;
    controls.update();
  }
}
document.getElementById('enter')?.addEventListener('click', playEnter);

document.getElementById('nightBtn')?.addEventListener('click', () => {
  const on = !state.night;
  state.night = on;
  document.getElementById('night')?.classList.toggle('on', on);
  setNight(on);
});
window.__playEnter = playEnter;
// ---------- UI ----------
$('expo').addEventListener('input', (e) => {
  renderer.toneMappingExposure = +e.target.value;
  $('expoVal').textContent = (+e.target.value).toFixed(2);
});
$('sun').addEventListener('input', (e) => {
  setSunElevation(+e.target.value);
  $('sunVal').textContent = e.target.value + '°';
});

// 风机叶轮：每台一个独立节点，绕自身 +Z 轴（= 箱体侧壁法线）自转
const fanBlades = [];
model.traverse(o => { if (o.name && o.name.startsWith('风叶_')) fanBlades.push(o); });
const FAN_RPS = 0.55;                       // 转/秒
const fanSpeed = FAN_RPS * Math.PI * 2;     // rad/s
fanBlades.forEach((b, i) => { b.userData.phase = (i % 3) * 0.7; });
console.log('风机叶轮节点:', fanBlades.length);

// ---------- 夜景：路灯点光 + 灯罩自发光 ----------
const LAMP_MAX_INTENSITY = 330;   // 白天 0 → 夜间 330（比原来 900 柔和很多）
const lampLights = [];
model.traverse((o) => {
  if (!/路灯_.*_灯头/.test(o.name)) return;
  const p = new THREE.Vector3();
  o.getWorldPosition(p);
  const sp = new THREE.SpotLight(0xffd6a0, 0, 48, Math.PI / 2.35, 0.92, 1.4);   // 更宽更软的光锥
  sp.position.set(p.x, p.y - 0.18, p.z);
  sp.target.position.set(p.x, 0, p.z);
  sp.castShadow = false;
  scene.add(sp.target);
  scene.add(sp);
  lampLights.push(sp);
});
console.log('路灯点光源:', lampLights.length);

const lampShadeMats = [];
model.traverse((o) => {
  if (o.isMesh && o.material && o.material.name === '灯罩_暖白' && !lampShadeMats.includes(o.material)) {
    lampShadeMats.push(o.material);
    o.material.emissive = new THREE.Color(0xffd39a);
    o.material.emissiveIntensity = 1.2;
  }
});

let nightTarget = 0;
let nightT = 0;

function setNight(on) {
  nightTarget = on ? 1 : 0;
  document.body.classList.toggle('night', on);
  const btn = document.getElementById('nightBtn');
  if (btn) btn.textContent = on ? '☀ 日出' : '🌙 入夜';
}

// 按插值系数 t（0 白天 → 1 夜晚）统一施加光照；过渡由 damp 驱动，约 2.5 s 完成
function applyNight(t) {
  sun.intensity = THREE.MathUtils.lerp(SUN_INTENSITY, 0.02, t);
  ambient.intensity = THREE.MathUtils.lerp(0.30, 0.13, t);      // 夜间保留漫射，暗处不发死黑
  fill.intensity = THREE.MathUtils.lerp(0.45, 0.05, t);
  rim.intensity = THREE.MathUtils.lerp(0.72, 0.06, t);
  scene.environmentIntensity = THREE.MathUtils.lerp(1.10, 0.11, t);
  scene.backgroundIntensity = THREE.MathUtils.lerp(1.0, 0.10, t);
  for (const l of lampLights) l.intensity = LAMP_MAX_INTENSITY * t;
  for (const m of lampShadeMats) m.emissiveIntensity = THREE.MathUtils.lerp(1.2, 6.0, t);
}
applyNight(0);

const state = { rotate: false, shadow: true, fog: false, fan: true, night: false };
const sw = (id, key, fn) => {
  const el = $(id);
  el.addEventListener('click', () => {
    state[key] = !state[key];
    el.classList.toggle('on', state[key]);
    fn(state[key]);
  });
};
sw('rotate', 'rotate', v => { controls.autoRotate = v; controls.autoRotateSpeed = 0.55; });
sw('shadow', 'shadow', v => { renderer.shadowMap.enabled = v; sun.castShadow = v; });
sw('fog', 'fog', v => { scene.fog = v ? new THREE.Fog(0xd3e0ee, 900, 2600) : null; });   // 需要雾时可手开
sw('fan', 'fan', v => { state.fan = v; });
sw('night', 'night', v => setNight(v));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- 统计 ----------
let frames = 0, last = performance.now(), tris = 0;
model.traverse(o => {
  if (o.isMesh && o.geometry?.index) tris += o.geometry.index.count / 3;
  else if (o.isMesh && o.geometry?.attributes?.position) tris += o.geometry.attributes.position.count / 3;
});
$('tris').textContent = (tris / 1000).toFixed(0) + 'k';

// ---------- 主循环 ----------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();

  if (camAnim) {
    camAnim.t = Math.min(1, camAnim.t + dt * 1.6);
    const e = 1 - Math.pow(1 - camAnim.t, 3);
    camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
    controls.target.lerpVectors(camAnim.fromTgt, camAnim.toTgt, e);
    camera.fov = THREE.MathUtils.lerp(camAnim.fromFov, camAnim.toFov, e);
    camera.updateProjectionMatrix();
    if (camAnim.t >= 1) camAnim = null;
  }

  if (Math.abs(nightT - nightTarget) > 0.0005) {
    nightT = THREE.MathUtils.damp(nightT, nightTarget, 1.25, dt);
    applyNight(nightT);
  }

  updateEnter(dt);

  if (state.fan && fanBlades.length) {
    const step = fanSpeed * dt;
    for (const b of fanBlades) b.rotateZ(step);
  }

  if (!enterAnim) controls.update();
  renderer.render(scene, camera);

  frames++;
  const now = performance.now();
  if (now - last > 500) {
    $('fps').textContent = Math.round(frames * 1000 / (now - last));
    frames = 0; last = now;
  }
});

// 加载完成
clearTimeout(slowTimer);
loaderEl.style.display = 'none';
window.__ready = true;
window.__scene = scene;
window.__model = model;
window.__renderer = renderer;
