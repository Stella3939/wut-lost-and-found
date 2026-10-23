// store.js —— 数据读写层：用浏览器 localStorage 模拟后端数据库

const ITEMS_KEY = 'wutlf_items';       // 物品列表
const COMMENTS_KEY = 'wutlf_comments'; // 评论（按物品 id 分组）

// 个别浏览器（隐私模式等）可能禁用 localStorage，此时降级为内存存储（刷新后丢失，不影响演示）
const storage = (function () {
  try {
    localStorage.setItem('__wutlf_test__', '1');
    localStorage.removeItem('__wutlf_test__');
    return localStorage;
  } catch (e) {
    const mem = {};
    return {
      getItem: k => (k in mem ? mem[k] : null),
      setItem: (k, v) => { mem[k] = String(v); }
    };
  }
})();

// 首次打开时写入预设示例数据
function initStore() {
  if (storage.getItem(ITEMS_KEY) === null) {
    storage.setItem(ITEMS_KEY, JSON.stringify(SEED_ITEMS));
  }
  if (storage.getItem(COMMENTS_KEY) === null) {
    storage.setItem(COMMENTS_KEY, JSON.stringify(SEED_COMMENTS));
  }
}

// ---------- 物品 ----------
function getItems() {
  return JSON.parse(storage.getItem(ITEMS_KEY) || '[]');
}
function saveItems(items) {
  storage.setItem(ITEMS_KEY, JSON.stringify(items));
}
function getItem(id) {
  return getItems().find(it => it.id === id);
}
function addItem(data) {
  const items = getItems();
  const id = items.reduce((m, it) => Math.max(m, it.id), 0) + 1;
  const item = Object.assign({ id: id, status: 'waiting', time: new Date().toISOString() }, data);
  items.push(item);
  saveItems(items);
  return item;
}
function updateItem(id, patch) {
  const items = getItems();
  const it = items.find(x => x.id === id);
  if (it) {
    Object.assign(it, patch);
    saveItems(items);
  }
  return it;
}

// ---------- 评论 ----------
function getComments(itemId) {
  const all = JSON.parse(storage.getItem(COMMENTS_KEY) || '{}');
  return all[itemId] || [];
}
function addComment(itemId, nickname, text) {
  const all = JSON.parse(storage.getItem(COMMENTS_KEY) || '{}');
  const list = all[itemId] || [];
  list.push({
    id: Date.now(),
    nickname: nickname || '热心同学',
    text: text,
    time: new Date().toISOString()
  });
  all[itemId] = list;
  storage.setItem(COMMENTS_KEY, JSON.stringify(all));
  return list;
}

// ---------- 统计（页脚用） ----------
function getStats() {
  const items = getItems();
  return {
    found: items.filter(it => it.status === 'found').length,
    waiting: items.filter(it => it.status === 'waiting').length
  };
}
