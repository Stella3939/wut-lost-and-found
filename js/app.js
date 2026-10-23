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

// ---------- 路由 ----------
function render() {
  const parts = (location.hash || '#/').slice(1).split('/').filter(Boolean);
  if (parts[0] === 'found' || parts[0] === 'lost') renderList(parts[0]);
  else if (parts[0] === 'detail') renderDetail(Number(parts[1]));
  else if (parts[0] === 'publish') renderPublish(parts[1] || 'found');
  else renderHome();
  updateFooter();
  window.scrollTo(0, 0);
}

function updateFooter() {
  const s = getStats();
  document.getElementById('stat-found').textContent = s.found;
  document.getElementById('stat-waiting').textContent = s.waiting;
}

// ---------- 首页 ----------
function renderHome() {
  const items = getItems().slice().sort(byTimeDesc);
  const latest = m => items.filter(it => it.module === m).slice(0, 3);
  const cards = list => list.length ? list.map(itemCard).join('') : emptyHtml('还没有信息，点进模块发布第一条吧');

  app.innerHTML =
    '<div class="home-head">'
    + '<div class="home-title">🎓 武汉理工大学失物招领</div>'
    + '<div class="home-sub">让每一件失物都能找到回家的路</div>'
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
    + '<div class="section-title">🔍 最新寻找</div>' + cards(latest('lost'));
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
    + '<div class="tab' + (listState.dim === 'campus' ? ' active' : '') + '" data-dim="campus">按校区</div>'
    + '</div>'
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
    + '<div class="meta-row"><span class="meta-label">校区</span><span class="meta-value">' + esc(it.campus) + '</span></div>'
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
    + '<div class="form-item"><label class="form-label">所在校区<span class="req"> *</span></label>'
    + options(CAMPUSES, 'f-campus', '请选择校区') + '</div>'
    + '<div class="form-item"><label class="form-label">具体地点</label>'
    + '<input class="form-input" id="f-location" type="text" placeholder="如：图书馆二楼、操场看台…" maxlength="40"></div>'
    + '<div class="form-item"><label class="form-label">物品描述</label>'
    + '<textarea class="form-textarea" id="f-desc" placeholder="描述物品的外观、特征，信息越多越容易找到～" maxlength="300"></textarea></div>'
    + '<div class="form-item"><label class="form-label">联系方式（选填）</label>'
    + '<input class="form-input" id="f-contact" type="text" placeholder="如：QQ / 手机号" maxlength="40"></div>'
    + '<div class="form-item"><label class="form-label">物品图片（选填，最多 3 张）</label>'
    + '<div class="upload-box" id="upload-box">'
    + '<div id="upload-hint">📷 点击上传图片</div>'
    + '<div class="thumbs-row" id="thumbs-row"></div>'
    + '</div>'
    + '<input type="file" id="f-image" accept="image/*" multiple style="display:none">'
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
      processFiles(list);
    });
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

    addItem({
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
render();
window.addEventListener('hashchange', render);
