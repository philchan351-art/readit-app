/*
 * diag.js —— 自用保命层（不依赖其它模块；自己坏了也要能说出来）
 *
 * 治两件事：
 *   1) "用几天书突然没了" —— 申请持久化存储 navigator.storage.persist()，结果如实显示；
 *   2) "反馈全靠描述" —— 侧栏「导出诊断」把环境 + 书籍元信息（不含正文）+ 最近报错导成 JSON。
 *
 * ⚠ 接口注意（上一版就是踩了这个坑，导出的文件全空）：
 *   js/store.js 暴露的是**工厂** ReadItStore = { createDefault, createStore, 各驱动, legacyToRecords }，
 *   实例方法（init/loadAll/saveBook/backend…）只在 createDefault() 返回的对象上。
 *   所以这里必须 createDefault() + init() 才能读到数据，不能直接 ReadItStore.loadAll()。
 *   每个字段单独 try，失败就把原因写进 recentErrors —— 诊断工具不许静默返回空。
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var errors = [];
  var MAX_ERRORS = 60;

  function note(kind, e, where) {
    var msg = (e && e.message) ? e.message : (e == null ? '' : String(e));
    errors.push({ kind: kind, msg: msg.slice(0, 300), at: Date.now(),
                  where: String(where || '').slice(0, 120) });
    if (errors.length > MAX_ERRORS) errors.shift();
  }

  global.addEventListener('error', function (e) {
    note('error', e.message, e.filename ? String(e.filename).split('/').pop() + ':' + e.lineno : '');
  }, true);   // capture=true：<script> 加载失败也记得到诊断里
  // 用捕获阶段，才能收到 <script> 加载失败这类资源错误（不冒泡）
  global.addEventListener('unhandledrejection', function (e) {
    note('unhandled', e.reason, '');
  });

  /* ---------- 持久化 ---------- */
  var persistState = 'unsupported';
  function requestPersist() {
    var s = global.navigator && global.navigator.storage;
    if (!s || typeof s.persist !== 'function') return Promise.resolve(persistState);
    return Promise.resolve(typeof s.persisted === 'function' ? s.persisted() : false)
      .then(function (already) {
        if (already) { persistState = 'persisted'; return persistState; }
        return s.persist().then(function (granted) {
          persistState = granted ? 'granted' : 'denied';
          render();
          return persistState;
        });
      })
      .catch(function (e) { persistState = 'error'; note('persist', e); render(); return persistState; });
  }

  /* ---------- 拿到 store 实例（工厂 → 实例） ---------- */
  var storePromise = null;
  function storeInstance() {
    if (storePromise) return storePromise;
    var R = global.ReadItStore;
    storePromise = Promise.resolve(null)
      .then(function () {
        if (global.__readitStore && typeof global.__readitStore.loadAll === 'function') {
          return global.__readitStore;
        }
        if (!R) { note('store', 'ReadItStore 未加载'); return null; }
        var inst = null;
        if (typeof R.createDefault === 'function') inst = R.createDefault();
        else if (typeof R.loadAll === 'function') inst = R;          // 万一哪天它直接是单例
        if (!inst || typeof inst.loadAll !== 'function') {
          note('store', '拿不到可用的 store 实例（既无 createDefault 也无 loadAll）');
          return null;
        }
        return Promise.resolve(typeof inst.init === 'function' ? inst.init() : null)
          .then(function () { return inst; },
                function (e) { note('store-init', e); return inst; });
      });
    return storePromise;
  }

  /* ---------- 快照 ---------- */
  function ttsInfo() {
    var out = { available: !!global.speechSynthesis, voices: 0, zhVoices: [] };
    try {
      var v = global.speechSynthesis.getVoices() || [];
      out.voices = v.length;
      out.zhVoices = v.filter(function (x) { return /^zh/i.test(x.lang || ''); })
                      .slice(0, 12).map(function (x) { return x.name + ' · ' + x.lang; });
    } catch (e) { note('tts', e); }
    return out;
  }

  function snapshot() {
    var d = {
      kind: 'readit-diagnostic',
      capturedAt: new Date().toString(),
      userAgent: global.navigator ? global.navigator.userAgent : '',
      pageProtocol: global.location ? global.location.protocol : '',
      persist: persistState,
      storage: {},
      tts: {},
      books: [],
      progressCount: 0,
      recentErrors: errors.slice(-30)
    };

    d.tts = ttsInfo();

    return storeInstance().then(function (store) {
      if (!store) return d;
      try {
        d.storage.backend = (typeof store.backend === 'function') ? store.backend() : (store.mode || 'unknown');
      } catch (e) { note('storage.backend', e); }

      return Promise.resolve(store.loadAll()).then(function (all) {
        all = all || {};
        var books = all.books || [];
        var chars = 0;
        d.books = books.map(function (b) {
          var bc = 0;
          (b.chapters || []).forEach(function (c) { bc += (c.text || '').length; });
          chars += bc;
          return { id: b.id, title: b.title, format: b.format || b.source || '?',
                   chapters: (b.chapters || []).length, chars: bc,
                   addedAt: b.addedAt || null, size: b.size || null };   // 只导元信息，不导正文
        });
        d.progressCount = Object.keys(all.progress || {}).length;
        d.storage.bookCount = d.books.length;
        d.storage.totalChars = chars;
        return d;
      }, function (e) { note('loadAll', e); return d; });
    });
  }

  /* ---------- 自己的提示条（不依赖 app.js 的 toast） ---------- */
  function flash(text) {
    if (!doc.body) return;
    var el = doc.getElementById('diag-flash');
    if (!el) {
      el = doc.createElement('div');
      el.id = 'diag-flash';
      el.setAttribute('style', 'position:fixed;left:50%;bottom:26px;transform:translateX(-50%);' +
        'background:#1f2328;color:#fff;padding:9px 16px;border-radius:999px;font-size:13px;' +
        'box-shadow:0 6px 20px rgba(0,0,0,.3);z-index:99');
      doc.body.appendChild(el);
    }
    el.textContent = text;
    el.style.opacity = '1';
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; }, 2200);
  }

  function exportDiag() {
    snapshot().then(function (d) {
      var name = 'readit-diag-' + new Date().toISOString().slice(0, 10) + '.json';
      var blob = new global.Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
      var url = global.URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url; a.download = name;
      doc.body.appendChild(a); a.click(); doc.body.removeChild(a);
      setTimeout(function () { global.URL.revokeObjectURL(url); }, 2000);
      var empty = !d.books.length && !d.recentErrors.length;
      flash('诊断已导出 ' + name +
            '（' + d.books.length + ' 本 / 后端 ' + (d.storage.backend || '?') +
            ' / ' + d.recentErrors.length + ' 条报错）' + (empty ? ' ⚠ 内容偏少，可能没读到存储' : ''));
    }, function (e) {
      note('export', e);
      flash('诊断导出失败：' + ((e && e.message) || e));
    });
  }

  /* ---------- UI ---------- */
  var PERSIST_TEXT = {
    persisted: '存储：已持久化，浏览器不会随便清库',
    granted: '存储：已申请到持久化',
    denied: '存储：浏览器未答应持久化 —— 空间紧张时可能被清，请定期「导出备份」',
    error: '存储：持久化查询出错，详见「导出诊断」',
    unsupported: '存储：此浏览器不支持持久化申请 —— 请定期「导出备份」'
  };
  function render() {
    var line = doc.getElementById('persist-line');
    if (!line) return;
    // 书已经在服务器上就别再拿「浏览器可能清库」吓人了 —— 两条提示互相打脸
    var backend = '';
    try {
      var app = global.ReadItApp;
      backend = (app && typeof app.storeInfo === 'function') ? app.storeInfo() : '';
    } catch (e) { backend = ''; }
    if (backend === 'server') {
      line.textContent = '存储：书与进度在服务器上，按账号保存；浏览器只是缓存，清缓存不丢书';
      return;
    }
    line.textContent = PERSIST_TEXT[persistState] || PERSIST_TEXT.unsupported;
  }

  function mount() {
    var foot = doc.querySelector('.side-foot');
    if (!foot) { note('mount', '找不到 .side-foot，诊断按钮没挂上'); return; }

    var row = doc.createElement('div');
    row.className = 'backup-row';
    var btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn small';
    btn.id = 'btn-diag';
    btn.textContent = '导出诊断';
    btn.title = '导出环境与最近报错（只含书名等元信息，不含正文）';
    btn.addEventListener('click', exportDiag);
    row.appendChild(btn);

    var line = doc.createElement('p');
    line.className = 'hint';
    line.id = 'persist-line';
    line.style.color = 'var(--dim)';

    var hint = foot.querySelector('.hint');
    if (hint) { foot.insertBefore(row, hint); foot.insertBefore(line, hint); }
    else { foot.appendChild(row); foot.appendChild(line); }
    render();
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', mount);
  else mount();

  requestPersist().then(render);

  global.ReadItDiag = {
    snapshot: snapshot, exportDiag: exportDiag,
    errors: function () { return errors.slice(); },
    persist: function () { return persistState; },
    /** 存储层就绪后再刷一次：不然页脚那句「浏览器可能清库」会赶在知道是服务器存储之前定型 */
    refresh: render
  };
})(typeof window !== 'undefined' ? window : globalThis);
