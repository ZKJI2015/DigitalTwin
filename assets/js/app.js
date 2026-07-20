/* ============================================================
 *  VR 全景数字孪生 · 智慧园区
 *  Three.js r160 + WebXR（VR 头显双目渲染）
 *  - 桌面：鼠标拖拽环视 / 滚轮 FOV 缩放 / 点击 3D 热点 → DOM 弹窗
 *  - VR：转头环视 / 凝视热点 1.2s → 3D 信息面板 / 手柄射线选择
 * ============================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';

/* 状态 */
const state = {
  width: window.innerWidth,
  height: window.innerHeight,
  camera: null,
  scene: null,
  renderer: null,
  controls: null,
  hotspots3D: [],
  hotspotById: new Map(),
  reticle: null,
  reticleProgress: null,
  infoPanelMesh: null,
  infoCanvas: null,
  infoCtx: null,
  infoTexture: null,
  activeHotspot: null,
  gazeTarget: null,
  gazeProgress: 0,
  raycaster: new THREE.Raycaster(),
  pointer: new THREE.Vector2(),
  pointerDown: { x: 0, y: 0 },
  hoverHotspot: null,
  energyChart: null,
  vehicleChart: null,
  popup: { open: false, hotspotId: null },
  prevTime: performance.now()
};

/* 状态颜色 */
const STATUS_HEX = { normal: 0x00f0ff, warn: 0xfbbf24, danger: 0xf87171 };
const STATUS_CSS = { normal: '#00f0ff', warn: '#fbbf24', danger: '#f87171' };
const STATUS_RGBA = { normal: 'rgba(0,240,255,', warn: 'rgba(251,191,36,', danger: 'rgba(248,113,113,' };
const STATUS_LABEL = { normal: '正常', warn: '告警', danger: '异常' };

/* 热点配置 */
const HOTSPOTS = [
  {
    id: 'main-building',
    name: 'A1 主楼',
    lat: 5, lon: -5,
    type: 'energy', icon: '🏢', status: 'normal',
    metrics: [
      { name: '实时功率', value: 286, unit: 'kW', spark: [260, 272, 268, 280, 275, 286, 290, 282] },
      { name: '今日能耗', value: 2840, unit: 'kWh' },
      { name: '楼层温度', value: 23.8, unit: '°C' },
      { name: '入驻率', value: 86, unit: '%' }
    ]
  },
  {
    id: 'parking',
    name: 'P1 停车场',
    lat: -8, lon: 42,
    type: 'vehicle', icon: '🅿️', status: 'warn',
    metrics: [
      { name: '总车位', value: 420, unit: '个' },
      { name: '已占用', value: 389, unit: '个' },
      { name: '剩余车位', value: 31, unit: '个' },
      { name: '今日周转', value: 1523, unit: '辆' }
    ]
  },
  {
    id: 'gate',
    name: '东门门禁',
    lat: 2, lon: -38,
    type: 'security', icon: '🛡️', status: 'danger',
    metrics: [
      { name: '今日通行', value: 2841, unit: '人次' },
      { name: '异常事件', value: 3, unit: '起' },
      { name: '人脸识别', value: 98.4, unit: '%' },
      { name: '平均耗时', value: 1.2, unit: 's' }
    ]
  },
  {
    id: 'solar',
    name: '光伏车棚',
    lat: -4, lon: 88,
    type: 'energy', icon: '☀️', status: 'normal',
    metrics: [
      { name: '实时发电', value: 46.2, unit: 'kW' },
      { name: '今日发电', value: 312, unit: 'kWh' },
      { name: '累计减碳', value: 1.28, unit: '吨' },
      { name: '逆变器状态', value: '正常', unit: '' }
    ]
  },
  {
    id: 'green',
    name: '中央绿化',
    lat: -1, lon: 178,
    type: 'environment', icon: '🌿', status: 'normal',
    metrics: [
      { name: '空气温度', value: 24.2, unit: '°C' },
      { name: '空气湿度', value: 58, unit: '%' },
      { name: 'PM2.5', value: 32, unit: 'μg/m³' },
      { name: '负氧离子', value: 1250, unit: '个/cm³' }
    ]
  },
  {
    id: 'power',
    name: '配电房',
    lat: 8, lon: -92,
    type: 'power', icon: '⚡', status: 'normal',
    metrics: [
      { name: '总负载', value: 68, unit: '%' },
      { name: 'A相电压', value: 220.3, unit: 'V' },
      { name: '频率', value: 50.02, unit: 'Hz' },
      { name: '功率因数', value: 0.96, unit: '' }
    ]
  }
];

/* ===== 初始化入口 ===== */
function init() {
  initClock();
  initThreeJS();
  createHotspots3D();
  createReticle();
  createInfoPanel();
  setupControllers();
  initCharts();
  initSimulation();
  bindEvents();
}

/* ===== 时钟 ===== */
function initClock() {
  const timeEl = document.getElementById('clock-time');
  const dateEl = document.getElementById('clock-date');
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  function tick() {
    const now = new Date();
    timeEl.textContent = now.toLocaleTimeString('zh-CN', { hour12: false });
    dateEl.textContent = `${now.toLocaleDateString('zh-CN')} ${weekdays[now.getDay()]}`;
    requestAnimationFrame(tick);
  }
  tick();
}

/* ===== Three.js + WebXR ===== */
function initThreeJS() {
  const container = document.getElementById('panorama-container');
  state.width = container.clientWidth;
  state.height = container.clientHeight;

  state.scene = new THREE.Scene();
  state.camera = new THREE.PerspectiveCamera(75, state.width / state.height, 0.1, 2000);
  state.camera.position.set(0, 0, 0.1);

  state.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  state.renderer.setSize(state.width, state.height);
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  state.renderer.xr.enabled = true;            // 关键：启用 WebXR
  container.appendChild(state.renderer.domElement);

  // VR 入口按钮
  const vrBtn = VRButton.createButton(state.renderer);
  vrBtn.classList.add('vr-enter-btn');
  document.body.appendChild(vrBtn);

  // 全景球：纹理贴在球体内壁
  const loader = new THREE.TextureLoader();
  loader.load('assets/images/panorama.png', (texture) => {
    texture.colorSpace = THREE.SRGBColorSpace;
    const geo = new THREE.SphereGeometry(500, 64, 64);
    geo.scale(-1, 1, 1);                       // 翻转法线，从内部可见
    const mat = new THREE.MeshBasicMaterial({ map: texture });
    state.scene.add(new THREE.Mesh(geo, mat));
    document.getElementById('loading').classList.add('hidden');
  }, undefined, (err) => {
    console.error('全景图加载失败:', err);
    document.getElementById('loading').innerHTML =
      '<p style="color:#f87171">全景图加载失败，请检查网络或文件路径</p>';
  });

  // 桌面控制器：拖拽环视（原地旋转）
  state.controls = new OrbitControls(state.camera, state.renderer.domElement);
  state.controls.enableZoom = false;
  state.controls.enablePan = false;
  state.controls.rotateSpeed = -0.3;
  state.controls.enableDamping = true;
  state.controls.dampingFactor = 0.05;
  state.controls.autoRotate = true;
  state.controls.autoRotateSpeed = 0.3;
  state.controls.target.set(0, 0, 0);
  state.controls.update();

  // 滚轮 = FOV 缩放（正确的全景缩放方式）
  state.renderer.domElement.addEventListener('wheel', (e) => {
    e.preventDefault();
    state.camera.fov = THREE.MathUtils.clamp(state.camera.fov + e.deltaY * 0.03, 30, 100);
    state.camera.updateProjectionMatrix();
  }, { passive: false });

  // 用 setAnimationLoop 替代 requestAnimationFrame（WebXR 要求）
  state.renderer.setAnimationLoop(animate);

  // XR 会话切换
  state.renderer.xr.addEventListener('sessionstart', () => {
    state.controls.enabled = false;
    closePopup();
    hideInfoPanel();
    document.getElementById('vr-badge').classList.remove('hidden');
    document.body.classList.add('vr-active');
  });
  state.renderer.xr.addEventListener('sessionend', () => {
    state.controls.enabled = true;
    hideInfoPanel();
    document.getElementById('vr-badge').classList.add('hidden');
    document.body.classList.remove('vr-active');
  });
}

/* ===== 渲染循环 ===== */
function animate() {
  const now = performance.now();
  const dt = (now - state.prevTime) / 1000;
  state.prevTime = now;

  const isVR = state.renderer.xr.isPresenting;
  if (!isVR && state.controls) state.controls.update();

  updateHotspots3D();
  if (isVR) updateGaze(dt);
  updateReticle();
  updateInfoPanel();

  state.renderer.render(state.scene, state.camera);
}

/* ===== 球坐标 → 笛卡尔 ===== */
function sphericalToCartesian(r, lat, lon) {
  const phi = THREE.MathUtils.degToRad(90 - lat);
  const theta = THREE.MathUtils.degToRad(lon);
  return new THREE.Vector3(
    r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  );
}

/* ===== 3D 热点：发光球 + 双脉冲环 ===== */
function createHotspots3D() {
  HOTSPOTS.forEach(h => {
    const group = new THREE.Group();
    group.position.copy(sphericalToCartesian(400, h.lat, h.lon));
    const color = STATUS_HEX[h.status] || 0x00f0ff;

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(3, 16, 16),
      new THREE.MeshBasicMaterial({ color })
    );
    group.add(dot);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(4.5, 7, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
    );
    group.add(ring);

    const ring2 = new THREE.Mesh(
      new THREE.RingGeometry(8, 9, 32),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, side: THREE.DoubleSide })
    );
    group.add(ring2);

    group.lookAt(0, 0, 0);
    group.userData.hotspot = h;
    group.userData.ring = ring;
    group.userData.ring2 = ring2;
    group.userData.color = color;
    state.scene.add(group);
    state.hotspots3D.push(group);
    state.hotspotById.set(h.id, { group, config: h });
  });
}

function updateHotspots3D() {
  const t = performance.now() * 0.001;
  const camPos = state.camera.position;
  state.hotspots3D.forEach((group, i) => {
    const pulse = (Math.sin(t * 2 + i) + 1) * 0.5;
    const ring = group.userData.ring;
    const ring2 = group.userData.ring2;
    const s1 = 1 + pulse * 0.6;
    ring.scale.set(s1, s1, s1);
    ring.material.opacity = 0.6 - pulse * 0.4;
    const s2 = 1 + pulse * 1.1;
    ring2.scale.set(s2, s2, s2);
    ring2.material.opacity = 0.3 - pulse * 0.25;
    group.lookAt(camPos);    // 始终面向相机
  });
}

/* ===== 凝视准星 ===== */
function createReticle() {
  const group = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.55, 0.7, 32),
    new THREE.MeshBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false })
  );
  ring.renderOrder = 999;
  group.add(ring);
  const prog = new THREE.Mesh(
    new THREE.RingGeometry(0.3, 0.5, 32),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: false })
  );
  prog.renderOrder = 999;
  group.add(prog);
  state.reticle = group;
  state.reticleProgress = prog;
  group.visible = false;
  state.scene.add(group);
}

function updateReticle() {
  const isVR = state.renderer.xr.isPresenting;
  state.reticle.visible = isVR;
  if (!isVR) return;
  const cam = state.renderer.xr.getCamera();
  const pos = cam.getWorldPosition(new THREE.Vector3());
  const dir = cam.getWorldDirection(new THREE.Vector3());
  state.reticle.position.copy(pos).add(dir.multiplyScalar(-3));
  state.reticle.lookAt(pos);
  const p = Math.min(1, state.gazeProgress / 1.2);
  const sc = 0.4 + (1 - p) * 0.6;
  state.reticleProgress.scale.set(sc, sc, sc);
  state.reticleProgress.material.opacity = 0.4 + p * 0.6;
  state.reticleProgress.material.color.setHex(p > 0.99 ? 0x00ff88 : 0xffffff);
}

/* ===== 凝视检测（VR 头显无手柄时） ===== */
function updateGaze(dt) {
  const cam = state.renderer.xr.getCamera();
  const origin = cam.getWorldPosition(new THREE.Vector3());
  const dir = cam.getWorldDirection(new THREE.Vector3());
  state.raycaster.set(origin, dir);
  state.raycaster.far = 1000;
  const hits = state.raycaster.intersectObjects(state.hotspots3D, true);

  let target = null;
  if (hits.length) {
    let obj = hits[0].object;
    while (obj && !obj.userData.hotspot) obj = obj.parent;
    if (obj && obj.userData.hotspot) target = obj.userData.hotspot;
  }

  if (target) {
    if (state.gazeTarget !== target) {
      state.gazeTarget = target;
      state.gazeProgress = 0;
    } else {
      state.gazeProgress += dt;
    }
    if (state.gazeProgress >= 1.2) {
      selectHotspotVR(target);
      state.gazeProgress = 0;
      state.gazeTarget = null;
    }
  } else {
    state.gazeTarget = null;
    state.gazeProgress = Math.max(0, state.gazeProgress - dt * 2);
  }
}

/* ===== 3D 信息面板（CanvasTexture） ===== */
function createInfoPanel() {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 420;
  state.infoCanvas = canvas;
  state.infoCtx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  state.infoTexture = texture;
  const mat = new THREE.MeshBasicMaterial({
    map: texture, transparent: true, opacity: 0, side: THREE.DoubleSide, depthTest: false
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(70, 46), mat);
  mesh.renderOrder = 500;
  mesh.visible = false;
  state.scene.add(mesh);
  state.infoPanelMesh = mesh;
}

function showInfoPanel(hotspot) {
  drawInfoCanvas(state.infoCtx, hotspot);
  state.infoTexture.needsUpdate = true;

  const hp = state.hotspotById.get(hotspot.id);
  const hpPos = hp.group.position.clone();
  const cam = state.renderer.xr.getCamera();
  const camPos = cam.getWorldPosition(new THREE.Vector3());
  // 放在热点与相机之间、偏向相机
  const dir = camPos.clone().sub(hpPos).normalize();
  const panelPos = hpPos.clone().add(dir.multiplyScalar(90));
  state.infoPanelMesh.position.copy(panelPos);
  state.infoPanelMesh.lookAt(camPos);
  state.infoPanelMesh.visible = true;
  state.infoPanelMesh.material.opacity = 0;
  state.activeHotspot = hotspot;
}

function hideInfoPanel() {
  if (state.infoPanelMesh) state.infoPanelMesh.visible = false;
  state.activeHotspot = null;
}

function updateInfoPanel() {
  const m = state.infoPanelMesh;
  if (!m || !m.visible) return;
  if (m.material.opacity < 0.96) m.material.opacity = Math.min(0.96, m.material.opacity + 0.06);
  const cam = state.renderer.xr.isPresenting
    ? state.renderer.xr.getCamera()
    : state.camera;
  const camPos = cam.getWorldPosition ? cam.getWorldPosition(new THREE.Vector3()) : cam.position;
  m.lookAt(camPos);
}

/* VR 选中热点：再凝视一次关闭 */
function selectHotspotVR(hotspot) {
  if (state.activeHotspot && state.activeHotspot.id === hotspot.id) {
    hideInfoPanel();
  } else {
    showInfoPanel(hotspot);
  }
}

/* ===== Canvas 绘制信息面板 ===== */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawInfoCanvas(ctx, h) {
  const W = 640, H = 420;
  ctx.clearRect(0, 0, W, H);

  ctx.fillStyle = 'rgba(8, 18, 36, 0.95)';
  roundRect(ctx, 0, 0, W, H, 18); ctx.fill();

  const col = STATUS_CSS[h.status];
  ctx.strokeStyle = col; ctx.lineWidth = 3;
  roundRect(ctx, 2, 2, W - 4, H - 4, 16); ctx.stroke();

  ctx.fillStyle = col;
  ctx.fillRect(0, 0, 8, H);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 30px "Microsoft YaHei","PingFang SC",sans-serif';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(h.icon + '  ' + h.name, 30, 52);

  const stLabel = STATUS_LABEL[h.status];
  ctx.font = 'bold 18px "Microsoft YaHei",sans-serif';
  const tw = ctx.measureText(stLabel).width;
  const px = W - tw - 50, py = 30, pw = tw + 30, ph = 30;
  ctx.fillStyle = STATUS_RGBA[h.status] + '0.25)';
  roundRect(ctx, px, py, pw, ph, 15); ctx.fill();
  ctx.fillStyle = col;
  ctx.fillText(stLabel, px + 15, py + 21);

  ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(24, 78); ctx.lineTo(W - 24, 78); ctx.stroke();

  h.metrics.forEach((m, i) => {
    const y = 118 + i * 58;
    ctx.fillStyle = '#94a3b8';
    ctx.font = '20px "Microsoft YaHei",sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(m.name, 30, y);
    ctx.fillStyle = '#00f0ff';
    ctx.font = 'bold 26px "Microsoft YaHei",sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(m.value + (m.unit ? ' ' + m.unit : ''), W - 30, y);
  });
  ctx.textAlign = 'left';

  if (h.metrics[0] && h.metrics[0].spark) {
    drawSparklineCanvas(ctx, h.metrics[0].spark, 30, 350, W - 60, 50, col);
  }
}

function drawSparklineCanvas(ctx, data, x, y, w, h, color) {
  const max = Math.max.apply(null, data);
  const min = Math.min.apply(null, data);
  const range = max - min || 1;
  ctx.beginPath();
  data.forEach((v, i) => {
    const px = x + (i / (data.length - 1)) * w;
    const py = y + h - ((v - min) / range) * h;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.stroke();
  ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
  ctx.globalAlpha = 0.2; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
}

/* ===== XR 手柄射线 ===== */
function setupControllers() {
  for (let i = 0; i < 2; i++) {
    const ctrl = state.renderer.xr.getController(i);
    ctrl.addEventListener('selectstart', onControllerSelect);
    // 射线辅助线
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -50)]),
      new THREE.LineBasicMaterial({ color: 0x00f0ff, transparent: true, opacity: 0.5 })
    );
    ctrl.add(line);
    state.scene.add(ctrl);
  }
}

function onControllerSelect(e) {
  const ctrl = e.target;
  const origin = ctrl.getWorldPosition(new THREE.Vector3());
  const dir = new THREE.Vector3();
  ctrl.getWorldDirection(dir);
  state.raycaster.set(origin, dir);
  state.raycaster.far = 1000;
  const hits = state.raycaster.intersectObjects(state.hotspots3D, true);
  if (hits.length) {
    let obj = hits[0].object;
    while (obj && !obj.userData.hotspot) obj = obj.parent;
    if (obj && obj.userData.hotspot) selectHotspotVR(obj.userData.hotspot);
  } else if (state.activeHotspot) {
    hideInfoPanel();
  }
}

/* ===== 桌面 DOM 弹窗 ===== */
function openPopup(hotspot) {
  const popup = document.getElementById('popup');
  const title = document.getElementById('popup-title');
  const icon = document.getElementById('popup-icon');
  const body = document.getElementById('popup-body');

  state.popup.open = true;
  state.popup.hotspotId = hotspot.id;
  title.textContent = hotspot.name;
  icon.textContent = hotspot.icon;

  const statusText = STATUS_LABEL[hotspot.status];
  const statusClass = hotspot.status;

  let metricsHtml = `<div class="popup-status ${statusClass}">${statusText}</div>`;
  hotspot.metrics.forEach((m, i) => {
    if (i === 0) {
      metricsHtml += `
        <div class="popup-metric">
          <span class="popup-metric-name">${m.name}</span>
          <span class="popup-metric-value">${m.value}${m.unit ? ' ' + m.unit : ''}</span>
        </div>
        <div class="popup-chart"><canvas id="popup-chart"></canvas></div>`;
    } else {
      metricsHtml += `
        <div class="popup-metric">
          <span class="popup-metric-name">${m.name}</span>
          <span class="popup-metric-value">${m.value}${m.unit ? ' ' + m.unit : ''}</span>
        </div>`;
    }
  });

  body.innerHTML = metricsHtml;
  popup.classList.remove('hidden');

  // 定位弹窗到 3D 热点的投影位置
  const hp = state.hotspotById.get(hotspot.id);
  const pos = hp.group.position.clone();
  const dir = new THREE.Vector3();
  state.camera.getWorldDirection(dir);
  const dot = pos.clone().normalize().dot(dir);
  let left, top;
  if (dot < 0.15) {
    left = state.width / 2 - 140;
    top = state.height / 2 - 120;
  } else {
    const sp = pos.project(state.camera);
    left = (sp.x * 0.5 + 0.5) * state.width + 24;
    top = (-sp.y * 0.5 + 0.5) * state.height + 24;
    if (left + 290 > state.width) left -= 314;
    if (top + 230 > state.height) top -= 254;
    left = Math.max(8, left);
    top = Math.max(72, top);
  }
  popup.style.left = left + 'px';
  popup.style.top = top + 'px';

  const firstMetric = hotspot.metrics[0];
  if (firstMetric && firstMetric.spark) drawSparkline('popup-chart', firstMetric.spark);
}

function closePopup() {
  document.getElementById('popup').classList.add('hidden');
  state.popup.open = false;
  state.popup.hotspotId = null;
}

function drawSparkline(canvasId, data) {
  const ctx = document.getElementById(canvasId).getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i),
      datasets: [{
        data,
        borderColor: '#00f0ff',
        backgroundColor: 'rgba(0, 240, 255, 0.15)',
        borderWidth: 2, fill: true, pointRadius: 0, tension: 0.4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: { x: { display: false }, y: { display: false } },
      animation: false
    }
  });
}

/* ===== 图表（桌面 HUD） ===== */
function initCharts() {
  Chart.defaults.color = '#94a3b8';
  Chart.defaults.font.family = '"PingFang SC","Microsoft YaHei",sans-serif';

  const energyCtx = document.getElementById('chart-energy').getContext('2d');
  const energyGradient = energyCtx.createLinearGradient(0, 0, 0, 160);
  energyGradient.addColorStop(0, 'rgba(0, 240, 255, 0.25)');
  energyGradient.addColorStop(1, 'rgba(0, 240, 255, 0.0)');
  state.energyChart = new Chart(energyCtx, {
    type: 'line',
    data: {
      labels: ['00', '03', '06', '09', '12', '15', '18', '21', '24'],
      datasets: [{
        label: '总能耗',
        data: [980, 760, 820, 1150, 1280, 1340, 1420, 1180, 920],
        borderColor: '#00f0ff', backgroundColor: energyGradient,
        borderWidth: 2, fill: true, pointRadius: 3,
        pointBackgroundColor: '#00f0ff', pointBorderColor: '#fff', tension: 0.4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 11 } }, beginAtZero: true }
      }
    }
  });

  const vehicleCtx = document.getElementById('chart-vehicle').getContext('2d');
  state.vehicleChart = new Chart(vehicleCtx, {
    type: 'bar',
    data: {
      labels: ['06', '08', '10', '12', '14', '16', '18', '20'],
      datasets: [{
        label: '进出车辆',
        data: [45, 120, 210, 185, 165, 240, 180, 95],
        backgroundColor: '#00a8ff', borderRadius: 4, hoverBackgroundColor: '#00f0ff'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { font: { size: 11 } }, beginAtZero: true }
      }
    }
  });
}

/* ===== 实时数据仿真 ===== */
function initSimulation() {
  setInterval(() => {
    jitter('kpi-energy', 1200, 1400, 0);
    jitter('kpi-flow', 3200, 3600, 0);
    jitter('kpi-occupancy', 90, 95, 1);
    jitter('env-pm', 25, 45, 0);
    jitter('env-temp', 22, 27, 1);
    jitter('env-humidity', 50, 70, 0);
    jitter('env-co2', 390, 450, 0);
  }, 3000);

  setInterval(() => {
    const energy = state.energyChart.data.datasets[0].data;
    energy.shift(); energy.push(rand(900, 1450));
    state.energyChart.update();
    const vehicle = state.vehicleChart.data.datasets[0].data;
    vehicle.shift(); vehicle.push(rand(60, 260));
    state.vehicleChart.update();
  }, 8000);

  (function addAlertLoop() {
    const delay = rand(15000, 30000);
    setTimeout(() => { addRandomAlert(); addAlertLoop(); }, delay);
  })();
}

function jitter(id, min, max, decimals) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = rand(min, max, decimals).toLocaleString('zh-CN',
    { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function rand(min, max, decimals = 0) {
  const v = Math.random() * (max - min) + min;
  return Math.round(v * Math.pow(10, decimals)) / Math.pow(10, decimals);
}

const ALERT_TEMPLATES = [
  { title: 'A1 主楼 4F 温度偏高', desc: '当前 26.8°C，已联动空调降温', type: 'warn' },
  { title: 'P2 充电桩使用高峰', desc: '当前 12 台充电中，建议引导错峰', type: 'info' },
  { title: '西门 未授权车辆闯入', desc: '道闸自动拦截，保安已收到通知', type: 'danger' },
  { title: '光伏车棚发电效率提升', desc: '光照良好，发电效率达 82%', type: 'info' },
  { title: '中央喷泉 水质监测正常', desc: 'PH 7.2，浊度 0.3 NTU', type: 'info' }
];

function addRandomAlert() {
  const list = document.getElementById('alert-list');
  const tpl = ALERT_TEMPLATES[Math.floor(Math.random() * ALERT_TEMPLATES.length)];
  const now = new Date();
  const time = now.toLocaleTimeString('zh-CN', { hour12: false });
  const item = document.createElement('div');
  item.className = 'alert-item ' + tpl.type;
  item.innerHTML = `
    <div class="alert-time">${time}</div>
    <div class="alert-body">
      <div class="alert-title">${tpl.title}</div>
      <div class="alert-desc">${tpl.desc}</div>
    </div>`;
  list.prepend(item);
  if (list.children.length > 8) list.lastElementChild.remove();
  const alertCount = list.querySelectorAll('.alert-item.danger, .alert-item.warn').length;
  document.getElementById('kpi-alert').innerHTML = `${alertCount}<span class="kpi-unit">条</span>`;
}

/* ===== 事件绑定 ===== */
function bindEvents() {
  const dom = state.renderer.domElement;

  dom.addEventListener('pointerdown', (e) => {
    state.pointerDown.x = e.clientX; state.pointerDown.y = e.clientY;
  });

  // 点击（非拖拽）选中 3D 热点 → 桌面弹窗
  dom.addEventListener('click', (e) => {
    if (state.renderer.xr.isPresenting) return;
    if (Math.abs(e.clientX - state.pointerDown.x) > 5 ||
        Math.abs(e.clientY - state.pointerDown.y) > 5) return;  // 是拖拽
    state.pointer.x = (e.clientX / state.width) * 2 - 1;
    state.pointer.y = -(e.clientY / state.height) * 2 + 1;
    state.raycaster.setFromCamera(state.pointer, state.camera);
    const hits = state.raycaster.intersectObjects(state.hotspots3D, true);
    if (hits.length) {
      let obj = hits[0].object;
      while (obj && !obj.userData.hotspot) obj = obj.parent;
      if (obj && obj.userData.hotspot) { openPopup(obj.userData.hotspot); return; }
    }
    closePopup();
  });

  // 悬停指针变化
  dom.addEventListener('pointermove', (e) => {
    if (state.renderer.xr.isPresenting) return;
    state.pointer.x = (e.clientX / state.width) * 2 - 1;
    state.pointer.y = -(e.clientY / state.height) * 2 + 1;
    state.raycaster.setFromCamera(state.pointer, state.camera);
    const hits = state.raycaster.intersectObjects(state.hotspots3D, true);
    let hp = null;
    if (hits.length) {
      let o = hits[0].object;
      while (o && !o.userData.hotspot) o = o.parent;
      if (o) hp = o.userData.hotspot;
    }
    state.hoverHotspot = hp;
    dom.style.cursor = hp ? 'pointer' : 'grab';
  });

  // 悬停暂停自动旋转
  dom.addEventListener('mouseenter', () => { if (state.controls) state.controls.autoRotate = false; });
  dom.addEventListener('mouseleave', () => { if (state.controls) state.controls.autoRotate = true; });

  document.getElementById('popup-close').addEventListener('click', closePopup);

  window.addEventListener('resize', () => {
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    state.camera.aspect = state.width / state.height;
    state.camera.updateProjectionMatrix();
    state.renderer.setSize(state.width, state.height);
  });
}

/* ===== 启动 ===== */
init();
