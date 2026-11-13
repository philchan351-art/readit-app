/*
 * store.js —— 持久化层
 *
 * 为什么不能继续用 localStorage：它只有约 5 MB，且塞不进一本大部头
 * （原实现在 1.6 MB 以上就放弃保存，刷新即丢）。IndexedDB 配额按磁盘算，够放整柜子的书。
 *
 * 结构：driver（存储引擎）+ 上层统一 API。
 *   - idbDriver    ：浏览器 IndexedDB（首选）
 *   - localDriver  ：localStorage（回落，比如无痕模式里 IDB 被禁）
 *   - memoryDriver ：内存（单元测试用，也能兜住"两个都不可用"的极端环境）
 * 上层 API 对三者完全一致，因此核心逻辑在 Node 里就能测。
 */
(function (global) {
  'use strict';

  var DB_NAME = 'readit';
  var DB_VER = 1;
  var S_BOOKS = 'books', S_PROGRESS = 'progress', S_SETTINGS = 'settings';
  var LS_KEYS = { books: 'readit.books.v2', progress: 'readit.progress.v2', settings: 'readit.settings.v2' };

  /* ---------- 驱动：IndexedDB ---------- */
  function idbDriver(root) {
    var idb = root.indexedDB || root.mozIndexedDB;
    if (!idb || typeof idb.open !== 'function') throw new Error('此环境没有 IndexedDB');
    var db = null;

    function wrap(req) {
      return new Promise(function (res, rej) {
        req.onsuccess = function () { res(req.result); };
        req.onerror = function () { rej(req.error || new Error('IndexedDB 操作失败')); };
      });
    }
    function store(name, mode) {
      return db.transaction([name], mode).objectStore(name);
    }
    return {
      name: 'indexeddb',
      open: function () {
        return new Promise(function (res, rej) {
          var req = idb.open(DB_NAME, DB_VER);
          req.onupgradeneeded = function () {
            var d = req.result;
            if (!d.objectStoreNames.contains(S_BOOKS)) d.createObjectStore(S_BOOKS, { keyPath: 'id' });
            if (!d.objectStoreNames.contains(S_PROGRESS)) d.createObjectStore(S_PROGRESS, { keyPath: 'bookId' });
            if (!d.objectStoreNames.contains(S_SETTINGS)) d.createObjectStore(S_SETTINGS, { keyPath: 'key' });
          };
          req.onsuccess = function () { db = req.result; res(db); };
          req.onerror = function () { rej(req.error || new Error('打开 IndexedDB 失败')); };
          req.onblocked = function () { rej(new Error('IndexedDB 被其它标签页占用')); };
        });
      },
      all: function (name) { return wrap(store(name, 'readonly').getAll()); },
      get: function (name, key) { return wrap(store(name, 'readonly').get(key)); },
      put: function (name, value) { return wrap(store(name, 'readwrite').put(value)); },
      del: function (name, key) { return wrap(store(name, 'readwrite').delete(key)); },
      clear: function (name) { return wrap(store(name, 'readwrite').clear()); }
    };
  }

  /* ---------- 驱动：localStorage ---------- */
  function localDriver(root) {
    var ls = root.localStorage;
    if (!ls) throw new Error('此环境没有 localStorage');
    function read(name) {
      try { return JSON.parse(ls.getItem(LS_KEYS[name]) || '[]'); } catch (e) { return []; }
    }
    function write(name, rows) { ls.setItem(LS_KEYS[name], JSON.stringify(rows)); }
    function keyOf(name) { return name === S_BOOKS ? 'id' : (name === S_PROGRESS ? 'bookId' : 'key'); }
    return {
      name: 'localstorage',
      // 驱动契约：open() 用 reject 表达失败（构造时的"没有这个 API"才同步 throw）
      open: function () {
        try { ls.setItem('readit.probe', '1'); ls.removeItem('readit.probe'); }
        catch (e) { return Promise.reject(new Error('localStorage 不可写（无痕模式或已满）')); }
        return Promise.resolve();
      },
      all: function (name) { return Promise.resolve(read(name)); },
      get: function (name, key) {
        var k = keyOf(name);
        return Promise.resolve(read(name).filter(function (r) { return r[k] === key; })[0] || null);
      },
      put: function (name, value) {
        var k = keyOf(name), rows = read(name);
        var hit = false;
        rows = rows.map(function (r) { if (r[k] === value[k]) { hit = true; return value; } return r; });
        if (!hit) rows.push(value);
        write(name, rows);
        return Promise.resolve();
      },
      del: function (name, key) {
        var k = keyOf(name);
        write(name, read(name).filter(function (r) { return r[k] !== key; }));
        return Promise.resolve();
      },
      clear: function (name) { write(name, []); return Promise.resolve(); }
    };
  }

  /* ---------- 驱动：内存（测试 / 最后兜底） ---------- */
  function memoryDriver() {
    var data = {};
    data[S_BOOKS] = []; data[S_PROGRESS] = []; data[S_SETTINGS] = [];
    function keyOf(name) { return name === S_BOOKS ? 'id' : (name === S_PROGRESS ? 'bookId' : 'key'); }
    return {
      name: 'memory',
      open: function () { return Promise.resolve(); },
      all: function (name) { return Promise.resolve(data[name].slice()); },
      get: function (name, key) {
        var k = keyOf(name);
        return Promise.resolve(data[name].filter(function (r) { return r[k] === key; })[0] || null);
      },
      put: function (name, value) {
        var k = keyOf(name), rows = data[name], hit = false;
        for (var i = 0; i < rows.length; i++) {
          if (rows[i][k] === value[k]) { rows[i] = value; hit = true; break; }
        }
        if (!hit) rows.push(value);
        return Promise.resolve();
      },
      del: function (name, key) {
        var k = keyOf(name);
        data[name] = data[name].filter(function (r) { return r[k] !== key; });
        return Promise.resolve();
      },
      clear: function (name) { data[name] = []; return Promise.resolve(); }
    };
  }

  /* ---------- 驱动：服务器（多账号模式） ---------- */
  /**
   * 2026-11-13 需求变更：书和进度必须存在服务端，换设备、清浏览器缓存都不能丢。
   * open() 拿 /api/me 探路：没登录、或这台还是单口令自用模式，就 reject，
   * 候选链自动退回 IndexedDB —— 老用法的行为一点不变。
   * 设置（音色、语速、主题）继续按设备存 localStorage：那是"这台设备的手感"，不跟账号走。
   */
  function remoteDriver(root, opts) {
    var opt = opts || {};
    var f = opt.fetch || root.fetch;
    if (!f) throw new Error('这个环境没有 fetch');
    var ls = root.localStorage || null;
    // 服务端 api_post 只看 body 里的字节做 json.loads，不读 Content-Type，所以这里不设头
    function req(method, path, body) {
      var sent = f(path, {
        method: method,
        credentials: 'same-origin',
        headers: {},
        body: body ? JSON.stringify(body) : undefined
      });
      return Promise.resolve(sent).then(function (r) {
        return r.json().then(function (d) { return { code: r.status, data: d }; },
                             function () { return { code: r.status, data: {} }; });
      }).then(function (out) {
        if (out.code === 401) throw new Error('需要登录');
        if (out.code >= 400) throw new Error((out.data && out.data.error) || ('HTTP ' + out.code));
        return out.data;
      });
    }

    function readSettings() {
      if (!ls) return [];
      try { return JSON.parse(ls.getItem(LS_KEYS.settings) || '[]'); } catch (e) { return []; }
    }
    function writeSettings(rows) {
      if (!ls) return;
      var text = JSON.stringify(rows);
      ls.setItem(LS_KEYS.settings, text);
    }

    return {
      name: 'server',
      open: function () {
        return req('GET', '/api/me').then(function (d) {
          if (!d || !d.user) throw new Error('未登录');
          return d;
        });
      },
      all: function (name) {
        if (name === S_BOOKS) return req('GET', '/api/books').then(function (d) { return d.books || []; });
        if (name === S_PROGRESS) {
          return req('GET', '/api/progress').then(function (d) {
            var map = d.progress || {};
            return Object.keys(map).map(function (k) {
              var p = map[k] || {};
              // 服务端字段叫 sentence，前端叫 cueIndex，这里是唯一的翻译处
              return { bookId: k, chapterIndex: p.chapter | 0, cueIndex: p.sentence | 0,
                       updatedAt: (Number(p.updated) || 0) * 1000 };
            });
          });
        }
        return Promise.resolve(readSettings());
      },
      get: function (name, key) {
        if (name !== S_BOOKS) return Promise.reject(new Error('服务器只放书，其它仍走本机'));
        return req('GET', '/api/books/' + encodeURIComponent(key)).then(function (d) { return d.book || null; });
      },
      put: function (name, value) {
        if (name === S_BOOKS) return req('POST', '/api/books', { book: value }).then(function () {});
        if (name === S_PROGRESS) {
          return req('POST', '/api/progress', {
            bookId: value.bookId, chapterIndex: value.chapterIndex | 0, sentence: value.cueIndex | 0
          }).then(function () {});
        }
        var rows = readSettings().filter(function (r) { return r.key !== value.key; });
        rows.push(value);
        writeSettings(rows);
        return Promise.resolve();
      },
      del: function (name, key) {
        if (name === S_BOOKS) return req('DELETE', '/api/books/' + encodeURIComponent(key)).then(function () {});
        if (name === S_PROGRESS) return req('POST', '/api/progress/clear', { bookId: key }).then(function () {});
        writeSettings(readSettings().filter(function (r) { return r.key !== key; }));
        return Promise.resolve();
      },
      clear: function (name) {
        if (name === S_PROGRESS) return req('POST', '/api/progress/clear', {}).then(function () {});
        if (name === S_BOOKS) {
          return Promise.reject(new Error('服务端没有一键清空书架，请一本本删（回收站也没做，别一键清）'));
        }
        writeSettings([]);
        return Promise.resolve();
      }
    };
  }

  /* ---------- 上层 API ---------- */
  function createStore(candidates) {
    var driver = null;
    var lastError = '';

    /**
     * 逐个尝试候选驱动。同步抛错与异步 reject **都要**继续下一个
     * （第一版只处理了同步抛错，被单测抓出来了）。
     */
    function init() {
      var i = 0;
      function attempt() {
        if (i >= candidates.length) return Promise.resolve(null);
        var d = candidates[i++];
        try {
          return Promise.resolve(d.open()).then(function () {
            driver = d;
            return d.name;
          }, function (e) {
            lastError = (e && e.message) || String(e);
            return attempt();
          });
        } catch (e) {
          lastError = (e && e.message) || String(e);
          return attempt();
        }
      }
      return attempt();
    }

    function ensure() { if (!driver) return Promise.reject(new Error('没有可用的存储')); return null; }

    return {
      init: init,
      backend: function () { return driver ? driver.name : 'none'; },
      lastError: function () { return lastError; },

      /** 一次性读出上层需要的全部状态 */
      loadAll: function () {
        var e = ensure(); if (e) return e;
        return Promise.all([
          driver.all(S_BOOKS), driver.all(S_PROGRESS), driver.all(S_SETTINGS)
        ]).then(function (r) {
          var progress = {};
          (r[1] || []).forEach(function (p) { if (p && p.bookId) progress[p.bookId] = p; });
          var settings = (r[2] || []).filter(function (s) { return s.key === 'app'; })[0];
          return { books: r[0] || [], progress: progress, settings: settings ? settings.value : null };
        });
      },

      saveBook: function (book) {
        var e = ensure(); if (e) return e;
        return driver.put(S_BOOKS, book);
      },
      saveBooks: function (list) {
        var e = ensure(); if (e) return e;
        return (list || []).reduce(function (p, b) { return p.then(function () { return driver.put(S_BOOKS, b); }); },
          Promise.resolve());
      },
      /** 删书必须连进度一起删，否则书架上会留下无主的进度记录 */
      removeBook: function (bookId) {
        var e = ensure(); if (e) return e;
        return driver.del(S_BOOKS, bookId).then(function () { return driver.del(S_PROGRESS, bookId); });
      },
      saveProgress: function (p) {
        var e = ensure(); if (e) return e;
        return driver.put(S_PROGRESS, p);
      },
      clearProgress: function () {
        var e = ensure(); if (e) return e;
        return driver.clear(S_PROGRESS);
      },
      saveSettings: function (value) {
        var e = ensure(); if (e) return e;
        return driver.put(S_SETTINGS, { key: 'app', value: value });
      },
      wipeAll: function () {
        var e = ensure(); if (e) return e;
        return Promise.all([driver.clear(S_BOOKS), driver.clear(S_PROGRESS), driver.clear(S_SETTINGS)]);
      }
    };
  }

  /**
   * 旧版 localStorage(v1) 数据迁移：只搬不覆盖，返回可直接丢弃旧键的标记。
   * @param oldBooks 数组, oldProgress 映射, oldSettings 对象
   */
  function legacyToRecords(oldBooks, oldProgress, oldSettings) {
    var books = (oldBooks || []).map(function (b) {
      b.source = b.source || 'local';
      b._legacy = true;
      return b;
    });
    var progress = Object.keys(oldProgress || {}).map(function (k) { return oldProgress[k]; })
      .filter(function (p) { return p && p.bookId; });
    return { books: books, progress: progress, settings: oldSettings || null };
  }

  var api = {
    DB_NAME: DB_NAME, S_BOOKS: S_BOOKS, S_PROGRESS: S_PROGRESS, S_SETTINGS: S_SETTINGS,
    idbDriver: idbDriver, localDriver: localDriver, memoryDriver: memoryDriver,
    remoteDriver: remoteDriver,
    createStore: createStore, legacyToRecords: legacyToRecords,
    /** 浏览器默认候选链：服务器 → IDB → localStorage → 内存 */
    createDefault: function (root) {
      root = root || global;
      var cands = [];
      // 服务器排在最前：/api/me 探不过（没登录、或这台还是单口令自用）就自动退回本机存储
      try { cands.push(remoteDriver(root)); } catch (e) {}
      try { cands.push(idbDriver(root)); } catch (e) {}
      try { cands.push(localDriver(root)); } catch (e) {}
      cands.push(memoryDriver());
      return createStore(cands);
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ReadItStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
