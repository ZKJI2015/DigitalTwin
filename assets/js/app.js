/* ============================================================
 *  VR 全景数字孪生 · 智慧园区
 *  Three.js r160 + WebXR（VR 头显双目渲染）
 *  - 桌面：鼠标拖拽环视 / 滚轮 FOV 缩放 / 点击 3D 热点 → DOM 弹窗
 *  - VR：转头环视 / 凝视热点 1.2s → 3D 信息面板 / 手柄射线选择
 * ============================================================ */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
// VRButton / GLTFLoader 非首屏必需，按需动态导入

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
  },
  {
    id: 'model-show',
    name: '设备三维模型',
    lat: 0, lon: -45,
    type: 'model', icon: '📦', status: 'normal',
    model: 'assets/models/test.glb'
  }
];

/* ===== 初始化入口 ===== */
function init() {
  initClock();
  initWeather();
  initThreeJS();
  createHotspots3D();
  createReticle();
  createInfoPanel();
  setupControllers();
  initCharts();
  initSimulation();
  bindEvents();
  scheduleVideoMonitor();   // 监控画面在 UI 完全显示后自动加载，不阻塞首屏
  initModelViewer();
  // 数字人改为「点击热点时再加载」，见 ensureDigitalHumanLoaded()
}

/* ===== 天气：前端直连 Open-Meteo（支持 CORS，无需后端代理） ===== */
// 默认城市（geolocation 不可用或失败时显示）。可改成任意城市，如 '上海' '深圳'
const DEFAULT_CITY = '上海';
// 是否优先使用浏览器定位（true=优先定位真实位置；false=始终显示 DEFAULT_CITY）
const USE_GEOLOCATION = true;

const WEATHERCODE_MAP = {
  0: { icon: '☀️', text: '晴' },
  1: { icon: '🌤️', text: '少云' },
  2: { icon: '⛅', text: '多云' },
  3: { icon: '☁️', text: '阴' },
  45: { icon: '🌫️', text: '雾' },
  48: { icon: '🌫️', text: '霜/薄雾' },
  51: { icon: '🌦️', text: '小雨' },
  53: { icon: '🌦️', text: '中雨' },
  55: { icon: '🌧️', text: '毛毛雨' },
  61: { icon: '🌧️', text: '小雨' },
  63: { icon: '🌧️', text: '中雨' },
  65: { icon: '🌧️', text: '大雨' },
  71: { icon: '❄️', text: '小雪' },
  73: { icon: '❄️', text: '中雪' },
  75: { icon: '❄️', text: '大雪' },
  80: { icon: '🌧️', text: '阵雨' },
  81: { icon: '🌧️', text: '强阵雨' },
  95: { icon: '⛈️', text: '雷暴' }
};

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(id));
}

const OPEN_METEO_FIELDS = 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m';

// 按经纬度直连 Open-Meteo，并用 bigdatacloud 反向地理编码获取城市名（CORS 友好）
async function fetchWeatherByCoords(lat, lon, timeoutMs = 4000) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current=${OPEN_METEO_FIELDS}&timezone=auto`;
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error('weather fetch failed');
  const data = await res.json();
  data.city_name = '';
  try {
    const revRes = await fetchWithTimeout(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`, timeoutMs);
    if (revRes.ok) {
      const rev = await revRes.json();
      data.city_name = rev.city || rev.locality || rev.principalSubdivision || '';
    }
  } catch (e) { /* 反向地理编码失败则城市名留空 */ }
  return data;
}

// 按城市名：先 geocoding 转坐标，再直连 Open-Meteo
async function fetchWeatherByCity(q, timeoutMs = 4000) {
  const geoRes = await fetchWithTimeout(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=1&language=zh`, timeoutMs);
  if (!geoRes.ok) throw new Error('geocoding failed');
  const geo = await geoRes.json();
  if (!geo.results || geo.results.length === 0) throw new Error('city not found');
  const loc = geo.results[0];
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=${OPEN_METEO_FIELDS}&timezone=auto`;
  const res = await fetchWithTimeout(url, timeoutMs);
  if (!res.ok) throw new Error('weather fetch failed');
  const data = await res.json();
  data.city_name = loc.name || loc.admin1 || q;
  return data;
}

// IP 地理定位回退：浏览器定位在非安全上下文（局域网 http）会被禁用，
// 此时用公网 IP 粗略定位城市（请求从浏览器走公网，可拿到真实城市）
async function fetchCityByIp(timeoutMs = 4000) {
  const res = await fetchWithTimeout('https://ipapi.co/json/', timeoutMs);
  if (!res.ok) throw new Error('ip geo failed');
  const d = await res.json();
  if (!d.city) throw new Error('no city in ip geo');
  return d.city;
}

async function updateWeather(timeoutMs = 4000) {
  try {
    let data = null;
    if (USE_GEOLOCATION && navigator.geolocation) {
      data = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('geolocation timeout')), 4000);
        navigator.geolocation.getCurrentPosition(async (pos) => {
          clearTimeout(timer);
          try { resolve(await fetchWeatherByCoords(pos.coords.latitude, pos.coords.longitude, timeoutMs)); }
          catch (e) { reject(e); }
        }, () => reject(new Error('geolocation denied')), { timeout: 4000 });
      }).catch(async () => {
        // geolocation 不可用/被拒：尝试 IP 地理定位（非安全上下文也能粗略定位），再失败回退默认城市
        try {
          const city = await fetchCityByIp(timeoutMs);
          return await fetchWeatherByCity(city, timeoutMs);
        } catch (e) {
          return await fetchWeatherByCity(DEFAULT_CITY, timeoutMs);
        }
      });
    } else {
      data = await fetchWeatherByCity(DEFAULT_CITY, timeoutMs);
    }

    if (!data) return;
    const elIcon = document.getElementById('weather-icon');
    const elText = document.getElementById('weather-text');
    const elCity = document.getElementById('weather-city');

    // 显示城市名（定位成功时取服务端 city_name，否则用默认城市）
    if (elCity) elCity.textContent = data.city_name || DEFAULT_CITY;

    // Open-Meteo 新版响应（current 字段，无需 API Key）
    if (data.current) {
      const c = data.current;
      const temp = typeof c.temperature_2m === 'number' ? Math.round(c.temperature_2m) : '';
      const code = c.weather_code;
      const wmap = WEATHERCODE_MAP[code] || { icon: '⛅', text: '' };
      const hum = typeof c.relative_humidity_2m === 'number' ? Math.round(c.relative_humidity_2m) : '';
      const wind = typeof c.wind_speed_10m === 'number' ? Math.round(c.wind_speed_10m) : '';
      if (elIcon) elIcon.textContent = wmap.icon;
      let txt = `${wmap.text} ${temp}°C`;
      if (hum !== '') txt += ` · 湿度${hum}%`;
      if (wind !== '') txt += ` · 风速${wind}km/h`;
      if (elText) elText.textContent = txt;
      return;
    }

    // Open-Meteo 旧版响应（current_weather 字段）
    if (data.current_weather) {
      const cw = data.current_weather;
      const temp = typeof cw.temperature === 'number' ? Math.round(cw.temperature) : '';
      const code = cw.weathercode;
      const wmap = WEATHERCODE_MAP[code] || { icon: '⛅', text: '' };
      if (elIcon) elIcon.textContent = wmap.icon;
      if (elText) elText.textContent = `${wmap.text} ${temp}°C`;
      return;
    }

    console.warn('天气数据格式未知：', data);
  } catch (err) {
    console.warn('更新天气失败：', err);
  }
}

function initWeather() {
  // UI 完全显示（首屏渲染完、主线程空闲）后自动请求天气（优先用当前位置），之后每 10 分钟刷新
  const start = () => {
    updateWeather(4000);
    setInterval(() => updateWeather(4000), 10 * 60 * 1000);
  };
  if ('requestIdleCallback' in window) {
    requestIdleCallback(start, { timeout: 3000 });
  } else {
    window.addEventListener('load', start, { once: true });
  }
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

  // VR 入口按钮（按需加载，不阻塞首屏）
  import('three/addons/webxr/VRButton.js').then(({ VRButton }) => {
    const vrBtn = VRButton.createButton(state.renderer);
    vrBtn.classList.add('vr-enter-btn');
    document.body.appendChild(vrBtn);
  }).catch(err => console.warn('VRButton 加载失败', err));

  // 全景：6 张立方体贴图（右/左/上/下/前/后），设为场景背景，相机在中心环视
  // 顺序对应 Three.js 立方体贴图：[+X, -X, +Y, -Y, +Z, -Z]
  const cubeLoader = new THREE.CubeTextureLoader();
  cubeLoader.setPath('assets/images/vr/');
  cubeLoader.load(
    ['pano_r.jpg', 'pano_l.jpg', 'pano_u.jpg', 'pano_d.jpg', 'pano_f.jpg', 'pano_b.jpg'],
    (cubeTex) => {
      cubeTex.colorSpace = THREE.SRGBColorSpace;
      state.scene.background = cubeTex;
      document.getElementById('loading').classList.add('hidden');
    },
    undefined,
    (err) => {
      console.error('全景图加载失败:', err);
      document.getElementById('loading').innerHTML =
        '<p style="color:#f87171">全景图加载失败，请检查 assets/images/vr/ 下的 6 张图</p>';
    }
  );

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
  ensureDigitalHumanLoaded();   // VR 凝视热点时再加载数字人
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
      if (obj && obj.userData.hotspot) {
        const h = obj.userData.hotspot;
        ensureDigitalHumanLoaded();   // 点击热点时再加载数字人
        if (h.type === 'model') openModelViewer(h.model, h.name);
        else openPopup(h);
        return;
      }
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

/* ===== 视频监控小窗口初始化 ===== */
/* 监控画面默认只显示 poster；等 UI 完全显示（首屏渲染完、主线程空闲）后再自动加载，不阻塞打开速度 */
let videoMonitorLoaded = false;
function ensureVideoMonitorLoaded() {
  if (videoMonitorLoaded) return;
  videoMonitorLoaded = true;
  initVideoMonitor();
}

// 等 UI 完全显示后再自动加载监控：优先 requestIdleCallback（主线程空闲），兜底 window.load
function scheduleVideoMonitor() {
  const start = () => ensureVideoMonitorLoaded();
  if ('requestIdleCallback' in window) {
    requestIdleCallback(start, { timeout: 3000 });
  } else {
    window.addEventListener('load', start, { once: true });
  }
}

async function initVideoMonitor() {
  const vid = document.getElementById('video-monitor');
  if (!vid) return;

  // HLS 流地址（来自用户）
  const HLS_URL = 'http://devimages.apple.com.edgekey.net/streaming/examples/bipbop_4x3/gear2/prog_index.m3u8';

  // 首先尝试原生播放（Safari 和部分浏览器支持）
  const canPlayNative = vid.canPlayType('application/vnd.apple.mpegurl') || vid.canPlayType('application/x-mpegURL');
  if (canPlayNative) {
    vid.src = HLS_URL;
    try { await vid.play(); } catch (e) { /* autoplay 可能被阻止 */ }
    return;
  }

  // 如果浏览器不原生支持 HLS，使用 hls.js 回退（index.html 已引入 hls.js）
  try {
    if (window.Hls && window.Hls.isSupported()) {
      const hls = new window.Hls();
      hls.loadSource(HLS_URL);
      hls.attachMedia(vid);
      hls.on(window.Hls.Events.MANIFEST_PARSED, async () => {
        try { await vid.play(); } catch (e) { /* autoplay blocked */ }
      });
      return;
    }
  } catch (e) {
    console.warn('hls.js 初始化失败', e);
  }

  // 若 HLS 不可用，回退到本地文件播放（若提供）或摄像头
  try {
    const res = await fetch('assets/video/camera-monitor.mp4', { method: 'HEAD' });
    if (res.ok) {
      const src = document.createElement('source');
      src.src = 'assets/video/camera-monitor.mp4';
      src.type = 'video/mp4';
      vid.appendChild(src);
      try { vid.load(); await vid.play(); } catch (e) { }
      return;
    }
  } catch (e) { }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280 }, audio: false });
      vid.srcObject = stream;
      try { await vid.play(); } catch (e) { }
      return;
    } catch (err) {
      console.warn('无法访问摄像头：', err);
    }
  }

  // 最终保留 poster，占位并让用户手动点击播放
}

/* ===== 三维模型查看器（点击模型热点，屏幕中央弹出并自动旋转） ===== */
const modelViewer = {
  open: false,
  renderer: null,
  scene: null,
  camera: null,
  controls: null,
  modelGroup: null,
  container: null,
  rafId: null,
  loadedPath: null
};

function initModelViewer() {
  const wrap = document.getElementById('model-canvas-wrap');
  if (!wrap) return;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 1.1, 4.5);

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x88bbff, 0.5);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.autoRotate = true;          // 自动旋转
  controls.autoRotateSpeed = 2.0;
  controls.enablePan = false;
  controls.minDistance = 2;
  controls.maxDistance = 12;
  controls.target.set(0, 0.6, 0);

  modelViewer.renderer = renderer;
  modelViewer.scene = scene;
  modelViewer.camera = camera;
  modelViewer.controls = controls;
  modelViewer.container = wrap;
  wrap.appendChild(renderer.domElement);

  document.getElementById('model-viewer-close').addEventListener('click', closeModelViewer);
  // 点击遮罩空白处关闭
  document.getElementById('model-viewer').addEventListener('click', (e) => {
    if (e.target.id === 'model-viewer') closeModelViewer();
  });
  window.addEventListener('resize', () => { if (modelViewer.open) resizeModelViewer(); });
}

function openModelViewer(glbPath, title) {
  const overlay = document.getElementById('model-viewer');
  if (!overlay) return;
  const tip = document.getElementById('model-tip');
  if (tip) tip.textContent = '';
  const titleEl = document.getElementById('model-title');
  if (titleEl) titleEl.textContent = title || '三维模型';

  overlay.classList.remove('hidden');
  modelViewer.open = true;
  resizeModelViewer();

  // 仅加载一次；切换不同模型时可扩展
  if (!modelViewer.loadedPath && glbPath) {
    import('three/addons/loaders/GLTFLoader.js').then(({ GLTFLoader }) => {
      const loader = new GLTFLoader();
      loader.load(glbPath, (gltf) => {
        const grp = new THREE.Group();
        grp.add(gltf.scene);
        // 居中并归一化缩放到合适大小
        const box = new THREE.Box3().setFromObject(gltf.scene);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        grp.position.sub(center);
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        grp.scale.setScalar(2.4 / maxDim);
        modelViewer.scene.add(grp);
        modelViewer.modelGroup = grp;
        modelViewer.loadedPath = glbPath;
      }, undefined, (err) => {
        console.error('模型加载失败：', err);
        if (tip) tip.textContent = '模型加载失败，请确认 ' + glbPath + ' 存在';
      });
    });
  }

  if (!modelViewer.rafId) animateModelViewer();
}

function animateModelViewer() {
  modelViewer.rafId = requestAnimationFrame(animateModelViewer);
  if (modelViewer.controls) modelViewer.controls.update();
  modelViewer.renderer.render(modelViewer.scene, modelViewer.camera);
}

function closeModelViewer() {
  const overlay = document.getElementById('model-viewer');
  if (overlay) overlay.classList.add('hidden');
  modelViewer.open = false;
  if (modelViewer.rafId) {
    cancelAnimationFrame(modelViewer.rafId);
    modelViewer.rafId = null;
  }
}

function resizeModelViewer() {
  const wrap = modelViewer.container;
  if (!wrap) return;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  if (!w || !h) return;
  modelViewer.renderer.setSize(w, h, false);
  modelViewer.camera.aspect = w / h;
  modelViewer.camera.updateProjectionMatrix();
}

/* ===== 数字人（右下角视频，绿幕抠像透明显示） ===== */
/* 点击/凝视热点时才首次加载数字人，避免首屏占用带宽与渲染 */
let digitalHumanLoaded = false;
function ensureDigitalHumanLoaded() {
  if (digitalHumanLoaded) return;
  digitalHumanLoaded = true;
  initDigitalHuman();
  const panel = document.getElementById('digital-human');
  if (panel) panel.classList.add('is-ready');
}

function initDigitalHuman() {
  const v = document.getElementById('digital-human-video');
  const canvas = document.getElementById('digital-human-canvas');
  if (!v || !canvas) return;
  if (!v.getAttribute('src')) v.src = 'assets/video/test.mp4';  // 按需设置源，首屏不加载
  const ctx = canvas.getContext('2d');

  // 绿幕抠像参数（可按素材微调）
  const KEY_LOW = 25;    // 绿溢出低于此值：完全保留（前景）
  const KEY_HIGH = 85;   // 绿溢出高于此值：完全透明（背景）
  const SPILL = 0.25;    // 溢色抑制强度：压低残留绿色，消除绿边

  function ensureSize() {
    if (!v.videoWidth) return;
    // 限制处理分辨率，兼顾性能
    const MAX = 320;
    const scale = Math.min(1, MAX / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.max(1, Math.round(v.videoWidth * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  function draw() {
    ensureSize();
    if (v.readyState >= 2 && canvas.width && canvas.height) {
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = frame.data;
      for (let i = 0; i < d.length; i += 4) {
        let r = d[i], g = d[i + 1], b = d[i + 2];
        const maxRB = r > b ? r : b;
        const spill = g - maxRB; // 绿色超出红/蓝的程度
        let alpha;
        if (spill <= KEY_LOW) {
          alpha = 255;
        } else if (spill >= KEY_HIGH) {
          alpha = 0;
        } else {
          // 边缘羽化，避免硬边与绿边
          alpha = 255 * (1 - (spill - KEY_LOW) / (KEY_HIGH - KEY_LOW));
        }
        // 溢色抑制：压低残留绿色，头发边缘不再发绿
        if (spill > 0) g = maxRB + spill * SPILL;
        d[i] = r;
        d[i + 1] = g;
        d[i + 2] = b;
        d[i + 3] = alpha;
      }
      ctx.putImageData(frame, 0, 0);
    }
    requestAnimationFrame(draw);
  }

  v.play().catch(() => { /* 自动播放被拦截时静默忽略 */ });
  draw();
}

/* ===== 启动 ===== */
init();
