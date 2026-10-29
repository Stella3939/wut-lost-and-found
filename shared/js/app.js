// app.js —— 路由、页面渲染与交互逻辑

const app = document.getElementById('app');

const MODULE_NAMES = { found: '捡到东西', lost: '需要找东西' };

// 列表页状态（从详情页返回时保留筛选与搜索）
const listState = { module: 'found', dim: 'category', filter: '', keyword: '', fuzzy: false };

// ---------- 小工具 ----------
// 把用户输入转义后再放进 HTML，避免特殊字符破坏页面
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtTime(iso) {
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function byTimeDesc(a, b) { return new Date(b.time) - new Date(a.time); }

function statusBadge(status) {
  return status === 'found'
    ? '<span class="badge found">🏠 已找到</span>'
    : '<span class="badge waiting">⏳ 等待中</span>';
}

function itemCard(it) {
  return '<a class="item-card" href="#/detail/' + it.id + '">'
    + '<img class="item-thumb" src="' + esc(it.image) + '" alt="' + esc(it.name) + '">'
    + '<div class="item-body">'
    + '<div class="item-name">' + esc(it.name) + statusBadge(it.status) + '</div>'
    + '<div class="item-tags"><span class="tag">' + esc(it.category) + '</span><span class="tag">' + esc(it.campus) + '</span></div>'
    + '<div class="item-meta">📍' + esc(it.location || '地点未填写') + ' · ' + fmtTime(it.time) + '</div>'
    + '</div></a>';
}

function emptyHtml(text) {
  return '<div class="empty"><div class="empty-emoji">🕊️</div>' + esc(text || '这里还空空的') + '</div>';
}

// 轻提示
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('show'), 10);
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, 1800);
}

// 复制文本到剪贴板（file:// 下剪贴板 API 可能受限，附兜底方案）
function copyText(text, msg) {
  const done = function () { showToast(msg || '已复制到剪贴板'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch (e) {
    showToast('复制失败，请长按手动复制');
  }
  ta.remove();
}

// 读取并压缩上传的图片，避免超出 localStorage 容量
function readImage(file, cb) {
  const reader = new FileReader();
  reader.onload = function () {
    const img = new Image();
    img.onload = function () {
      const MAX = 900; // 最长边上限
      if (img.width <= MAX && img.height <= MAX && file.size < 400 * 1024) {
        cb(reader.result);
        return;
      }
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      cb(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

// ---------- 隐私保护（证件类物品打码） ----------
// 判断是否为涉及个人隐私的物品（证件类，或名称含敏感词）
function isSensitive(name, category) {
  if (category === '证件卡品类') return true;
  return SENSITIVE_KEYWORDS.some(k => (name || '').indexOf(k) !== -1);
}

// 在画布上按住拖动：把涂抹区域缩小再放大，形成马赛克打码
function bindPixelate(canvas, ctx) {
  let painting = false;
  const R = 16; // 打码笔刷半径（图片像素）
  function pos(e) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height)
    };
  }
  function mosaic(x, y) {
    const s = Math.max(2, Math.round(R / 4)); // 缩小到的尺寸
    const tmp = document.createElement('canvas');
    tmp.width = s;
    tmp.height = s;
    tmp.getContext('2d').drawImage(canvas, x - R, y - R, R * 2, R * 2, 0, 0, s, s);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, s, s, x - R, y - R, R * 2, R * 2);
    ctx.imageSmoothingEnabled = true;
    canvas.dataset.dirty = '1'; // 标记已打码，发布时保存画布内容
  }
  canvas.addEventListener('pointerdown', function (e) {
    painting = true;
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    mosaic(p.x, p.y);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!painting) return;
    const p = pos(e);
    mosaic(p.x, p.y);
  });
  canvas.addEventListener('pointerup', function () { painting = false; });
  canvas.addEventListener('pointercancel', function () { painting = false; });
}

// ---------- AI 拍照识别（演示版：真实提取图片主色 + 规则库推荐名称） ----------
// 真实部署可替换为多模态大模型视觉 API（如 GLM-4V 等），交互流程不变
const AI_NAMES = {
  '电子数码类': ['充电宝', '耳机', '手机', '电子手表', 'U盘', '数据线'],
  '证件卡品类': ['校园卡', '证件卡片', '银行卡'],
  '学习用具类': ['笔记本', '课本', '钢笔', '文具盒'],
  '生活用具类': ['水杯', '雨伞', '眼镜', '钥匙', '外套'],
  '其他类': ['小物件', '包裹', '玩偶']
};
const AI_COLOR_NAMES = ['电子数码类', '生活用具类', '其他类']; // 名称适合带颜色前缀的分类

const COLOR_PALETTE = [
  ['黑', '#222222'], ['深灰', '#666666'], ['白', '#f2f2f2'], ['灰', '#9a9a9a'],
  ['红', '#c0392b'], ['橙', '#e67e22'], ['黄', '#f1c40f'], ['绿', '#27ae60'],
  ['蓝', '#2980b9'], ['紫', '#8e44ad'], ['棕', '#8b5a2b'], ['粉', '#e87ba4']
];

function nearestColor(r, g, b) {
  let best = COLOR_PALETTE[0];
  let bd = Infinity;
  COLOR_PALETTE.forEach(function (p) {
    const hex = p[1].replace('#', '');
    const pr = parseInt(hex.slice(0, 2), 16);
    const pg = parseInt(hex.slice(2, 4), 16);
    const pb = parseInt(hex.slice(4, 6), 16);
    const d = (r - pr) * (r - pr) + (g - pg) * (g - pg) + (b - pb) * (b - pb);
    if (d < bd) { bd = d; best = p; }
  });
  return best;
}

// 提取图片主色：把图片缩到 24×24 再统计像素颜色
function colorExtract(data, cb) {
  const img = new Image();
  img.onload = function () {
    const c = document.createElement('canvas');
    c.width = 24;
    c.height = 24;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, 24, 24);
    let pixels;
    try {
      pixels = ctx.getImageData(0, 0, 24, 24).data;
    } catch (e) {
      cb([{ name: '未知', hex: '#999999', pct: 100 }]);
      return;
    }
    const counts = {};
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] < 100) continue; // 跳过透明像素
      const name = nearestColor(pixels[i], pixels[i + 1], pixels[i + 2])[0];
      counts[name] = (counts[name] || 0) + 1;
    }
    const total = Object.keys(counts).reduce(function (s, k) { return s + counts[k]; }, 0) || 1;
    const result = Object.keys(counts).map(function (k) {
      const p = COLOR_PALETTE.find(x => x[0] === k);
      return { name: k, hex: p[1], pct: Math.round(counts[k] / total * 100) };
    }).sort(function (a, b) { return b.pct - a.pct; }).slice(0, 2);
    cb(result);
  };
  img.src = data;
}

// 根据分类与主色生成候选名称（本地模拟识别的"语义"部分）
function suggestNames(category, color) {
  const dict = AI_NAMES[category] || AI_NAMES['其他类'];
  return dict.map(function (n) {
    return AI_COLOR_NAMES.indexOf(category) !== -1 ? color + n : n;
  });
}

// ---------- 真 AI 识别（智谱 GLM-4V-Flash，免费视觉大模型） ----------
// 设计原则：API Key 只保存在用户自己的浏览器 localStorage 里，永不进入代码仓库；
// 未配置 Key 时自动退回本地模拟识别，网站功能不受影响。
const AI_KEY_STORAGE = 'wutlf_ai_key';

function getAiKey() {
  return storage.getItem(AI_KEY_STORAGE) || '';
}
function setAiKey(key) {
  storage.setItem(AI_KEY_STORAGE, key);
}
function clearAiKey() {
  storage.setItem(AI_KEY_STORAGE, '');
}

// 调用 GLM-4V-Flash 识别图片，返回 {name, color, desc}
function callGLM4V(imageDataUrl, key, cb) {
  const body = {
    model: 'glm-4v-flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imageDataUrl } },
        { type: 'text', text: '你是失物招领平台的识别助手。请根据图片识别物品，只输出一个 JSON 对象（不要输出任何其他文字）：{"name":"物品中文名","color":"主要颜色","desc":"一句话外观描述"}' }
      ]
    }]
  };
  fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body)
  }).then(function (r) { return r.json(); }).then(function (j) {
    if (j && j.error) { cb(false, j.error.message || '调用失败'); return; }
    const text = (j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    let obj = null;
    try {
      obj = JSON.parse(text);
    } catch (e) {
      const mm = text.match(/\{[\s\S]*\}/);
      if (mm) {
        try { obj = JSON.parse(mm[0]); } catch (e2) { /* 解析失败走下方兜底 */ }
      }
    }
    if (obj && obj.name) cb(true, obj);
    else cb(false, '识别结果解析失败');
  }).catch(function (err) {
    cb(false, (err && err.message) ? err.message : '网络错误');
  });
}

// 测试 Key 是否有效（纯文本请求，不消耗图片额度）
function testAiKey(key, cb) {
  fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: 'glm-4v-flash',
      messages: [{ role: 'user', content: '只回复两个字：正常' }],
      max_tokens: 10
    })
  }).then(function (r) { return r.json(); }).then(function (j) {
    cb(!j.error);
  }).catch(function () { cb(false); });
}

// ---------- 智能撮合（捡到/寻找双向匹配，演示版语义匹配引擎） ----------
let lastPublished = null; // 最近发布的信息（用于列表页撮合提示）

// 同义词组：双方名称命中同一组即视为同一类物品
const SYNONYMS = {
  '充电宝': ['充电宝', '移动电源', '充电器'],
  '耳机': ['耳机', '耳麦'],
  '水杯': ['水杯', '杯子', '保温杯', '水瓶'],
  '雨伞': ['雨伞', '伞'],
  '校园卡': ['校园卡', '学生卡', '一卡通', '饭卡'],
  '手机': ['手机', '电话'],
  '钥匙': ['钥匙', '钥匙串'],
  '证件': ['学生证', '身份证', '证件']
};

// 匹配度打分：品类 + 名称/同义词 + 区域 + 时间窗
function matchScore(a, b) {
  let s = 0;
  if (a.category === b.category) s += 40;
  if (a.name === b.name) s += 30;
  else {
    const groups = Object.keys(SYNONYMS).map(function (k) { return SYNONYMS[k]; });
    for (let i = 0; i < groups.length; i++) {
      const hitA = groups[i].some(function (w) { return a.name.indexOf(w) !== -1; });
      const hitB = groups[i].some(function (w) { return b.name.indexOf(w) !== -1; });
      if (hitA && hitB) { s += 20; break; }
    }
  }
  if (a.campus === b.campus) s += 15;
  const dt = Math.abs(new Date(a.time) - new Date(b.time)) / 86400000;
  if (dt <= 1) s += 15;
  else if (dt <= 7) s += 10;
  return Math.min(s, 100);
}

function getMatches(item, limit) {
  const others = getItems().filter(function (it) {
    return it.module !== item.module && it.status === 'waiting';
  });
  return others.map(function (it) { return { item: it, score: matchScore(item, it) }; })
    .filter(function (m) { return m.score >= 60; })
    .sort(function (a, b) { return b.score - a.score; })
    .slice(0, limit || 2);
}

function matchSectionHtml(it) {
  if (it.status !== 'waiting') return '';
  const matches = getMatches(it, 2);
  if (!matches.length) return '';
  const other = it.module === 'found' ? '寻找' : '捡到';
  return '<div class="match-section">'
    + '<div class="match-title">🤖 智能撮合 · 可能匹配的' + other + '信息</div>'
    + matches.map(function (m) {
        return '<a class="match-card" href="#/detail/' + m.item.id + '">'
          + '<div class="match-head"><span class="match-name">' + esc(m.item.name) + '</span>'
          + '<span class="match-score">' + m.score + '%</span></div>'
          + '<div class="match-meta">' + esc(m.item.campus) + ' · ' + fmtTime(m.item.time) + '</div>'
          + '<div class="match-bar"><i style="width:' + m.score + '%"></i></div>'
          + '</a>';
      }).join('')
    + '</div>';
}

function matchBannerHtml(module) {
  if (!lastPublished || lastPublished.module !== module) return '';
  const matches = getMatches(lastPublished, 3);
  if (!matches.length) return '';
  return '<a class="match-banner" href="#/detail/' + lastPublished.id + '">🔔 智能撮合：你刚发布的信息检测到 '
    + matches.length + ' 条可能匹配的信息（最高 ' + matches[0].score + '% 匹配度）→</a>';
}

// ---------- 数据看板（B 端管理方视角） ----------
const VIZ_HOURS = ['8-10点', '10-12点', '12-14点', '14-16点', '16-18点', '18-20点', '20-22点', '22-24点'];

function hourCountsOf(items) {
  return VIZ_HOURS.map(function (label, i) {
    const lo = 8 + i * 2;
    const hi = lo + 2;
    return {
      label: label,
      n: items.filter(function (it) {
        const h = new Date(it.time).getHours();
        return h >= lo && h < hi;
      }).length
    };
  });
}

// 热力色阶（0 件 → 最多件，蓝阶由浅到深）
function heatStepOf(maxN) {
  return function (n) {
    if (n === 0) return 'hs0';
    return 'hs' + Math.min(5, Math.max(1, Math.ceil(n / maxN * 5)));
  };
}

// 地图图例（色阶条）
function mapLegendHtml() {
  return '<div class="map-legend"><span>0 件</span>'
    + ['#EEF2F6', '#86b6ef', '#5598e7', '#2a78d6', '#1c5cab', '#104281'].map(function (c) {
        return '<i style="background:' + c + '"></i>';
      }).join('')
    + '<span>最多</span></div>';
}

// 平面 SVG 热力地图（"地图即配置"：多边形路径来自 config.js）
function flatMapSvg(areaCounts, heatStep, m) {
  const vb = (m.viewBox || '0 0 600 420').split(' ');
  const w = Number(vb[2]);
  const h = Number(vb[3]);
  return '<svg class="map-svg" viewBox="' + m.viewBox + '" preserveAspectRatio="xMidYMid meet">'
    + '<rect class="map-bg" x="0" y="0" width="' + w + '" height="' + h + '" rx="14"/>'
    + '<path class="map-road" d="M0,110 C150,100 450,120 600,105"/>'
    + '<path class="map-road" d="M0,310 C160,320 420,300 600,315"/>'
    + '<path class="map-road" d="M300,0 C310,140 290,280 305,420"/>'
    + areaCounts.map(function (x) {
        const p = (m.paths || {})[x.area];
        if (!p) return '';
        const cls = heatStep(x.n);
        const ink = (cls === 'hs0' || cls === 'hs1' || cls === 'hs2') ? '#2B3A4A' : '#FFFFFF';
        return '<path class="map-area ' + cls + '" data-area="' + esc(x.area) + '" d="' + p.d + '"/>'
          + '<text class="map-label" x="' + p.label[0] + '" y="' + p.label[1] + '" fill="' + ink + '">' + esc(x.area) + '</text>'
          + '<text class="map-count" x="' + p.label[0] + '" y="' + (p.label[1] + 16) + '" fill="' + ink + '">' + x.n + ' 件</text>';
      }).join('')
    + '</svg>';
}

// 立体楼层堆叠（2.5D，适合商场/写字楼；真实部署可升级 Three.js 3D 模型）
function stackHtml(areaCounts, heatStep, m) {
  const gap = m.floorGap || 36;
  return '<div class="stack-scene"><div class="stack-stage">'
    + areaCounts.map(function (x, i) {
        const cls = heatStep(x.n);
        const ink = (cls === 'hs0' || cls === 'hs1' || cls === 'hs2') ? '#2B3A4A' : '#FFFFFF';
        return '<div class="stack-floor ' + cls + '" data-area="' + esc(x.area) + '" style="--z:' + (i * gap) + 'px;color:' + ink + '">'
          + '<div class="stack-name">' + esc(x.area) + '</div>'
          + '<div class="stack-count">' + x.n + ' 件</div>'
          + '</div>';
      }).join('')
    + '</div><div class="stack-hint">各层热力一目了然 · 点击楼层查看详情</div></div>';
}

// 热力色阶对应的十六进制（高德多边形 / Three.js 楼板共用）
const HEAT_HEX = { hs0: '#EEF2F6', hs1: '#86b6ef', hs2: '#5598e7', hs3: '#2a78d6', hs4: '#1c5cab', hs5: '#104281' };

// 高德真实地图渲染：区域导航 + 图层开关 + 热力多边形 + 物品点位（真实部署需申请免费 Key 并绑定域名白名单）
function renderAmap(mapArea, areaCounts, heatStep, m, mapPanel) {
  mapArea.innerHTML =
    '<div class="map-chips" id="map-chips"></div>'
    + '<div class="map-toggles">'
    + '<label><input type="checkbox" id="tg-heat" checked> 区域热力</label>'
    + '<label><input type="checkbox" id="tg-dots" checked> 物品点位</label>'
    + '</div>'
    + '<div class="amap-box" id="amap-box"></div>';
  const box = document.getElementById('amap-box');

  if (!m.amapKey || !m.amapJsCode) {
    box.innerHTML = '<div class="empty" style="padding:60px 20px"><div class="empty-emoji">🗺️</div>尚未配置高德地图 Key<br>（在 js/config.js 填入 amapKey 与 amapJsCode 即可显示真实地图）</div>';
    return;
  }
  window._AMapSecurityConfig = { securityJsCode: m.amapJsCode };
  if (window.AMap) { buildAmap(); return; }
  const s = document.createElement('script');
  // 强制浏览器向高德发送来源域名（白名单校验需要；微信内置浏览器等环境可能默认剥掉）
  s.setAttribute('referrerpolicy', 'origin');
  s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + m.amapKey;
  s.onload = buildAmap;
  s.onerror = function () {
    box.innerHTML = '<div class="empty" style="padding:60px 20px">地图加载失败，请检查网络或 Key 配置</div>';
  };
  document.head.appendChild(s);

  let heatPolys = [];  // 热力多边形 + 远校区标记（受"区域热力"开关控制）
  let dotMarkers = []; // 物品点位（受"物品点位"开关控制）
  let map = null;      // 高德地图实例（buildAmap 内创建，供 flyTo 等使用）

  function buildAmap() {
    map = new window.AMap.Map(box, {
      zoom: m.zoom || 14,
      center: m.center || [114.35, 30.52]
    });

    // 区域热力多边形
    (m.polygons || []).forEach(function (p) {
      const x = areaCounts.find(function (t) { return t.area === p.area; });
      if (!x) return;
      const poly = new window.AMap.Polygon({
        path: p.path,
        fillColor: HEAT_HEX[heatStep(x.n)],
        fillOpacity: 0.55,
        strokeColor: '#FFFFFF',
        strokeWeight: 2
      });
      poly.setMap(map);
      poly.on('click', function () {
        showAreaPanel(p.area);
        map.setCenter(p.path[0]);
      });
      heatPolys.push(poly);
    });

    // 远校区标记点
    (m.markers || []).forEach(function (mk) {
      const x = areaCounts.find(function (t) { return t.area === mk.area; });
      if (!x) return;
      const marker = new window.AMap.Marker({ position: mk.lnglat, title: mk.area });
      marker.setMap(map);
      marker.on('click', function () {
        showAreaPanel(mk.area);
        map.setZoomAndCenter(15, mk.lnglat);
      });
      heatPolys.push(marker);
    });

    // 物品点位层：绿点=捡到，橙点=寻找，点击进详情
    drawDots();
    function drawDots() {
      dotMarkers.forEach(function (o) { o.setMap(null); });
      dotMarkers = [];
      getItems().filter(function (it) { return it.status === 'waiting'; }).forEach(function (it) {
        const c = it.lnglat || jitter(areaCenter(it.campus), it.id);
        const dot = new window.AMap.CircleMarker({
          center: c,
          radius: 7,
          fillColor: it.module === 'found' ? '#3FA96F' : '#E8933A',
          fillOpacity: 0.9,
          strokeColor: '#FFFFFF',
          strokeWeight: 1.5,
          zIndex: 100,
          title: it.name
        });
        dot.setMap(map);
        dot.on('click', function () {
          location.hash = '#/detail/' + it.id;
        });
        dotMarkers.push(dot);
      });
    }

    // 区域导航：点击直接飞过去（解决远校区不在默认视野的问题）
    const chips = document.getElementById('map-chips');
    chips.innerHTML = '<span class="map-chip" data-fly="all">🔍 全览</span>'
      + areaCounts.map(function (x) {
          return '<span class="map-chip" data-fly="' + esc(x.area) + '">📍 ' + esc(x.area) + '</span>';
        }).join('');
    chips.querySelectorAll('.map-chip').forEach(function (c) {
      c.addEventListener('click', function () { flyTo(c.dataset.fly); });
    });

    // 图层开关
    document.getElementById('tg-heat').addEventListener('change', function (e) {
      heatPolys.forEach(function (o) { o.setMap(e.target.checked ? map : null); });
    });
    document.getElementById('tg-dots').addEventListener('change', function (e) {
      dotMarkers.forEach(function (o) { o.setMap(e.target.checked ? map : null); });
    });
  }

  // 区域中心：优先取多边形质心，其次取标记点
  function areaCenter(area) {
    const p = (m.polygons || []).find(function (t) { return t.area === area; });
    if (p) {
      const xs = p.path.map(function (q) { return q[0]; });
      const ys = p.path.map(function (q) { return q[1]; });
      return [
        (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2,
        (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2
      ];
    }
    const mk = (m.markers || []).find(function (t) { return t.area === area; });
    return mk ? mk.lnglat : (m.center || [114.35, 30.52]);
  }

  // 无坐标的物品按 id 在区域中心附近散开，避免重叠
  function jitter(center, id) {
    const r = 0.004;
    const a = (id * 137.5) % 360 * Math.PI / 180;
    const k = (id % 3 + 1) / 3;
    return [center[0] + Math.cos(a) * r * k, center[1] + Math.sin(a) * r * k];
  }

  function flyTo(area) {
    if (!map) return;
    if (area === 'all') {
      // 全览：视野装下所有热力图形与点位
      const overlays = heatPolys.concat(dotMarkers);
      if (overlays.length) map.setFitView(overlays, false, [60, 60, 60, 60]);
      return;
    }
    map.setZoomAndCenter(15, areaCenter(area));
  }

  function showAreaPanel(area) {
    const x = areaCounts.find(function (t) { return t.area === area; });
    mapPanel.innerHTML = '<div class="map-panel">📍 <b>' + esc(area) + '</b>：等待 '
      + x.n + ' 件 · 已找到 ' + x.f + ' 件'
      + ' <button class="map-go" type="button" data-area="' + esc(area) + '">在「捡到东西」中查看 →</button></div>';
    mapPanel.querySelector('.map-go').addEventListener('click', function () {
      goAreaList(area);
    });
  }
}

// Three.js 立体楼宇渲染（商场等建筑场景：可旋转缩放、点击楼层看数据）
let threeState = null; // 保存实例，重复渲染前先清理

function renderThree3d(box, areaCounts, heatStep, m, mapPanel) {
  if (!window.THREE) {
    box.innerHTML = '<div class="empty" style="padding:60px 20px">Three.js 加载失败，请刷新重试</div>';
    return;
  }
  const b = m.building || { width: 3.2, depth: 2.2, height: 0.34, gap: 0.12 };
  const W = b.width, D = b.depth, H = b.height, G = b.gap;

  const scene = new window.THREE.Scene();
  scene.background = new window.THREE.Color('#F2F7FC');
  const camera = new window.THREE.PerspectiveCamera(45, (box.clientWidth || 340) / (box.clientHeight || 320), 0.1, 100);
  camera.position.set(6, 5, 7);
  camera.lookAt(0, 1.2, 0);
  const renderer = new window.THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(box.clientWidth || 340, box.clientHeight || 320);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  box.appendChild(renderer.domElement);

  scene.add(new window.THREE.AmbientLight('#ffffff', 0.85));
  const dir = new window.THREE.DirectionalLight('#ffffff', 1.1);
  dir.position.set(5, 10, 4);
  scene.add(dir);

  const group = new window.THREE.Group();
  scene.add(group);

  // 每层一块楼板，按失物密度着色
  const floors = [];
  areaCounts.forEach(function (x, i) {
    const geo = new window.THREE.BoxGeometry(W, H, D);
    const mat = new window.THREE.MeshLambertMaterial({
      color: new window.THREE.Color(HEAT_HEX[heatStep(x.n)]),
      transparent: true,
      opacity: 0.92
    });
    const mesh = new window.THREE.Mesh(geo, mat);
    mesh.position.y = i * (H + G) + H / 2;
    mesh.userData.area = x.area;
    group.add(mesh);
    const edges = new window.THREE.LineSegments(
      new window.THREE.EdgesGeometry(geo),
      new window.THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })
    );
    mesh.add(edges);
    floors.push(mesh);
  });

  // 底座
  const base = new window.THREE.Mesh(
    new window.THREE.BoxGeometry(W + 0.5, 0.15, D + 0.5),
    new window.THREE.MeshLambertMaterial({ color: new window.THREE.Color('#CBD9E6') })
  );
  base.position.y = -0.12;
  group.add(base);

  // 交互：拖动旋转 + 滚轮缩放 + 点击选层 + 缓慢自转
  let theta = 0.6, radius = 9, dragging = false, px = 0, raf = 0;
  const dom = renderer.domElement;
  dom.style.cursor = 'grab';
  dom.addEventListener('pointerdown', function (e) {
    dragging = true;
    px = e.clientX;
    if (dom.setPointerCapture) dom.setPointerCapture(e.pointerId);
  });
  dom.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    theta -= (e.clientX - px) * 0.012;
    px = e.clientX;
  });
  dom.addEventListener('pointerup', function () { dragging = false; });
  dom.addEventListener('pointercancel', function () { dragging = false; });
  dom.addEventListener('wheel', function (e) {
    e.preventDefault();
    radius = Math.min(14, Math.max(4, radius + e.deltaY * 0.01));
  }, { passive: false });
  dom.addEventListener('click', function (e) {
    const rect = dom.getBoundingClientRect();
    const mouse = new window.THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const ray = new window.THREE.Raycaster();
    ray.setFromCamera(mouse, camera);
    const hit = ray.intersectObjects(floors, false)[0];
    if (hit) showAreaPanel(hit.object.userData.area);
  });

  function showAreaPanel(area) {
    const x = areaCounts.find(function (t) { return t.area === area; });
    mapPanel.innerHTML = '<div class="map-panel">📍 <b>' + esc(area) + '</b>：等待 '
      + x.n + ' 件 · 已找到 ' + x.f + ' 件'
      + ' <button class="map-go" type="button" data-area="' + esc(area) + '">在「捡到东西」中查看 →</button></div>';
    mapPanel.querySelector('.map-go').addEventListener('click', function () {
      goAreaList(area);
    });
  }

  function animate() {
    raf = requestAnimationFrame(animate);
    if (!dragging) theta += 0.003; // 空闲时缓慢自转
    camera.position.set(radius * Math.sin(theta), 4.6, radius * Math.cos(theta));
    camera.lookAt(0, 1.2, 0);
    renderer.render(scene, camera);
  }
  animate();

  // 记录实例，页面重新渲染前清理动画与画布
  if (threeState && threeState.dispose) threeState.dispose();
  threeState = {
    dispose: function () {
      cancelAnimationFrame(raf);
      renderer.dispose();
      if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  };
}

// 从管理端地图跳转到对应区域的列表
function goAreaList(area) {
  listState.module = 'found';
  listState.dim = 'campus';
  listState.filter = area;
  listState.keyword = '';
  listState.fuzzy = false;
  location.hash = '#/found';
}

// 管理端：数据看板 + 热力地图 + 信息管理（演示模式，真实部署需 RBAC 权限体系）
function renderAdmin() {
  const items = getItems();
  const waiting = items.filter(function (it) { return it.status === 'waiting'; });
  const foundN = items.length - waiting.length;
  const rate = items.length ? Math.round(foundN / items.length * 100) : 0;

  const areaCounts = SITE_CONFIG.areas.map(function (a) {
    return {
      area: a,
      n: waiting.filter(function (it) { return it.campus === a; }).length,
      f: items.filter(function (it) { return it.campus === a && it.status === 'found'; }).length
    };
  });
  const maxN = Math.max(1, Math.max.apply(null, areaCounts.map(function (x) { return x.n; })));
  const heatStep = heatStepOf(maxN);

  const catCounts = SITE_CONFIG.categories.map(function (c, i) {
    return { cat: c, i: i, n: items.filter(function (it) { return it.category === c; }).length };
  });
  const maxCat = Math.max(1, Math.max.apply(null, catCounts.map(function (x) { return x.n; })));

  const hourCounts = hourCountsOf(items);
  const maxH = Math.max(1, Math.max.apply(null, hourCounts.map(function (x) { return x.n; })));

  // 滞留超 10 天的等待中物品
  const stale = waiting.filter(function (it) {
    return (Date.now() - new Date(it.time)) / 86400000 > 10;
  }).sort(byTimeDesc);
  const recentWaiting = waiting.slice().sort(byTimeDesc).slice(0, 8);
  const recentFound = items.filter(function (it) { return it.status === 'found'; }).sort(byTimeDesc).slice(0, 5);

  const m = SITE_CONFIG.map || {};
  const defaultView = (m.mode === 'stack') ? 'stack' : 'flat';

  app.innerHTML =
    '<div class="topbar"><a class="back" href="#/">‹</a><h1>管理端 · ' + esc(SITE_CONFIG.orgName) + '</h1></div>'
    + '<div class="dash-body">'
    + '<div class="admin-demo-note">演示模式：真实部署需接入账号权限体系（RBAC），管理端仅对授权人员开放</div>'
    + '<div class="kpi-row">'
    + '<div class="kpi-tile"><div class="kpi-num">' + items.length + '</div><div class="kpi-label">信息总数</div></div>'
    + '<div class="kpi-tile"><div class="kpi-num kpi-good">' + rate + '%</div><div class="kpi-label">找回率</div></div>'
    + '<div class="kpi-tile"><div class="kpi-num kpi-warn">' + waiting.length + '</div><div class="kpi-label">等待认领</div></div>'
    + '</div>'
    + '<div class="dash-card"><div class="dash-title">🗺️ 失物热力地图</div>'
    + mapLegendHtml()
    + '<div id="map-area"></div>'
    + '<div id="map-panel"></div>'
    + ((m.mode === 'flat' || m.mode === 'stack')
      ? '<button class="map-toggle" id="map-toggle" type="button">'
        + (defaultView === 'flat' ? '🧊 预览立体楼层模式' : '🖼️ 切换平面色块视图')
        + '</button>'
      : '')
    + '</div>'
    + '<div class="dash-card"><div class="dash-title">📦 品类分布</div>'
    + catCounts.map(function (x) {
        return '<div class="bar-row"><div class="bar-label">' + esc(x.cat) + '</div>'
          + '<div class="bar-track"><i class="bar-fill viz-c' + (x.i + 1) + '" style="width:' + Math.round(x.n / maxCat * 100) + '%"></i></div>'
          + '<div class="bar-val">' + x.n + ' 件</div></div>';
      }).join('')
    + '</div>'
    + '<div class="dash-card"><div class="dash-title">🕐 丢失时段分布</div>'
    + hourCounts.map(function (x) {
        return '<div class="bar-row"><div class="bar-label">' + x.label + '</div>'
          + '<div class="bar-track"><i class="bar-fill viz-hour" style="width:' + Math.round(x.n / maxH * 100) + '%"></i></div>'
          + '<div class="bar-val">' + x.n + ' 件</div></div>';
      }).join('')
    + '</div>'
    + '<div class="dash-card"><div class="dash-title">💡 防丢建议（规则引擎生成）</div>'
    + genAdvice(items).map(function (a) { return '<div class="advice-card">' + esc(a) + '</div>'; }).join('')
    + '</div>'
    + '<div class="dash-card"><div class="dash-title">🗂️ 待认领信息管理</div>'
    + (recentWaiting.length ? recentWaiting.map(function (it) {
        return '<div class="adm-row">'
          + '<div class="adm-main"><div class="adm-name">' + esc(it.name)
          + '<span class="adm-badge ' + it.module + '">' + (it.module === 'found' ? '捡到' : '寻找') + '</span></div>'
          + '<div class="adm-meta">' + esc(it.campus) + ' · ' + esc(it.location || '地点未填写') + ' · ' + fmtTime(it.time) + '</div></div>'
          + '<div class="adm-actions">'
          + '<button class="act-btn act-found" data-id="' + it.id + '" type="button">✅ 已找到</button>'
          + '<button class="act-btn act-del" data-id="' + it.id + '" type="button">🗑 下架</button>'
          + '</div></div>';
      }).join('') : emptyHtml('暂无待认领信息'))
    + '</div>'
    + '<div class="dash-card"><div class="dash-title">📜 滞留预警与招领公告'
    + (stale.length ? '（' + stale.length + ' 件滞留超 10 天）' : '') + '</div>'
    + (stale.length ? stale.map(function (it) {
        const days = Math.floor((Date.now() - new Date(it.time)) / 86400000);
        return '<div class="stale-row">' + esc(it.name) + ' · ' + esc(it.campus)
          + ' <span class="stale-tag">滞留 ' + days + ' 天</span></div>';
      }).join('') : '<div class="law-note">当前无滞留物品。</div>')
    + '<div class="law-note">📖 依据《民法典》第318条：遗失物自发布招领公告之日起一年内无人认领的，归国家所有。本平台对滞留超 30 天物品自动生成招领公告（演示）。</div>'
    + '</div>'
    + '<div class="dash-card"><div class="dash-title">✅ 已闭环（找到家）</div>'
    + (recentFound.length ? recentFound.map(function (it) {
        return '<div class="closed-row">🏠 ' + esc(it.name) + ' · ' + esc(it.campus) + ' · ' + fmtTime(it.time) + '</div>';
      }).join('') : emptyHtml('暂无已找到记录'))
    + '</div>'
    + '<div class="dash-card"><div class="dash-title">📋 数据明细</div>'
    + '<table class="dash-table"><tr><th>' + esc(SITE_CONFIG.areaLabel) + '</th><th>等待</th><th>已找到</th><th>小计</th></tr>'
    + areaCounts.map(function (x) {
        return '<tr><td>' + esc(x.area) + '</td><td>' + x.n + '</td><td>' + x.f + '</td><td>' + (x.n + x.f) + '</td></tr>';
      }).join('')
    + '</table></div>'
    + '</div>';

  // ---- 地图渲染与交互 ----
  let mapView = defaultView;
  const mapArea = document.getElementById('map-area');
  const mapPanel = document.getElementById('map-panel');

  function drawMap() {
    mapPanel.innerHTML = '';
    if (m.mode === 'amap') {
      // 真实地图（高德）：区域导航 + 图层开关 + 热力多边形 + 物品点位
      mapArea.innerHTML = '';
      renderAmap(mapArea, areaCounts, heatStep, m, mapPanel);
      return;
    }
    if (m.mode === '3d') {
      // 立体楼宇（Three.js）：旋转缩放 + 点击楼层
      mapArea.innerHTML = '<div class="three-box" id="three-box"></div>';
      renderThree3d(document.getElementById('three-box'), areaCounts, heatStep, m, mapPanel);
      return;
    }
    if (mapView === 'stack') {
      mapArea.innerHTML = stackHtml(areaCounts, heatStep, m);
    } else if (m.mode === 'flat' && Object.keys(m.paths || {}).length) {
      mapArea.innerHTML = flatMapSvg(areaCounts, heatStep, m);
    } else {
      // 无平面多边形配置时回落到色块网格
      mapArea.innerHTML = '<div class="heat-grid">'
        + areaCounts.map(function (x) {
            return '<div class="heat-tile ' + heatStep(x.n) + '"><div class="heat-name">' + esc(x.area) + '</div>'
              + '<div class="heat-count">' + x.n + ' 件</div></div>';
          }).join('')
        + '</div>';
    }
    mapArea.querySelectorAll('[data-area]').forEach(function (node) {
      node.addEventListener('click', function () {
        const area = node.dataset.area;
        const x = areaCounts.find(function (t) { return t.area === area; });
        mapPanel.innerHTML = '<div class="map-panel">📍 <b>' + esc(area) + '</b>：等待 '
          + x.n + ' 件 · 已找到 ' + x.f + ' 件'
          + ' <button class="map-go" type="button" data-area="' + esc(area) + '">在「捡到东西」中查看 →</button></div>';
        mapPanel.querySelector('.map-go').addEventListener('click', function () {
          goAreaList(area);
        });
      });
    });
  }

  const toggleBtn = document.getElementById('map-toggle');
  if (toggleBtn && toggleBtn.addEventListener) {
    toggleBtn.addEventListener('click', function () {
      mapView = mapView === 'stack' ? 'flat' : 'stack';
      toggleBtn.textContent = mapView === 'stack' ? '🖼️ 切换平面色块视图' : '🧊 预览立体楼层模式';
      drawMap();
    });
  }

  drawMap();

  // ---- 信息管理操作 ----
  app.querySelectorAll('.act-found').forEach(function (btn) {
    btn.addEventListener('click', function () {
      updateItem(Number(btn.dataset.id), { status: 'found' });
      showToast('已标记为找到 🎉');
      render();
    });
  });
  app.querySelectorAll('.act-del').forEach(function (btn) {
    btn.addEventListener('click', function () {
      if (btn.dataset.armed === '1') {
        removeItem(Number(btn.dataset.id));
        showToast('已下架');
        render();
        return;
      }
      btn.dataset.armed = '1';
      btn.textContent = '确认下架？';
      setTimeout(function () {
        btn.dataset.armed = '0';
        btn.textContent = '🗑 下架';
      }, 2000);
    });
  });
}

// 规则引擎：从数据自动生成防丢建议（演示版专家系统）
function genAdvice(items) {
  const waiting = items.filter(function (it) { return it.status === 'waiting'; });
  const adv = [];
  // 规则 1：区域 × 品类积压 TOP
  const combos = {};
  waiting.forEach(function (it) {
    const k = it.campus + '|' + it.category;
    combos[k] = (combos[k] || 0) + 1;
  });
  const top = Object.keys(combos).map(function (k) {
    const p = k.split('|');
    return { area: p[0], cat: p[1], n: combos[k] };
  }).filter(function (x) { return x.n >= 2; })
    .sort(function (a, b) { return b.n - a.n; })
    .slice(0, 3);
  top.forEach(function (x) {
    adv.push('「' + x.area + '」的「' + x.cat + '」积压 ' + x.n + ' 件，建议在该区域增设防丢提醒标识与高峰广播，并检查是否缺少置物/挂钩设施。');
  });
  // 规则 2：丢失高峰时段
  let best = null;
  hourCountsOf(items).forEach(function (x) {
    if (!best || x.n > best.n) best = x;
  });
  if (best && best.n >= 2) {
    adv.push('每日 ' + best.label + ' 为丢失高发时段（' + best.n + ' 件），建议该时段加强巡场与语音提醒。');
  }
  // 规则 3：找回率偏低时建议优化认领流程
  if (items.length >= 5) {
    const foundN = items.length - waiting.length;
    if (foundN / items.length < 0.5) {
      adv.push('整体找回率不足一半，建议简化认领流程（线上验证、邮寄认领、多时段值班）。');
    }
  }
  return adv.length ? adv : ['暂无显著热点，当前防丢形势良好。'];
}

// ---------- 路由 ----------
function render() {
  const parts = (location.hash || '#/').slice(1).split('/').filter(Boolean);
  if (parts[0] === 'found' || parts[0] === 'lost') renderList(parts[0]);
  else if (parts[0] === 'detail') renderDetail(Number(parts[1]));
  else if (parts[0] === 'publish') renderPublish(parts[1] || 'found');
  else if (parts[0] === 'admin' || parts[0] === 'dashboard') renderAdmin();
  else if (parts[0] === 'user') renderUserHome();
  else renderHome();
  updateFooter();
  window.scrollTo(0, 0);
}

function updateFooter() {
  const s = getStats();
  document.getElementById('stat-found').textContent = s.found;
  document.getElementById('stat-waiting').textContent = s.waiting;
}

// ---------- 首页（双入口：普通用户 / 场所管理方） ----------
function renderHome() {
  app.innerHTML =
    '<div class="home-head">'
    + '<div class="home-title">🎓 ' + esc(SITE_CONFIG.siteName) + '</div>'
    + '<div class="home-sub">' + esc(SITE_CONFIG.slogan) + '</div>'
    + '</div>'
    + '<div class="role-grid">'
    + '<a class="role-card" href="#/user">'
    + '<div class="role-emoji">👤</div><div class="role-name">普通用户</div>'
    + '<div class="role-desc">浏览、搜索、发布、认领失物信息</div></a>'
    + '<a class="role-card admin" href="#/admin">'
    + '<div class="role-emoji">🧑‍💼</div><div class="role-name">场所管理方</div>'
    + '<div class="role-desc">数据看板与信息管理（演示模式）</div></a>'
    + '</div>'
    + '<div class="home-tip">不同角色，不同界面：平台同时服务失主与场所运营方</div>';
}

// 用户首页：两个模块入口 + 最新动态
function renderUserHome() {
  const items = getItems().slice().sort(byTimeDesc);
  const latest = m => items.filter(it => it.module === m).slice(0, 3);
  const cards = list => list.length ? list.map(itemCard).join('') : emptyHtml('还没有信息，点进模块发布第一条吧');

  app.innerHTML =
    '<div class="topbar"><a class="back" href="#/">‹</a><h1>普通用户</h1></div>'
    + '<div class="home-head">'
    + '<div class="home-title">🎓 ' + esc(SITE_CONFIG.siteName) + '</div>'
    + '<div class="home-sub">' + esc(SITE_CONFIG.slogan) + '</div>'
    + '</div>'
    + '<div class="entry-grid">'
    + '<a class="entry-card" href="#/found">'
    + '<div class="entry-emoji">📦</div><div class="entry-name">捡到东西</div>'
    + '<div class="entry-desc">我捡到了物品，帮它找主人</div></a>'
    + '<a class="entry-card lost" href="#/lost">'
    + '<div class="entry-emoji">🔍</div><div class="entry-name">需要找东西</div>'
    + '<div class="entry-desc">我的物品丢了，寻找它的下落</div></a>'
    + '</div>'
    + '<div class="section-title">📦 最新捡到</div>' + cards(latest('found'))
    + '<div class="section-title">🔍 最新寻找</div>' + cards(latest('lost'))
    + '<a class="dash-entry" href="#/admin">🧑‍💼 管理端入口 · 数据看板与信息管理 →</a>';
}

// ---------- 列表页 ----------
function renderList(module) {
  // 换了模块则重置筛选状态
  if (listState.module !== module) {
    listState.module = module;
    listState.dim = 'category';
    listState.filter = '';
    listState.keyword = '';
    listState.fuzzy = false;
  }

  app.innerHTML =
    '<div class="topbar"><a class="back" href="#/">‹</a><h1>' + MODULE_NAMES[module] + '</h1></div>'
    + '<div class="search-row">'
    + '<div class="search-box"><span>🔍</span>'
    + '<input id="search-input" type="search" placeholder="搜索物品名称…" value="' + esc(listState.keyword) + '"></div>'
    + '<label class="fuzzy-toggle" title="打开后可以用口语化描述搜索">'
    + '<input id="fuzzy-input" type="checkbox"' + (listState.fuzzy ? ' checked' : '') + '> 模糊</label>'
    + '</div>'
    + '<div class="tabs">'
    + '<div class="tab' + (listState.dim === 'category' ? ' active' : '') + '" data-dim="category">按分类</div>'
    + '<div class="tab' + (listState.dim === 'campus' ? ' active' : '') + '" data-dim="campus">按' + SITE_CONFIG.areaLabel + '</div>'
    + '</div>'
    + matchBannerHtml(module)
    + '<div id="chips"></div>'
    + '<div id="list-items"></div>'
    + '<a class="fab" href="#/publish/' + module + '" title="发布信息">＋</a>';

  document.getElementById('search-input').addEventListener('input', function (e) {
    listState.keyword = e.target.value;
    updateItems();
  });
  document.getElementById('fuzzy-input').addEventListener('change', function (e) {
    listState.fuzzy = e.target.checked;
    updateItems();
  });
  document.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      if (listState.dim === t.dataset.dim) return;
      listState.dim = t.dataset.dim;
      listState.filter = '';
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      updateChips();
      updateItems();
    });
  });

  updateChips();
  updateItems();
}

function updateChips() {
  const values = listState.dim === 'category' ? CATEGORIES : CAMPUSES;
  const chips = document.getElementById('chips');
  let html = '<span class="chip' + (listState.filter === '' ? ' active' : '') + '" data-v="">全部</span>';
  values.forEach(function (v) {
    html += '<span class="chip' + (listState.filter === v ? ' active' : '') + '" data-v="' + esc(v) + '">' + esc(v) + '</span>';
  });
  chips.innerHTML = html;
  chips.querySelectorAll('.chip').forEach(function (c) {
    c.addEventListener('click', function () {
      listState.filter = c.dataset.v;
      updateChips();
      updateItems();
    });
  });
}

function updateItems() {
  const box = document.getElementById('list-items');
  let items = getItems().filter(it => it.module === listState.module);

  // 维度筛选
  if (listState.filter) {
    items = items.filter(it =>
      listState.dim === 'category' ? it.category === listState.filter : it.campus === listState.filter);
  }

  // 搜索：模糊关 = 只匹配名称；模糊开 = 在所有字段里匹配（支持口语化描述）
  const kw = listState.keyword.trim().toLowerCase();
  if (kw) {
    const tokens = kw.split(/\s+/);
    const before = items;
    if (listState.fuzzy) {
      const textOf = it => [it.name, it.desc, it.category, it.campus, it.location].join(' ').toLowerCase();
      const all = before.filter(it => tokens.every(t => textOf(it).includes(t)));
      // 全词匹配无结果时，退化为“任一关键词命中”，尽量给用户结果
      items = all.length ? all : before.filter(it => tokens.some(t => textOf(it).includes(t)));
    } else {
      items = before.filter(it => tokens.every(t => it.name.toLowerCase().includes(t)));
    }
  }

  items.sort(byTimeDesc);

  box.innerHTML = items.length
    ? items.map(itemCard).join('')
    : emptyHtml('没有找到相关信息，试试打开「模糊」搜索，或用更短的词～');
}

// ---------- 详情页 ----------
function renderDetail(id) {
  const it = getItem(id);
  if (!it) {
    app.innerHTML = '<div class="topbar"><a class="back" href="#/">‹</a><h1>详情</h1></div>'
      + '<div class="empty"><div class="empty-emoji">🫥</div>这条信息不存在或已被删除</div>';
    return;
  }

  app.innerHTML =
    '<div class="topbar"><a class="back" href="#/' + it.module + '">‹</a><h1>' + MODULE_NAMES[it.module] + '</h1></div>'
    + (it.images && it.images.length > 1
      ? '<div class="carousel" id="carousel">'
        + it.images.map(src => '<img src="' + esc(src) + '" alt="' + esc(it.name) + '">').join('')
        + '</div><div class="carousel-dots" id="carousel-dots"></div>'
      : '<img class="detail-img" src="' + esc(it.image) + '" alt="' + esc(it.name) + '">')
    + '<div class="detail-body">'
    + '<div class="detail-name">' + esc(it.name) + statusBadge(it.status) + '</div>'
    + '<div class="meta-card">'
    + '<div class="meta-row"><span class="meta-label">分类</span><span class="meta-value">' + esc(it.category) + '</span></div>'
    + '<div class="meta-row"><span class="meta-label">' + esc(SITE_CONFIG.areaLabel) + '</span><span class="meta-value">' + esc(it.campus) + '</span></div>'
    + '<div class="meta-row"><span class="meta-label">具体地点</span><span class="meta-value">' + esc(it.location || '未填写') + '</span></div>'
    + '<div class="meta-row"><span class="meta-label">发布时间</span><span class="meta-value">' + fmtTime(it.time) + '</span></div>'
    + (it.contact
      ? '<div class="meta-row"><span class="meta-label">联系方式</span><span class="meta-value">' + esc(it.contact) + '</span>'
        + '<button class="copy-btn" id="copy-contact" type="button">📋 复制</button></div>'
      : '')
    + '</div>'
    + '<div class="desc-title">物品描述</div>'
    + '<div class="desc-text">' + esc(it.desc || '（发布者没有留下描述）') + '</div>'
    + '<div class="verify-tip">🔐 认领须知：'
    + (it.module === 'found'
      ? '请认领人描述物品特征（颜色、内部物品、特殊标记等）核对身份后再交接，防止冒领。'
      : '有人联系归还时，请先核对对方描述的物品特征，建议校内当面交接。')
    + '</div>'
    + matchSectionHtml(it)
    + (it.status === 'waiting'
      ? '<button class="btn btn-green mark-btn" id="mark-btn">✅ 标记为已找到</button>'
      : '<div class="found-note">🎉 这件物品已经找到家了！</div>')
    + '</div>'
    + '<div class="comments">'
    + '<div class="section-title">💬 评论（<span id="comment-count">0</span>）</div>'
    + (isSensitive(it.name, it.category)
      ? '<div class="privacy-hint" style="margin:10px 16px 0">🔒 隐私提示：请勿在评论中公开证件号、姓名等敏感信息</div>'
      : '')
    + '<div id="comment-list"></div>'
    + '<div class="comment-form">'
    + '<input id="comment-nick" type="text" placeholder="你的昵称（选填）" maxlength="12">'
    + '<textarea id="comment-text" placeholder="说说你知道的信息，帮它早点回家～" maxlength="200"></textarea>'
    + '<button class="btn btn-primary" id="comment-send">发表评论</button>'
    + '</div></div>';

  const markBtn = document.getElementById('mark-btn');
  if (markBtn) {
    markBtn.addEventListener('click', function () {
      updateItem(id, { status: 'found' });
      showToast('已标记为找到，统计已更新 🎉');
      render();
    });
  }

  // 一键复制联系方式
  const copyBtn = document.getElementById('copy-contact');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      copyText(it.contact, '联系方式已复制');
    });
  }

  // 多图轮播：左右滑动切换 + 小圆点指示
  const carousel = document.getElementById('carousel');
  if (carousel) {
    const dots = document.getElementById('carousel-dots');
    dots.innerHTML = it.images.map(function (_, i) {
      return '<span class="dot' + (i === 0 ? ' active' : '') + '"></span>';
    }).join('');
    carousel.addEventListener('scroll', function () {
      const i = Math.round(carousel.scrollLeft / carousel.clientWidth);
      dots.querySelectorAll('.dot').forEach(function (d, di) {
        d.classList.toggle('active', di === i);
      });
    }, { passive: true });
  }

  document.getElementById('comment-send').addEventListener('click', function () {
    const text = document.getElementById('comment-text').value.trim();
    if (!text) {
      showToast('评论内容不能为空');
      return;
    }
    const nick = document.getElementById('comment-nick').value.trim();
    addComment(id, nick, text);
    updateComments(id);
    document.getElementById('comment-text').value = '';
    showToast('评论发布成功');
  });

  updateComments(id);
}

function updateComments(id) {
  const list = getComments(id);
  const box = document.getElementById('comment-list');
  const count = document.getElementById('comment-count');
  if (count) count.textContent = list.length;
  box.innerHTML = list.length
    ? list.map(c =>
      '<div class="comment">'
      + '<div class="comment-avatar">' + esc(c.nickname.slice(0, 1)) + '</div>'
      + '<div class="comment-body">'
      + '<div class="comment-head"><span class="comment-nick">' + esc(c.nickname) + '</span><span>' + fmtTime(c.time) + '</span></div>'
      + '<div class="comment-text">' + esc(c.text) + '</div>'
      + '</div></div>').join('')
    : '<div class="empty" style="padding:16px">还没有评论，来抢沙发～</div>';
}

// ---------- 发布页 ----------
function renderPublish(module) {
  const title = module === 'found' ? '发布捡到信息' : '发布寻找信息';
  const options = (list, id, first) =>
    '<select class="form-select" id="' + id + '">'
    + '<option value="">' + first + '</option>'
    + list.map(v => '<option value="' + esc(v) + '">' + esc(v) + '</option>').join('')
    + '</select>';

  app.innerHTML =
    '<div class="topbar"><a class="back" href="#/' + module + '">‹</a><h1>' + title + '</h1></div>'
    + '<form class="publish-form" id="publish-form">'
    + '<div class="form-item"><label class="form-label">物品名称<span class="req"> *</span></label>'
    + '<input class="form-input" id="f-name" type="text" placeholder="如：校园卡、黑色充电宝…" maxlength="30"></div>'
    + '<div class="form-item"><label class="form-label">物品分类<span class="req"> *</span></label>'
    + options(CATEGORIES, 'f-category', '请选择分类') + '</div>'
    + '<div class="form-item"><label class="form-label">所在' + SITE_CONFIG.areaLabel + '<span class="req"> *</span></label>'
    + options(CAMPUSES, 'f-campus', '请选择' + SITE_CONFIG.areaLabel) + '</div>'
    + '<div class="form-item"><label class="form-label">具体地点</label>'
    + '<input class="form-input" id="f-location" type="text" placeholder="如：图书馆二楼、操场看台…" maxlength="40"></div>'
    + '<div class="form-item"><label class="form-label">物品描述</label>'
    + '<textarea class="form-textarea" id="f-desc" placeholder="描述物品的外观、特征，信息越多越容易找到～" maxlength="300"></textarea></div>'
    + '<div class="form-item"><label class="form-label">联系方式（选填）</label>'
    + '<input class="form-input" id="f-contact" type="text" placeholder="如：QQ / 手机号" maxlength="40"></div>'
    + '<div class="ai-settings">'
    + '<div class="ai-settings-row"><span>🔑 AI 识别：<b id="ai-status">' + (getAiKey() ? 'GLM-4V 真实识别' : '模拟识别') + '</b></span>'
    + '<button class="ai-set-btn" id="ai-set-btn" type="button">设置</button></div>'
    + '<div class="ai-settings-form" id="ai-set-form" style="display:none">'
    + '<input id="ai-key-input" type="password" placeholder="粘贴智谱 API Key（免费，仅保存在本机浏览器）">'
    + '<div class="ai-set-actions">'
    + '<button class="ai-act" id="ai-save" type="button">保存</button>'
    + '<button class="ai-act" id="ai-test" type="button">测试</button>'
    + '<button class="ai-act danger" id="ai-clear" type="button">清除</button>'
    + '</div>'
    + '<div class="ai-note">Key 只存在你自己的浏览器里，不会进入网站代码。免费申请：open.bigmodel.cn</div>'
    + '</div></div>'
    + '<div class="form-item"><label class="form-label">物品图片（选填，最多 3 张）</label>'
    + '<div class="upload-box" id="upload-box">'
    + '<div id="upload-hint">📷 点击上传图片</div>'
    + '<div class="thumbs-row" id="thumbs-row"></div>'
    + '</div>'
    + '<input type="file" id="f-image" accept="image/*" multiple style="display:none">'
    + '<div class="ai-panel" id="ai-panel" style="display:none"></div>'
    + '<div class="privacy-hint" id="privacy-hint" style="display:none">⚠️ 证件类物品涉及个人隐私，请遮挡证件号、姓名等敏感信息后再上传照片</div>'
    + '<div class="privacy-panel" id="privacy-panel" style="display:none">'
    + '<div class="privacy-title">🔒 隐私保护 · 图片打码</div>'
    + '<div class="privacy-tip">检测到证件类物品。请在图片上按住拖动（手机上是手指滑动），遮挡敏感信息：</div>'
    + '<canvas id="privacy-canvas"></canvas>'
    + '<button class="btn btn-light" id="privacy-reset" type="button">↩️ 撤销打码</button>'
    + '<label class="privacy-confirm"><input type="checkbox" id="privacy-confirm"> 我已遮挡图片中的敏感信息</label>'
    + '</div>'
    + '</div>'
    + '<button class="btn btn-primary submit-btn" type="submit">发布信息</button>'
    + '<div class="safety-tip">🛡️ 安全提醒：涉及现金酬谢时谨防诈骗，建议在校内公共场所当面交接，切勿提前转账或透露验证码。</div>'
    + '</form>';

  let imageList = [];  // 图片列表（打码后的结果，发布时保存这份）
  let originals = [];  // 原始图片（撤销打码用）
  let currentIdx = 0;  // 打码面板当前编辑的图片下标
  let privacyReady = false; // 打码画布是否已初始化
  const box = document.getElementById('upload-box');
  const fileInput = document.getElementById('f-image');
  box.addEventListener('click', function () { fileInput.click(); });
  fileInput.addEventListener('change', function () {
    const files = Array.prototype.slice.call(fileInput.files || []);
    fileInput.value = ''; // 清空，允许再次选择同一文件
    if (imageList.length >= 3) {
      showToast('最多上传 3 张图片');
      return;
    }
    processFiles(files.slice(0, 3 - imageList.length));
  });

  // 依次压缩图片并加入列表
  function processFiles(list) {
    const file = list.shift();
    if (!file) return;
    if (file.type.indexOf('image/') !== 0) {
      processFiles(list);
      return;
    }
    readImage(file, function (data) {
      originals.push(data);
      imageList.push(data);
      renderThumbs();
      updatePrivacyUI();
      aiRecognize(data);
      processFiles(list);
    });
  }

  // AI 识别：已配置 Key 时用 GLM-4V 真识别，否则退回本地模拟识别
  function aiRecognize(data) {
    const panel = document.getElementById('ai-panel');
    panel.style.display = 'block';
    panel.innerHTML = '<div class="ai-title">🤖 AI 识别中…</div>';
    const key = getAiKey();
    if (key) {
      callGLM4V(data, key, function (ok, result) {
        if (ok && result.name) {
          renderAiResult(panel, [{ name: result.color || '主色', hex: '#4A90D9' }], [result.name], '识别由 GLM-4V 视觉大模型提供');
          // 真识别结果直接自动填入名称与描述
          if (!document.getElementById('f-name').value.trim()) {
            document.getElementById('f-name').value = result.name;
          }
          if (!document.getElementById('f-desc').value.trim()) {
            document.getElementById('f-desc').value = '（AI 识别）' + (result.desc || result.name + '，主要颜色为' + (result.color || '未知') + '。');
          }
          return;
        }
        simulateRecognize(data, panel, '（AI 服务不可用，已使用本地模拟识别）');
      });
      return;
    }
    simulateRecognize(data, panel, '（未配置 Key，本地模拟识别 · 点上方「设置」可接入真 AI）');
  }

  // 本地模拟识别：真实提取主色 + 规则库推荐（兜底方案）
  function simulateRecognize(data, panel, note) {
    setTimeout(function () {
      colorExtract(data, function (colors) {
        const category = document.getElementById('f-category').value || CAT(4);
        const names = suggestNames(category, colors[0].name);
        renderAiResult(panel, colors, names, note);
        fillAiDesc(colors[0].name);
      });
    }, 1200);
  }

  function renderAiResult(panel, colors, names, note) {
    panel.innerHTML = '<div class="ai-title">🤖 AI 识别结果</div>'
      + '<div class="ai-colors">'
      + colors.map(function (c) {
          return '<span class="ai-color-chip"><i style="background:' + c.hex + '"></i>' + esc(c.name) + (c.pct ? ' ' + c.pct + '%' : '') + '</span>';
        }).join('')
      + '</div>'
      + '<div class="ai-names">'
      + names.map(function (n) {
          return '<span class="ai-name-chip" data-n="' + esc(n) + '">' + esc(n) + '</span>';
        }).join('')
      + '</div>'
      + '<div class="ai-note">' + esc(note) + '</div>';
    panel.querySelectorAll('.ai-name-chip').forEach(function (chip) {
      chip.addEventListener('click', function () {
        document.getElementById('f-name').value = chip.dataset.n;
      });
    });
  }

  // AI 识别设置：Key 仅存本机浏览器
  const aiSetBtn = document.getElementById('ai-set-btn');
  if (aiSetBtn && aiSetBtn.addEventListener) {
    aiSetBtn.addEventListener('click', function () {
      const f = document.getElementById('ai-set-form');
      f.style.display = f.style.display === 'none' ? 'block' : 'none';
    });
  }
  document.getElementById('ai-key-input').value = getAiKey();
  document.getElementById('ai-save').addEventListener('click', function () {
    setAiKey(document.getElementById('ai-key-input').value.trim());
    document.getElementById('ai-status').textContent = getAiKey() ? 'GLM-4V 真实识别' : '模拟识别';
    showToast('已保存，仅存于本机');
  });
  document.getElementById('ai-test').addEventListener('click', function () {
    const k = document.getElementById('ai-key-input').value.trim();
    if (!k) { showToast('请先粘贴 Key'); return; }
    showToast('正在测试…');
    testAiKey(k, function (ok) {
      showToast(ok ? 'Key 有效 ✅' : 'Key 无效或网络不通 ❌');
    });
  });
  document.getElementById('ai-clear').addEventListener('click', function () {
    clearAiKey();
    document.getElementById('ai-key-input').value = '';
    document.getElementById('ai-status').textContent = '模拟识别';
    showToast('已清除');
  });

  // 描述为空时自动填入 AI 辅助描述
  function fillAiDesc(color) {
    const d = document.getElementById('f-desc');
    if (d.value.trim()) return;
    d.value = '（AI 辅助描述）主色为' + color + '，外观基本完好，有轻微使用痕迹，具体特征请认领人核对。';
  }

  // 渲染已选图片缩略图：可删除；打码面板打开时可点击切换打码对象
  function renderThumbs() {
    const row = document.getElementById('thumbs-row');
    document.getElementById('upload-hint').style.display = imageList.length ? 'none' : 'block';
    row.innerHTML = imageList.map(function (src, i) {
      return '<div class="thumb-item' + (i === currentIdx ? ' active' : '') + '" data-i="' + i + '">'
        + '<img src="' + esc(src) + '" alt="已选图片">'
        + '<span class="thumb-del" data-del="' + i + '">×</span>'
        + '</div>';
    }).join('');
    row.querySelectorAll('.thumb-item').forEach(function (t) {
      t.addEventListener('click', function () {
        const i = Number(t.dataset.i);
        if (i === currentIdx) return;
        commitCanvas(); // 先保存当前图片的打码进度
        currentIdx = i;
        if (privacyReady) loadCanvas(i);
        renderThumbs();
      });
    });
    row.querySelectorAll('.thumb-del').forEach(function (d) {
      d.addEventListener('click', function (e) {
        e.stopPropagation();
        const i = Number(d.dataset.del);
        originals.splice(i, 1);
        imageList.splice(i, 1);
        if (currentIdx >= imageList.length) currentIdx = Math.max(0, imageList.length - 1);
        if (privacyReady && imageList.length) loadCanvas(currentIdx);
        renderThumbs();
        updatePrivacyUI();
      });
    });
  }

  // 敏感物品（证件类）时展示隐私提醒与打码面板
  function updatePrivacyUI() {
    const name = document.getElementById('f-name').value.trim();
    const category = document.getElementById('f-category').value;
    const sensitive = isSensitive(name, category);
    document.getElementById('privacy-hint').style.display = sensitive ? 'block' : 'none';
    const panel = document.getElementById('privacy-panel');
    const show = sensitive && imageList.length > 0;
    panel.style.display = show ? 'block' : 'none';
    if (show && !privacyReady) {
      privacyReady = true;
      currentIdx = 0;
      loadCanvas(0);
    }
    renderThumbs();
  }

  // 把第 i 张图片画到打码画布（事件只绑定一次）
  let canvasBound = false;
  function loadCanvas(i) {
    const canvas = document.getElementById('privacy-canvas');
    const ctx = canvas.getContext('2d');
    if (!canvasBound) {
      canvasBound = true;
      bindPixelate(canvas, ctx);
    }
    const img = new Image();
    img.onload = function () {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      canvas.dataset.dirty = '0';
    };
    img.src = imageList[i];
  }

  // 把当前画布的打码结果存回 imageList
  function commitCanvas() {
    const canvas = document.getElementById('privacy-canvas');
    if (privacyReady && canvas.dataset.dirty === '1' && imageList.length) {
      imageList[currentIdx] = canvas.toDataURL('image/jpeg', 0.85);
      canvas.dataset.dirty = '0';
    }
  }

  document.getElementById('f-name').addEventListener('input', updatePrivacyUI);
  document.getElementById('f-category').addEventListener('change', updatePrivacyUI);
  document.getElementById('privacy-reset').addEventListener('click', function () {
    // 撤销当前图片的打码，恢复原始图
    if (!imageList.length) return;
    imageList[currentIdx] = originals[currentIdx];
    loadCanvas(currentIdx);
  });

  document.getElementById('publish-form').addEventListener('submit', function (e) {
    e.preventDefault();
    const name = document.getElementById('f-name').value.trim();
    const category = document.getElementById('f-category').value;
    const campus = document.getElementById('f-campus').value;
    if (!name) { showToast('请填写物品名称'); return; }
    if (!category) { showToast('请选择物品分类'); return; }
    if (!campus) { showToast('请选择所在校区'); return; }

    // 隐私校验：打码面板显示时必须先勾选确认
    const privacyPanel = document.getElementById('privacy-panel');
    if (privacyPanel.style.display !== 'none' && !document.getElementById('privacy-confirm').checked) {
      showToast('请先确认已遮挡图片中的敏感信息');
      return;
    }
    // 面板显示时，把当前画布的打码结果存回列表
    if (privacyPanel.style.display !== 'none') commitCanvas();

    lastPublished = addItem({
      module: module,
      name: name,
      category: category,
      campus: campus,
      location: document.getElementById('f-location').value.trim(),
      desc: document.getElementById('f-desc').value.trim(),
      contact: document.getElementById('f-contact').value.trim(),
      image: imageList[0] || svgImg(CATEGORY_ICONS[category], CATEGORY_COLORS[category]),
      images: imageList.length > 1 ? imageList.slice() : undefined
    });

    // 清空筛选与搜索，保证新发布的信息在列表最前面可见
    listState.filter = '';
    listState.keyword = '';
    listState.fuzzy = false;

    showToast('发布成功 🎉');
    setTimeout(function () { location.hash = '#/' + module; }, 600);
  });
}

// ---------- 启动 ----------
initStore();
document.title = SITE_CONFIG.siteName;
render();
window.addEventListener('hashchange', render);
