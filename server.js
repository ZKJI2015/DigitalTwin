const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const zlib = require('zlib');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = parseInt(process.env.PORT, 10) || 8080;
const ROOT = process.cwd();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
};

// 静态资源缓存策略：图片/字体长期缓存，JS/CSS 一天，HTML 不缓存
const CACHE_POLICY = {
  '.html': 'no-cache',
  '.js': 'public, max-age=86400',
  '.css': 'public, max-age=86400',
  '.png': 'public, max-age=604800, immutable',
  '.jpg': 'public, max-age=604800, immutable',
  '.jpeg': 'public, max-age=604800, immutable',
  '.svg': 'public, max-age=604800, immutable',
  '.json': 'public, max-age=3600',
  '.txt': 'public, max-age=3600',
  '.wasm': 'public, max-age=604800, immutable'
};

const GZIP_EXTS = new Set(['.html','.js','.css','.json','.txt','.svg','.wasm']);

function send404(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('404 Not Found');
}

function sendJSON(res, data, code = 200) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function sendFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const cache = CACHE_POLICY[ext] || 'no-cache';
  res.statusCode = 200;
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', cache);

  let stream = fs.createReadStream(filePath);
  stream.on('error', () => send404(res));

  // 对文本类资源开启 gzip（已压缩的图片/视频跳过）
  const acceptEnc = (req.headers['accept-encoding'] || '').toLowerCase();
  if (GZIP_EXTS.has(ext) && acceptEnc.includes('gzip')) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    stream = stream.pipe(zlib.createGzip());
  }

  stream.pipe(res);
}

/* ===== 天气 API 代理（Open-Meteo，免费无需 API Key） ===== */
function proxyWeather(req, res) {
  const parsed = url.parse(req.url, true);
  const query = parsed.query;

  const CURRENT_FIELDS = 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m';

  let apiUrl;
  if (query.lat && query.lon) {
    // 按经纬度查询
    apiUrl = `https://api.open-meteo.com/v1/forecast?latitude=${query.lat}&longitude=${query.lon}&current=${CURRENT_FIELDS}&timezone=auto`;
  } else if (query.q) {
    // 按城市名查询（使用 geocoding API 先转坐标）
    const city = encodeURIComponent(query.q);
    apiUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${city}&count=1&language=zh`;
  } else {
    sendJSON(res, { error: '缺少参数：lat&lon 或 q' }, 400);
    return;
  }

  // 如果是城市名查询，先 geocoding 再查天气
  if (query.q) {
    https.get(apiUrl, (geoRes) => {
      let body = '';
      geoRes.on('data', chunk => body += chunk);
      geoRes.on('end', () => {
        try {
          const geoData = JSON.parse(body);
          if (!geoData.results || geoData.results.length === 0) {
            sendJSON(res, { error: '未找到该城市' }, 404);
            return;
          }
          const loc = geoData.results[0];
          const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=${CURRENT_FIELDS}&timezone=auto`;
          https.get(weatherUrl, (wRes) => {
            let wBody = '';
            wRes.on('data', chunk => wBody += chunk);
            wRes.on('end', () => {
              try {
                const weatherData = JSON.parse(wBody);
                weatherData.city_name = loc.name || loc.admin1 || query.q;
                sendJSON(res, weatherData);
              } catch (e) {
                sendJSON(res, { error: '天气数据解析失败' }, 500);
              }
            });
          }).on('error', () => sendJSON(res, { error: '天气 API 请求失败' }, 502));
        } catch (e) {
          sendJSON(res, { error: '地理编码解析失败' }, 500);
        }
      });
    }).on('error', () => sendJSON(res, { error: '地理编码 API 请求失败' }, 502));
    return;
  }

  // 直接按经纬度查询：先反向地理编码获取城市名，再合并到天气结果
  const revUrl = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${query.lat}&longitude=${query.lon}&localityLanguage=zh`;
  https.get(revUrl, (revRes) => {
    let revBody = '';
    revRes.on('data', chunk => revBody += chunk);
    revRes.on('end', () => {
      let cityName = '';
      try {
        const revData = JSON.parse(revBody);
        cityName = revData.city || revData.locality || revData.principalSubdivision || '';
      } catch (e) { /* 反向地理编码解析失败，忽略 */ }

      https.get(apiUrl, (wRes) => {
        let wBody = '';
        wRes.on('data', chunk => wBody += chunk);
        wRes.on('end', () => {
          try {
            const weatherData = JSON.parse(wBody);
            // 有城市名就用城市名，否则用时区兜底（如 Asia/Shanghai）
            weatherData.city_name = cityName || (weatherData.timezone || '');
            sendJSON(res, weatherData);
          } catch (e) {
            sendJSON(res, { error: '天气数据解析失败' }, 500);
          }
        });
      }).on('error', () => sendJSON(res, { error: '天气 API 请求失败' }, 502));
    });
  }).on('error', () => {
    // 反向地理编码服务不可用时，仍返回天气（城市名留空，前端回退到默认城市）
    https.get(apiUrl, (wRes) => {
      let wBody = '';
      wRes.on('data', chunk => wBody += chunk);
      wRes.on('end', () => {
        try {
          sendJSON(res, JSON.parse(wBody));
        } catch (e) {
          sendJSON(res, { error: '天气数据解析失败' }, 500);
        }
      });
    }).on('error', () => sendJSON(res, { error: '天气 API 请求失败' }, 502));
  });
}

const server = http.createServer((req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const urlPath = decodeURIComponent(parsed.pathname);

    // 天气 API 代理
    if (urlPath === '/api/weather') {
      proxyWeather(req, res);
      return;
    }

    let filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) { send404(res); return; }
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        const index = path.join(filePath, 'index.html');
        if (fs.existsSync(index)) { sendFile(req, res, index); return; }
        send404(res); return;
      }
      sendFile(req, res, filePath);
    } else {
      // fallback to index.html for SPA-like usage
      const index = path.join(ROOT, 'index.html');
      if (fs.existsSync(index)) { sendFile(req, res, index); return; }
      send404(res);
    }
  } catch (err) {
    console.error('Server error:', err);
    res.statusCode = 500; res.end('500');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${ROOT} at http://${HOST}:${PORT}/`);
  console.log('Press Ctrl+C to stop.');
});
