const http = require('http');
const url = require('url');
const config = require('./config');
const storage = require('./storage');

function wgs84ToGcj02(lat, lng) {
  const a = 6378245.0;
  const ee = 0.00669342162296594323;

  if (outOfChina(lat, lng)) return { lat, lng };

  let dLat = transformLat(lng - 105.0, lat - 35.0);
  let dLng = transformLng(lng - 105.0, lat - 35.0);
  const radLat = lat / 180.0 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - ee * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
  return { lat: lat + dLat, lng: lng + dLng };
}

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return ret;
}

function generateMapUrls(lat, lng) {
  const gcj = wgs84ToGcj02(lat, lng);
  return {
    amapUrl: `https://uri.amap.com/marker?position=${gcj.lng},${gcj.lat}&name=位置`,
    appleUrl: `https://maps.apple.com/?ll=${gcj.lat},${gcj.lng}&q=位置`
  };
}

function getClientIP(req) {
  // 支持多种代理场景，优先级从高到低：
  // 1. Cloudflare CF-Connecting-IP (最优先，Cloudflare的真实客户IP)
  // 2. X-Forwarded-For (多层代理时取第一个IP)
  // 3. X-Real-IP (Nginx反向代理)
  // 4. 原始socket连接IP (直连或未配置代理头)
  return (
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket.remoteAddress
  );
}

async function handleNotify(req, res, origin) {
  try {
    const clientIP = getClientIP(req);
    
    // 检查IP限流，传入配置参数
    const rateLimitCheck = storage.checkRateLimit(clientIP, {
      maxRequestsPer5Min: config.rateLimit.maxRequestsPer5Min,
      maxRequestsPerDay: config.rateLimit.maxRequestsPerDay
    });
    
    if (!rateLimitCheck.allowed) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      
      if (rateLimitCheck.violations.dailyExceeded) {
        return res.end(JSON.stringify({
          success: false,
          error: 'rate_limit_daily_exceeded',
          message: '您今天已发送过多次通知，无法继续发送'
        }));
      } else if (rateLimitCheck.violations.tooFrequent) {
        return res.end(JSON.stringify({
          success: false,
          error: 'rate_limit_5min',
          message: '操作过于频繁，请5分钟后再试'
        }));
      }
    }

    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    
    const message = data.message || '车旁有人等待';
    const location = data.location || null;
    const delayed = data.delayed || false;

    if (!config.bark.url) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ success: false, error: 'BARK_URL not configured' }));
    }

    const confirmUrl = encodeURIComponent(origin + '/owner-confirm');

    let notifyBody = '🚗 挪车请求';
    if (message) notifyBody += `\\n💬 留言: ${message}`;

    if (location && location.lat && location.lng) {
      const urls = generateMapUrls(location.lat, location.lng);
      notifyBody += '\\n📍 已附带位置信息，点击查看';

      await storage.put('requester_location', JSON.stringify({
        lat: location.lat,
        lng: location.lng,
        ...urls
      }), { expirationTtl: config.storage.ttl });
    } else {
      notifyBody += '\\n⚠️ 未提供位置信息';
    }

    await storage.put('notify_status', 'waiting', { expirationTtl: config.storage.statusTtl });

    if (delayed) {
      await new Promise(resolve => setTimeout(resolve, 30000));
    }

    const barkApiUrl = `${config.bark.url}/挪车请求/${encodeURIComponent(notifyBody)}?group=MoveCar&level=critical&call=1&sound=minuet&icon=${config.bark.icon}&url=${confirmUrl}`;

    const barkResponse = await fetch(barkApiUrl);
    if (!barkResponse.ok) throw new Error('Bark API Error');

    // 记录IP请求
    storage.recordRequest(clientIP);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: error.message }));
  }
}

async function handleGetLocation(req, res) {
  const data = await storage.get('requester_location');
  if (data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(data);
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No location' }));
  }
}

async function handleOwnerConfirm(req, res) {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    const ownerLocation = data.location || null;

    if (ownerLocation) {
      const urls = generateMapUrls(ownerLocation.lat, ownerLocation.lng);
      await storage.put('owner_location', JSON.stringify({
        lat: ownerLocation.lat,
        lng: ownerLocation.lng,
        ...urls,
        timestamp: Date.now()
      }), { expirationTtl: config.storage.ttl });
    }

    await storage.put('notify_status', 'confirmed', { expirationTtl: config.storage.statusTtl });
    
    // 记录请求者IP的确认状态
    const clientIP = getClientIP(req);
    storage.recordIPConfirmed(clientIP, config.ipConfirmation.recordTime);
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  } catch (error) {
    await storage.put('notify_status', 'confirmed', { expirationTtl: config.storage.statusTtl });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }
}

async function handleCheckStatus(req, res) {
  const status = await storage.get('notify_status');
  const ownerLocation = await storage.get('owner_location');
  const response = {
    status: status || 'waiting',
    ownerLocation: ownerLocation ? JSON.parse(ownerLocation) : null
  };
  
  // 只有在车主确认后才返回手机号码
  if (status === 'confirmed' && config.phone.number) {
    response.phone = config.phone.number;
  }
  
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(response));
}

function renderMainPage(origin, showSuccessView = false) {
  const phone = config.phone.number;
  const carNumber = config.car.number;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#0093E9">
  <title>通知车主挪车</title>
  <style>
    :root {
      --sat: env(safe-area-inset-top, 0px);
      --sar: env(safe-area-inset-right, 0px);
      --sab: env(safe-area-inset-bottom, 0px);
      --sal: env(safe-area-inset-left, 0px);
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
    html {
      font-size: 16px;
      -webkit-text-size-adjust: 100%;
    }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%);
      min-height: 100vh;
      min-height: -webkit-fill-available;
      padding: clamp(16px, 4vw, 24px);
      padding-top: calc(clamp(16px, 4vw, 24px) + var(--sat));
      padding-bottom: calc(clamp(16px, 4vw, 24px) + var(--sab));
      padding-left: calc(clamp(16px, 4vw, 24px) + var(--sal));
      padding-right: calc(clamp(16px, 4vw, 24px) + var(--sar));
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }
    body::before {
      content: ''; position: fixed; inset: 0;
      background: url("data:image/svg+xml,%3Csvg width='52' height='26' viewBox='0 0 52 26' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.1'%3E%3Cpath d='M10 10c0-2.21-1.79-4-4-4-3.314 0-6-2.686-6-6h2c0 2.21 1.79 4 4 4 3.314 0 6 2.686 6 6 0 2.21 1.79 4 4 4 3.314 0 6 2.686 6 6 0 2.21 1.79 4 4 4v2c-3.314 0-6-2.686-6-6 0-2.21-1.79-4-4-4-3.314 0-6-2.686-6-6zm25.464-1.95l8.486 8.486-1.414 1.414-8.486-8.486 1.414-1.414z' /%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
      z-index: -1;
    }

    .container {
      width: 100%;
      max-width: 500px;
      display: flex;
      flex-direction: column;
      gap: clamp(12px, 3vw, 20px);
    }

    .card {
      background: rgba(255, 255, 255, 0.95);
      border-radius: clamp(20px, 5vw, 28px);
      padding: clamp(18px, 4vw, 28px);
      box-shadow: 0 10px 40px rgba(0, 147, 233, 0.2);
      transition: transform 0.2s ease;
    }
    @media (hover: hover) {
      .card:hover { transform: translateY(-2px); }
    }
    .card:active { transform: scale(0.98); }

    .header {
      text-align: center;
      padding: clamp(20px, 5vw, 32px) clamp(16px, 4vw, 28px);
      background: white;
    }
    .icon-wrap {
      width: clamp(72px, 18vw, 100px);
      height: clamp(72px, 18vw, 100px);
      background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%);
      border-radius: clamp(22px, 5vw, 32px);
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto clamp(14px, 3vw, 24px);
      box-shadow: 0 12px 32px rgba(0, 147, 233, 0.35);
    }
    .icon-wrap span { font-size: clamp(36px, 9vw, 52px); }
    .header h1 {
      font-size: clamp(22px, 5.5vw, 30px);
      font-weight: 700;
      color: #1a202c;
      margin-bottom: 6px;
    }
    .header p {
      font-size: clamp(13px, 3.5vw, 16px);
      color: #718096;
      font-weight: 500;
    }

    .input-card { padding: 0; overflow: hidden; }
    .input-card textarea {
      width: 100%;
      min-height: clamp(90px, 20vw, 120px);
      border: none;
      padding: clamp(16px, 4vw, 24px);
      font-size: clamp(15px, 4vw, 18px);
      font-family: inherit;
      resize: none;
      outline: none;
      color: #2d3748;
      background: transparent;
      line-height: 1.5;
    }
    .input-card textarea::placeholder { color: #a0aec0; }
    .tags {
      display: flex;
      gap: clamp(6px, 2vw, 10px);
      padding: 0 clamp(12px, 3vw, 20px) clamp(14px, 3vw, 20px);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
      scrollbar-width: none;
    }
    .tags::-webkit-scrollbar { display: none; }
    .tag {
      background: linear-gradient(135deg, #e0f7fa 0%, #b2ebf2 100%);
      color: #00796b;
      padding: clamp(8px, 2vw, 12px) clamp(12px, 3vw, 18px);
      border-radius: 20px;
      font-size: clamp(13px, 3.5vw, 15px);
      font-weight: 600;
      white-space: nowrap;
      cursor: pointer;
      transition: all 0.2s;
      border: 1px solid #80cbc4;
      min-height: 44px;
      display: flex;
      align-items: center;
    }
    .tag:active { transform: scale(0.95); background: #80cbc4; }

    .loc-card {
      display: flex;
      align-items: center;
      gap: clamp(10px, 3vw, 16px);
      padding: clamp(14px, 3.5vw, 22px) clamp(16px, 4vw, 24px);
      cursor: pointer;
      min-height: 64px;
    }
    .loc-icon {
      width: clamp(44px, 11vw, 56px);
      height: clamp(44px, 11vw, 56px);
      border-radius: clamp(14px, 3.5vw, 18px);
      display: flex; align-items: center; justify-content: center;
      font-size: clamp(22px, 5.5vw, 28px);
      transition: all 0.3s;
      flex-shrink: 0;
    }
    .loc-icon.loading { background: #fff3cd; }
    .loc-icon.success { background: #d4edda; }
    .loc-icon.error { background: #f8d7da; }
    .loc-content { flex: 1; min-width: 0; }
    .loc-title {
      font-size: clamp(15px, 4vw, 18px);
      font-weight: 600;
      color: #2d3748;
    }
    .loc-status {
      font-size: clamp(12px, 3.2vw, 14px);
      color: #718096;
      margin-top: 3px;
    }
    .loc-status.success { color: #28a745; }
    .loc-status.error { color: #dc3545; }
    .loc-retry-btn {
      color: #0093E9;
      text-decoration: underline;
      cursor: pointer;
      margin-left: 8px;
      font-weight: 600;
    }
    .loc-refresh {
      font-size: clamp(20px, 5vw, 26px);
      color: #a0aec0;
      flex-shrink: 0;
    }

    .btn-main {
      background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%);
      color: white;
      border: none;
      padding: clamp(16px, 4vw, 22px);
      border-radius: clamp(16px, 4vw, 22px);
      font-size: clamp(16px, 4.2vw, 20px);
      font-weight: 700;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      box-shadow: 0 10px 30px rgba(0, 147, 233, 0.35);
      transition: all 0.2s;
      min-height: 56px;
    }
    .btn-main:active { transform: scale(0.98); }
    .btn-main:disabled {
      background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%);
      box-shadow: none;
      cursor: not-allowed;
    }

    .toast {
      position: fixed;
      top: calc(20px + var(--sat));
      left: 50%;
      transform: translateX(-50%) translateY(-100px);
      background: white;
      padding: clamp(12px, 3vw, 16px) clamp(20px, 5vw, 32px);
      border-radius: 16px;
      font-size: clamp(14px, 3.5vw, 16px);
      font-weight: 600;
      color: #2d3748;
      box-shadow: 0 10px 40px rgba(0,0,0,0.15);
      opacity: 0;
      transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      z-index: 100;
      max-width: calc(100vw - 40px);
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

    #successView { display: none; }
    .success-card {
      text-align: center;
      background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%);
      border: 2px solid #28a745;
    }
    .success-icon {
      font-size: clamp(56px, 14vw, 80px);
      margin-bottom: clamp(12px, 3vw, 20px);
      display: block;
    }
    .success-card h2 {
      color: #155724;
      margin-bottom: 8px;
      font-size: clamp(20px, 5vw, 28px);
    }
    .success-card p {
      color: #1e7e34;
      font-size: clamp(14px, 3.5vw, 16px);
    }

    .owner-card {
      background: white;
      border: 2px solid #80D0C7;
      text-align: center;
    }
    .owner-card.hidden { display: none; }
    .owner-card h3 {
      color: #0093E9;
      margin-bottom: 8px;
      font-size: clamp(18px, 4.5vw, 22px);
    }
    .owner-card p {
      color: #718096;
      margin-bottom: 16px;
      font-size: clamp(14px, 3.5vw, 16px);
    }
    .owner-card .map-links {
      display: flex;
      gap: clamp(8px, 2vw, 14px);
      flex-wrap: wrap;
    }
    .owner-card .map-btn {
      flex: 1;
      min-width: 120px;
      padding: clamp(12px, 3vw, 16px);
      border-radius: clamp(12px, 3vw, 16px);
      text-decoration: none;
      font-weight: 600;
      font-size: clamp(13px, 3.5vw, 15px);
      text-align: center;
      min-height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .map-btn.amap { background: #1890ff; color: white; }
    .map-btn.apple { background: #1d1d1f; color: white; }

    .action-card {
      display: flex;
      flex-direction: column;
      gap: clamp(10px, 2.5vw, 14px);
    }
    .action-hint {
      text-align: center;
      font-size: clamp(13px, 3.5vw, 15px);
      color: #718096;
      margin-bottom: 4px;
    }
    .btn-retry, .btn-phone {
      color: white;
      border: none;
      padding: clamp(14px, 3.5vw, 18px);
      border-radius: clamp(14px, 3.5vw, 18px);
      font-size: clamp(15px, 4vw, 17px);
      font-weight: 700;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: all 0.2s;
      min-height: 52px;
      text-decoration: none;
    }
    .btn-retry {
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      box-shadow: 0 8px 24px rgba(245, 158, 11, 0.3);
    }
    .btn-retry:active { transform: scale(0.98); }
    .btn-retry:disabled {
      background: linear-gradient(135deg, #9ca3af 0%, #6b7280 100%);
      box-shadow: none;
      cursor: not-allowed;
    }
    .hidden { display: none !important; }
    .btn-phone {
      background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
      box-shadow: 0 8px 24px rgba(239, 68, 68, 0.3);
    }
    .btn-phone:active { transform: scale(0.98); }

    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .loading-text { animation: pulse 1.5s ease-in-out infinite; }

    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 200;
      padding: 20px;
      opacity: 0;
      visibility: hidden;
      transition: all 0.3s;
    }
    .modal-overlay.show {
      opacity: 1;
      visibility: visible;
    }
    .modal-box {
      background: white;
      border-radius: 20px;
      padding: clamp(24px, 6vw, 32px);
      max-width: 340px;
      width: 100%;
      text-align: center;
      transform: scale(0.9);
      transition: transform 0.3s;
    }
    .modal-overlay.show .modal-box {
      transform: scale(1);
    }
    .modal-icon {
      font-size: 48px;
      margin-bottom: 16px;
    }
    .modal-title {
      font-size: 18px;
      font-weight: 700;
      color: #1a202c;
      margin-bottom: 8px;
    }
    .modal-desc {
      font-size: 14px;
      color: #718096;
      margin-bottom: 24px;
      line-height: 1.5;
    }
    .modal-buttons {
      display: flex;
      gap: 12px;
    }
    .modal-btn {
      flex: 1;
      padding: 14px 16px;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .modal-btn:active { transform: scale(0.96); }
    .modal-btn-primary {
      background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%);
      color: white;
    }
    .modal-btn-secondary {
      background: #f1f5f9;
      color: #64748b;
    }

    @media (min-width: 768px) {
      body {
        align-items: center;
      }
      .container {
        max-width: 480px;
      }
    }

    @media (min-width: 1024px) {
      .container {
        max-width: 520px;
      }
      .card {
        padding: 32px;
      }
    }

    @media (min-width: 600px) and (max-width: 900px) {
      .container {
        max-width: 460px;
      }
    }

    @media (orientation: landscape) and (max-height: 500px) {
      body {
        align-items: flex-start;
        padding-top: calc(12px + var(--sat));
      }
      .header {
        padding: 16px;
      }
      .icon-wrap {
        width: 60px;
        height: 60px;
        margin-bottom: 12px;
      }
      .icon-wrap span { font-size: 32px; }
      .input-card textarea {
        min-height: 70px;
      }
      .success-icon {
        font-size: 48px;
        margin-bottom: 10px;
      }
    }

    @media (max-width: 350px) {
      .container {
        gap: 10px;
      }
      .card {
        padding: 14px;
        border-radius: 18px;
      }
      .tags {
        gap: 6px;
      }
      .tag {
        padding: 8px 10px;
        font-size: 12px;
      }
    }
  </style>
</head>
<body>
  <div id="toast" class="toast"></div>

  <div id="locationTipModal" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-icon">📍</div>
      <div class="modal-title">位置信息说明</div>
      <div class="modal-desc">分享位置可让车主确认您在车旁<br>不分享将延迟30秒发送通知</div>
      <div class="modal-buttons">
        <button class="modal-btn modal-btn-primary" onclick="hideModal('locationTipModal');requestLocation()">我知道了</button>
      </div>
    </div>
  </div>

  <div id="delayModal" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-icon">⏱️</div>
      <div class="modal-title">未获取到位置</div>
      <div class="modal-desc">未获取位置信息，通知将延迟30秒发送<br>确定要发送吗？</div>
      <div class="modal-buttons">
        <button class="modal-btn modal-btn-secondary" onclick="hideModal('delayModal')">取消</button>
        <button class="modal-btn modal-btn-primary" onclick="hideModal('delayModal');sendNotify(true)">确定发送</button>
      </div>
    </div>
  </div>

  <div id="rateLimitModal" class="modal-overlay">
    <div class="modal-box">
      <div class="modal-icon" id="rateLimitIcon">⚠️</div>
      <div class="modal-title" id="rateLimitTitle">操作过于频繁</div>
      <div class="modal-desc" id="rateLimitDesc">请稍候再试</div>
      <div class="modal-buttons">
        <button class="modal-btn modal-btn-primary" onclick="hideModal('rateLimitModal')">知道了</button>
      </div>
    </div>
  </div>

  <div class="container" id="mainView">
    <div class="card header">
      <div class="icon-wrap"><span>🚗</span></div>
      <h1>通知车主挪车</h1>
      ${carNumber ? `<p style="font-size: clamp(13px, 3.5vw, 15px); color: #1e7e34; margin-bottom: 8px;">车牌号: <strong>${carNumber}</strong></p>` : ''}
      <p>扫码即可通知车主，保护双方隐私</p>
    </div>

    <div class="card input-card">
      <textarea id="messageInput" placeholder="请输入留言（可选）&#10;例如：挡住出口了，麻烦挪一下"></textarea>
      <div class="tags">
        <div class="tag" onclick="fillTag('挡住出口了')">挡住出口了</div>
        <div class="tag" onclick="fillTag('需要挪车')">需要挪车</div>
        <div class="tag" onclick="fillTag('麻烦让一下')">麻烦让一下</div>
        <div class="tag" onclick="fillTag('急事，请速挪车')">急事，请速挪车</div>
      </div>
    </div>

    <div class="card loc-card" onclick="requestLocation()">
      <div class="loc-icon" id="locIcon">📍</div>
      <div class="loc-content">
        <div class="loc-title">位置信息</div>
        <div class="loc-status" id="locStatus">点击获取位置（可选）</div>
      </div>
      <div class="loc-refresh" id="locRefresh"></div>
    </div>

    <button class="btn-main" id="sendBtn" onclick="handleSend()">
      <span>🔔</span>
      <span>通知车主</span>
    </button>
  </div>

  <div class="container" id="successView">
    <div class="card success-card">
      <span class="success-icon">✅</span>
      <h2>通知已发送</h2>
      ${carNumber ? `<p style="font-size: clamp(13px, 3.5vw, 15px); color: #1e7e34; margin-bottom: 8px;">车牌号: <strong>${carNumber}</strong></p>` : ''}
      <p>车主已收到通知，请耐心等待</p>
    </div>

    <div class="card owner-card hidden" id="ownerCard">
      <h3>📍 车主已确认</h3>
      <p>点击下方按钮查看车主位置</p>
      <div class="map-links">
        <a href="#" class="map-btn amap" id="ownerAmapBtn">高德地图</a>
        <a href="#" class="map-btn apple" id="ownerAppleBtn">苹果地图</a>
      </div>
    </div>

    <div class="card action-card">
      <div class="action-hint" id="actionHint">等待车主确认，请勿离开此页面...</div>
      <button class="btn-retry" id="checkBtn" onclick="checkOwnerStatus()">
        <span>🔄</span>
        <span>查看车主响应</span>
      </button>
      <a href="#" class="btn-phone hidden" id="phoneBtn"><span>📞</span><span id="phoneBtnText"></span></a>
    </div>
  </div>

  <script>
    let currentLocation = null;
    let locationStatus = 'pending';

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2500);
    }

    function showModal(id) {
      document.getElementById(id).classList.add('show');
    }

    function hideModal(id) {
      document.getElementById(id).classList.remove('show');
    }

    function fillTag(text) {
      document.getElementById('messageInput').value = text;
    }

    function requestLocation() {
      if (!navigator.geolocation) {
        showToast('您的浏览器不支持定位');
        return;
      }

      const icon = document.getElementById('locIcon');
      const status = document.getElementById('locStatus');
      const refresh = document.getElementById('locRefresh');

      icon.className = 'loc-icon loading';
      icon.textContent = '⏳';
      status.textContent = '正在获取位置...';
      status.className = 'loc-status';
      refresh.textContent = '';
      locationStatus = 'loading';

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          currentLocation = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude
          };
          icon.className = 'loc-icon success';
          icon.textContent = '✅';
          status.textContent = '位置获取成功';
          status.className = 'loc-status success';
          refresh.textContent = '🔄';
          locationStatus = 'success';
        },
        (err) => {
          icon.className = 'loc-icon error';
          icon.textContent = '❌';
          status.innerHTML = '获取失败<span class="loc-retry-btn" onclick="event.stopPropagation();requestLocation()">重试</span>';
          status.className = 'loc-status error';
          refresh.textContent = '';
          locationStatus = 'error';
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    }

    function handleSend() {
      if (locationStatus === 'loading') {
        showToast('正在获取位置，请稍候...');
        return;
      }

      if (locationStatus === 'success' || locationStatus === 'pending') {
        sendNotify(false);
      } else {
        showModal('delayModal');
      }
    }

    async function sendNotify(delayed) {
      const btn = document.getElementById('sendBtn');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span><span>发送中...</span>';

      try {
        const res = await fetch('/api/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: document.getElementById('messageInput').value,
            location: currentLocation,
            delayed: delayed
          })
        });

        const data = await res.json();
        if (data.success) {
          document.getElementById('mainView').style.display = 'none';
          document.getElementById('successView').style.display = 'flex';
          startStatusCheck();
        } else {
          // 处理限流错误
          if (data.error === 'rate_limit_daily_exceeded') {
            document.getElementById('rateLimitIcon').textContent = '🚫';
            document.getElementById('rateLimitTitle').textContent = '超出每日限制';
            document.getElementById('rateLimitDesc').textContent = data.message || '您今天已发送过多次通知，无法继续发送';
            showModal('rateLimitModal');
          } else if (data.error === 'rate_limit_5min') {
            document.getElementById('rateLimitIcon').textContent = '⏱️';
            document.getElementById('rateLimitTitle').textContent = '操作过于频繁';
            document.getElementById('rateLimitDesc').textContent = data.message || '请5分钟后再试';
            showModal('rateLimitModal');
          } else {
            showToast(data.message || data.error || '发送失败');
          }
          btn.disabled = false;
          btn.innerHTML = '<span>🔔</span><span>通知车主</span>';
        }
      } catch (e) {
        showToast('网络错误，请重试');
        btn.disabled = false;
        btn.innerHTML = '<span>🔔</span><span>通知车主</span>';
      }
    }

    let statusCheckTimer = null;
    function startStatusCheck() {
      if (statusCheckTimer) clearInterval(statusCheckTimer);
      statusCheckTimer = setInterval(checkOwnerStatus, 5000);
      checkOwnerStatus();
    }

    async function checkOwnerStatus() {
      try {
        const res = await fetch('/api/check-status');
        const data = await res.json();

        if (data.status === 'confirmed') {
          clearInterval(statusCheckTimer);
          
          // 如果有车主位置，显示地图卡片
          if (data.ownerLocation) {
            const card = document.getElementById('ownerCard');
            card.classList.remove('hidden');
            document.getElementById('ownerAmapBtn').href = data.ownerLocation.amapUrl;
            document.getElementById('ownerAppleBtn').href = data.ownerLocation.appleUrl;
          }
          
          document.getElementById('checkBtn').disabled = true;
          document.getElementById('checkBtn').innerHTML = '<span>✅</span><span>车主已确认</span>';
          document.getElementById('actionHint').textContent = '车主正在赶来，请稍候...';
          
          // 显示手机号码按钮
          if (data.phone) {
            const phoneBtn = document.getElementById('phoneBtn');
            phoneBtn.href = 'tel:' + data.phone;
            document.getElementById('phoneBtnText').textContent = '拨打电话: ' + data.phone;
            phoneBtn.classList.remove('hidden');
          }
        }
      } catch (e) {
        console.error('Check status error:', e);
      }
    }

    if (localStorage.getItem('locationTipShown') !== 'true') {
      showModal('locationTipModal');
      localStorage.setItem('locationTipShown', 'true');
    }

    // 如果该IP在10分钟内有确认记录，直接显示成功页面
    if (${showSuccessView}) {
      document.getElementById('mainView').style.display = 'none';
      document.getElementById('successView').style.display = 'flex';
      startStatusCheck();
    }
  </script>
</body>
</html>`;
}

function renderOwnerPage(origin) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes, viewport-fit=cover">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="theme-color" content="#0093E9">
  <title>车主确认</title>
  <style>
    :root {
      --sat: env(safe-area-inset-top, 0px);
      --sar: env(safe-area-inset-right, 0px);
      --sab: env(safe-area-inset-bottom, 0px);
      --sal: env(safe-area-inset-left, 0px);
    }
    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; margin: 0; padding: 0; }
    html { font-size: 16px; -webkit-text-size-adjust: 100%; }
    html, body { height: 100%; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Roboto, sans-serif;
      background: linear-gradient(160deg, #0093E9 0%, #80D0C7 100%);
      min-height: 100vh;
      min-height: -webkit-fill-available;
      padding: clamp(16px, 4vw, 24px);
      padding-top: calc(clamp(16px, 4vw, 24px) + var(--sat));
      padding-bottom: calc(clamp(16px, 4vw, 24px) + var(--sab));
      padding-left: calc(clamp(16px, 4vw, 24px) + var(--sal));
      padding-right: calc(clamp(16px, 4vw, 24px) + var(--sar));
      display: flex;
      justify-content: center;
      align-items: flex-start;
    }
    body::before {
      content: ''; position: fixed; inset: 0;
      background: url("data:image/svg+xml,%3Csvg width='52' height='26' viewBox='0 0 52 26' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='0.1'%3E%3Cpath d='M10 10c0-2.21-1.79-4-4-4-3.314 0-6-2.686-6-6h2c0 2.21 1.79 4 4 4 3.314 0 6 2.686 6 6 0 2.21 1.79 4 4 4 3.314 0 6 2.686 6 6 0 2.21 1.79 4 4 4v2c-3.314 0-6-2.686-6-6 0-2.21-1.79-4-4-4-3.314 0-6-2.686-6-6zm25.464-1.95l8.486 8.486-1.414 1.414-8.486-8.486 1.414-1.414z' /%3E%3C/g%3E%3C/g%3E%3C/svg%3E");
      z-index: -1;
    }
    .container {
      width: 100%;
      max-width: 500px;
      display: flex;
      flex-direction: column;
      gap: clamp(12px, 3vw, 20px);
    }
    .card {
      background: rgba(255, 255, 255, 0.95);
      border-radius: clamp(20px, 5vw, 28px);
      padding: clamp(18px, 4vw, 28px);
      box-shadow: 0 10px 40px rgba(0, 147, 233, 0.2);
    }
    .header {
      text-align: center;
      padding: clamp(20px, 5vw, 32px) clamp(16px, 4vw, 28px);
      background: white;
    }
    .icon-wrap {
      width: clamp(72px, 18vw, 100px);
      height: clamp(72px, 18vw, 100px);
      background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
      border-radius: clamp(22px, 5vw, 32px);
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto clamp(14px, 3vw, 24px);
      box-shadow: 0 12px 32px rgba(245, 158, 11, 0.35);
    }
    .icon-wrap span { font-size: clamp(36px, 9vw, 52px); }
    .header h1 {
      font-size: clamp(22px, 5.5vw, 30px);
      font-weight: 700;
      color: #1a202c;
      margin-bottom: 6px;
    }
    .header p {
      font-size: clamp(13px, 3.5vw, 16px);
      color: #718096;
      font-weight: 500;
    }
    .requester-card {
      background: linear-gradient(135deg, #e0f7fa 0%, #b2ebf2 100%);
      border: 2px solid #80cbc4;
    }
    .requester-card h3 {
      color: #00897b;
      margin-bottom: 12px;
      font-size: clamp(16px, 4vw, 20px);
      text-align: center;
    }
    .map-links {
      display: flex;
      gap: clamp(8px, 2vw, 14px);
      flex-wrap: wrap;
    }
    .map-btn {
      flex: 1;
      min-width: 120px;
      padding: clamp(12px, 3vw, 16px);
      border-radius: clamp(12px, 3vw, 16px);
      text-decoration: none;
      font-weight: 600;
      font-size: clamp(13px, 3.5vw, 15px);
      text-align: center;
      min-height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .map-btn.amap { background: #1890ff; color: white; }
    .map-btn.apple { background: #1d1d1f; color: white; }
    .loc-card {
      display: flex;
      align-items: center;
      gap: clamp(10px, 3vw, 16px);
      padding: clamp(14px, 3.5vw, 22px) clamp(16px, 4vw, 24px);
      cursor: pointer;
      min-height: 64px;
    }
    .loc-icon {
      width: clamp(44px, 11vw, 56px);
      height: clamp(44px, 11vw, 56px);
      border-radius: clamp(14px, 3.5vw, 18px);
      display: flex; align-items: center; justify-content: center;
      font-size: clamp(22px, 5.5vw, 28px);
      transition: all 0.3s;
      flex-shrink: 0;
    }
    .loc-icon.loading { background: #fff3cd; }
    .loc-icon.success { background: #d4edda; }
    .loc-icon.error { background: #f8d7da; }
    .loc-content { flex: 1; min-width: 0; }
    .loc-title {
      font-size: clamp(15px, 4vw, 18px);
      font-weight: 600;
      color: #2d3748;
    }
    .loc-status {
      font-size: clamp(12px, 3.2vw, 14px);
      color: #718096;
      margin-top: 3px;
    }
    .loc-status.success { color: #28a745; }
    .loc-status.error { color: #dc3545; }
    .loc-retry-btn {
      color: #0093E9;
      text-decoration: underline;
      cursor: pointer;
      margin-left: 8px;
      font-weight: 600;
    }
    .loc-refresh {
      font-size: clamp(20px, 5vw, 26px);
      color: #a0aec0;
      flex-shrink: 0;
    }
    .btn-main {
      background: linear-gradient(135deg, #0093E9 0%, #80D0C7 100%);
      color: white;
      border: none;
      padding: clamp(16px, 4vw, 22px);
      border-radius: clamp(16px, 4vw, 22px);
      font-size: clamp(16px, 4.2vw, 20px);
      font-weight: 700;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 10px;
      box-shadow: 0 10px 30px rgba(0, 147, 233, 0.35);
      transition: all 0.2s;
      min-height: 56px;
      width: 100%;
    }
    .btn-main:active { transform: scale(0.98); }
    .btn-main:disabled {
      background: linear-gradient(135deg, #94a3b8 0%, #64748b 100%);
      box-shadow: none;
      cursor: not-allowed;
    }
    .btn-secondary {
      background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
      color: #64748b;
      box-shadow: none;
    }
    .toast {
      position: fixed;
      top: calc(20px + var(--sat));
      left: 50%;
      transform: translateX(-50%) translateY(-100px);
      background: white;
      padding: clamp(12px, 3vw, 16px) clamp(20px, 5vw, 32px);
      border-radius: 16px;
      font-size: clamp(14px, 3.5vw, 16px);
      font-weight: 600;
      color: #2d3748;
      box-shadow: 0 10px 40px rgba(0,0,0,0.15);
      opacity: 0;
      transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      z-index: 100;
      max-width: calc(100vw - 40px);
    }
    .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .success-view { display: none; }
    .success-card {
      text-align: center;
      background: linear-gradient(135deg, #d4edda 0%, #c3e6cb 100%);
      border: 2px solid #28a745;
    }
    .success-icon {
      font-size: clamp(56px, 14vw, 80px);
      margin-bottom: clamp(12px, 3vw, 20px);
      display: block;
    }
    .success-card h2 {
      color: #155724;
      margin-bottom: 8px;
      font-size: clamp(20px, 5vw, 28px);
    }
    .success-card p {
      color: #1e7e34;
      font-size: clamp(14px, 3.5vw, 16px);
    }
    @media (min-width: 768px) {
      body { align-items: center; }
      .container { max-width: 480px; }
    }
    @media (min-width: 1024px) {
      .container { max-width: 520px; }
      .card { padding: 32px; }
    }
    @media (orientation: landscape) and (max-height: 500px) {
      body {
        align-items: flex-start;
        padding-top: calc(12px + var(--sat));
      }
      .header { padding: 16px; }
      .icon-wrap {
        width: 60px;
        height: 60px;
        margin-bottom: 12px;
      }
      .icon-wrap span { font-size: 32px; }
      .success-icon {
        font-size: 48px;
        margin-bottom: 10px;
      }
    }
  </style>
</head>
<body>
  <div id="toast" class="toast"></div>

  <div class="container" id="mainView">
    <div class="card header">
      <div class="icon-wrap"><span>🚨</span></div>
      <h1>有人请求挪车</h1>
      <p>请查看请求者位置并确认</p>
    </div>

    <div class="card requester-card" id="requesterCard">
      <h3>📍 请求者位置</h3>
      <div class="map-links">
        <a href="#" class="map-btn amap" id="requesterAmapBtn">高德地图</a>
        <a href="#" class="map-btn apple" id="requesterAppleBtn">苹果地图</a>
      </div>
    </div>

    <div class="card loc-card" onclick="requestLocation()">
      <div class="loc-icon" id="locIcon">📍</div>
      <div class="loc-content">
        <div class="loc-title">分享我的位置</div>
        <div class="loc-status" id="locStatus">点击获取位置（可选）</div>
      </div>
      <div class="loc-refresh" id="locRefresh"></div>
    </div>

    <button class="btn-main" id="confirmBtn" onclick="handleConfirm()">
      <span>✅</span>
      <span>确认并分享位置</span>
    </button>
    <button class="btn-main btn-secondary" onclick="handleConfirmWithoutLocation()">
      <span>👌</span>
      <span>仅确认（不分享位置）</span>
    </button>
  </div>

  <div class="container success-view" id="successView">
    <div class="card success-card">
      <span class="success-icon">✅</span>
      <h2>已确认</h2>
      <p>请求者已收到您的确认信息</p>
    </div>
  </div>

  <script>
    let currentLocation = null;
    let locationStatus = 'pending';

    function showToast(msg) {
      const toast = document.getElementById('toast');
      toast.textContent = msg;
      toast.classList.add('show');
      setTimeout(() => toast.classList.remove('show'), 2500);
    }

    function requestLocation() {
      if (!navigator.geolocation) {
        showToast('您的浏览器不支持定位');
        return;
      }

      const icon = document.getElementById('locIcon');
      const status = document.getElementById('locStatus');
      const refresh = document.getElementById('locRefresh');

      icon.className = 'loc-icon loading';
      icon.textContent = '⏳';
      status.textContent = '正在获取位置...';
      status.className = 'loc-status';
      refresh.textContent = '';
      locationStatus = 'loading';

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          currentLocation = {
            lat: pos.coords.latitude,
            lng: pos.coords.longitude
          };
          icon.className = 'loc-icon success';
          icon.textContent = '✅';
          status.textContent = '位置获取成功';
          status.className = 'loc-status success';
          refresh.textContent = '🔄';
          locationStatus = 'success';
        },
        (err) => {
          icon.className = 'loc-icon error';
          icon.textContent = '❌';
          status.innerHTML = '获取失败<span class="loc-retry-btn" onclick="event.stopPropagation();requestLocation()">重试</span>';
          status.className = 'loc-status error';
          refresh.textContent = '';
          locationStatus = 'error';
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    }

    async function handleConfirm() {
      if (locationStatus !== 'success') {
        requestLocation();
        return;
      }
      await sendConfirm(currentLocation);
    }

    async function handleConfirmWithoutLocation() {
      await sendConfirm(null);
    }

    async function sendConfirm(location) {
      const btn = document.getElementById('confirmBtn');
      btn.disabled = true;
      btn.innerHTML = '<span>⏳</span><span>处理中...</span>';

      try {
        const res = await fetch('/api/owner-confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location })
        });

        const data = await res.json();
        if (data.success) {
          document.getElementById('mainView').style.display = 'none';
          document.getElementById('successView').style.display = 'flex';
        } else {
          showToast(data.error || '确认失败');
          btn.disabled = false;
          btn.innerHTML = '<span>✅</span><span>确认并分享位置</span>';
        }
      } catch (e) {
        showToast('网络错误，请重试');
        btn.disabled = false;
        btn.innerHTML = '<span>✅</span><span>确认并分享位置</span>';
      }
    }

    async function loadRequesterLocation() {
      try {
        const res = await fetch('/api/get-location');
        if (res.ok) {
          const data = await res.json();
          if (data.amapUrl && data.appleUrl) {
            document.getElementById('requesterAmapBtn').href = data.amapUrl;
            document.getElementById('requesterAppleBtn').href = data.appleUrl;
          } else {
            // 如果没有位置信息，隐藏请求者位置卡片
            document.getElementById('requesterCard').style.display = 'none';
          }
        } else {
          // 请求失败时也隐藏
          document.getElementById('requesterCard').style.display = 'none';
        }
      } catch (e) {
        console.error('Load location error:', e);
        // 出错时隐藏请求者位置卡片
        document.getElementById('requesterCard').style.display = 'none';
      }
    }

    loadRequesterLocation();
  </script>
</body>
</html>`;
}

async function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const path = parsedUrl.pathname;
  const origin = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

  if (config.security.enableGeoCheck && config.security.allowedCountries) {
    const country = req.headers['cf-ipcountry'] || req.headers['x-country-code'];
    if (country && !config.security.allowedCountries.includes(country)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      return res.end('Access Denied');
    }
  }

  if (path === '/api/notify' && req.method === 'POST') {
    return handleNotify(req, res, origin);
  }

  if (path === '/api/get-location') {
    return handleGetLocation(req, res);
  }

  if (path === '/api/owner-confirm' && req.method === 'POST') {
    return handleOwnerConfirm(req, res);
  }

  if (path === '/api/check-status') {
    return handleCheckStatus(req, res);
  }

  if (path === '/owner-confirm') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(renderOwnerPage(origin));
  }

  // 检查该IP是否在10分钟内有确认记录
  const clientIP = getClientIP(req);
  const ipConfirmedRecently = await storage.isIPConfirmedRecently(clientIP);
  
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderMainPage(origin, ipConfirmedRecently));
}

const server = http.createServer(handleRequest);

server.listen(config.server.port, config.server.host, () => {
  // 容器启动时清除所有IP确认缓存
  storage.clearAllIPConfirmations();
  
  console.log(`MoveCar server running at http://${config.server.host}:${config.server.port}`);
  console.log(`BARK_URL configured: ${config.bark.url ? 'Yes' : 'No'}`);
  console.log(`PHONE_NUMBER configured: ${config.phone.number ? 'Yes' : 'No'}`);
  console.log(`CAR_NUMBER configured: ${config.car.number ? 'Yes' : 'No'}`);
  console.log(`RATE_LIMIT_5MIN configured: ${config.rateLimit.maxRequestsPer5Min}`);
  console.log(`RATE_LIMIT_DAILY configured: ${config.rateLimit.maxRequestsPerDay}`);
  console.log(`RECORD_TIME configured: ${config.ipConfirmation.recordTime}s`);
  console.log(`IP confirmation cache cleared on startup`);
});
