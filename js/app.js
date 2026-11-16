/*
 * app.js —— UI 编排层
 * 依赖：core.js（逻辑）、tts.js（朗读后端）、books-data.js（示例内容）
 *
 * 唯一的状态主线：state.pos = { chapterIndex, cueIndex }
 *   看书与听书共用它，因此「接续」不需要任何换算逻辑。
 */
(function (global) {
  'use strict';

  var core = global.ReadItCore;
  var parse = global.ReadItParse;
  var doc = global.document;
  var LEGACY_KEYS = { books: 'readit.books.v1', progress: 'readit.progress.v1', settings: 'readit.settings.v1' };
  var store = null;              // ReadItStore 实例，boot() 里初始化
  var progressTimer = null;      // 进度写入防抖：朗读时每句都会更新，不能每句都开一次事务
  var shelfPercent = -1;         // 书架百分比文本的变化检测，避免每句重绘整个书架

  var THEMES = ['paper', 'sepia', 'dark'];
  var FONT_STEPS = [15, 16, 17, 18, 20, 22, 24, 26];

  var els = {};
  var pageCache = null;          // 当前章的装箱结果 { pages:[{s,e}], paras:[[..]], key }
  var lastSwipeAt = 0;           // 滑动翻页后抑制浏览器补发的 click，防止双翻
  var state = {
    books: [],
    progress: {},
    settings: { theme: 'paper', fontStep: 2, rate: 1, voiceId: '', autoNext: true, engine: 'system',
                hiddenSamples: [], lastBookId: '' },
    bookId: null,
    pos: { chapterIndex: 0, cueIndex: 0 },
    pageIndex: 0,
    mode: 'read',
    follow: true,
    sleepAt: 0,
    sleepTimer: null
  };

  /* ================= 启动 ================= */

  function boot() {
    ['shelf', 'shelf-count', 'file-input', 'btn-import', 'btn-clear-progress', 'btn-open-sample',
     'empty-state', 'workbench', 'book-title', 'book-sub', 'btn-back', 'mode-read', 'mode-listen',
     'btn-prev-chapter', 'btn-next-chapter', 'chapter-select', 'ratio', 'progress-fill', 'reader',
     'listen-panel', 'btn-play', 'btn-prev-cue', 'btn-next-cue', 'btn-stop', 'rate', 'rate-val',
     'voice-select', 'engine-select', 'sleep-select', 'sleep-text', 'auto-next', 'status-text', 'tts-warn', 'toast',
     'btn-font-minus', 'btn-font-plus', 'btn-theme',
       'btn-export', 'btn-import-backup', 'backup-input', 'btn-show-samples',
       'topbar', 'chapter-bar',
       'title-page', 'tp-cover', 'tp-title', 'tp-author', 'tp-line', 'tp-toc',
       'btn-tp-continue', 'btn-tp-restart', 'btn-tp-back'].forEach(function (id) {
      els[id] = doc.getElementById(id);
    });

    store = global.ReadItStore.createDefault(global);
    store.init().then(function () { return store.loadAll(); }).then(function (all) {
      var legacy = readLegacy();
      if (!legacy) return all;
      return migrateLegacy(legacy).then(function () { return store.loadAll(); });
    }).then(function (all) {
      state.settings = Object.assign({}, state.settings, all.settings || {});
      state.progress = all.progress || {};
      state.books = visibleSamples(global.ReadItSamples).concat(all.books || []);

      applySettings();
      bindEvents();
      renderShelf();
      setupTts();

      if (!engine.supported) {
        warn('当前浏览器不提供语音合成（Web Speech API）。可用方案：① 改用桌面 Edge / Chrome 打开' +
             '（Windows 11 的自然音色只在 Edge 里出现）；② 按 docs/技术选型与成本路线.md §3.5 接 BYOK 云端 TTS。');
      }
      if (global.ReadItDiag && global.ReadItDiag.refresh) global.ReadItDiag.refresh();
      if (store.backend() === 'server') {
        warn('已连上服务器存储：书和进度按账号保存，换设备、清缓存都不丢。');
      } else if (store.backend() !== 'indexeddb') {
        warn('本机存储回落到「' + store.backend() + '」模式（IndexedDB 不可用，常见于无痕窗口或 file:// 限制）。' +
             '书架与进度仍能保存，但容量较小；建议用正常窗口的桌面 Edge 打开。');
      }
      // 「在上次基础上继续」：有上次在看的书就自动进入该书、跳到已存句位。
      // lastBookId 是本机设置：明确点「返回书架」会清掉，下次启动就停在书架。
      if (state.settings.lastBookId && bookById(state.settings.lastBookId)) {
        openBook(state.settings.lastBookId);
      }
      // 上次在带服务器的地址上选了云端音色，这次改用纯静态地址打开也要自洽，不能闷声。
      // 这里只在「确定没有中转」时才动设置，网络抖一下就把人切走是更糟的体验。
      if (state.settings.engine === 'cloud') {
        probeCloud().then(function (s) {
          if (s === 'none') {
            applyEngine('system');
            warn('之前选的是云端音色，但这个地址上没有 TTS 中转服务，已切回系统音色。');
          }
        });
      }
    }).catch(function (e) {
      // 存储坏了也不能白屏：示例书照样能读，只是不保存
      state.books = (global.ReadItSamples || []).slice();
      applySettings();
      bindEvents();
      renderShelf();
      setupTts();
      warn('本机存储初始化失败：' + ((e && e.message) || e) + '。示例书可以正常阅读，但导入的书与进度不会保存。');
    });
  }

  /* ================= 存储（IndexedDB 优先 → localStorage → 内存） ================= */

  function readLegacy() {
    try {
      var books = JSON.parse(global.localStorage.getItem(LEGACY_KEYS.books) || '[]');
      var progress = JSON.parse(global.localStorage.getItem(LEGACY_KEYS.progress) || '{}');
      var settings = JSON.parse(global.localStorage.getItem(LEGACY_KEYS.settings) || 'null');
      if (!books.length && !Object.keys(progress).length && !settings) return null;
      return { books: books, progress: progress, settings: settings };
    } catch (e) { return null; }
  }

  function migrateLegacy(legacy) {
    var rec = global.ReadItStore.legacyToRecords(legacy.books, legacy.progress, legacy.settings);
    return store.saveBooks(rec.books)
      .then(function () {
        return rec.progress.reduce(function (p, item) {
          return p.then(function () { return store.saveProgress(item); });
        }, Promise.resolve ? Promise.resolve() : Promise.resolve());
      })
      .then(function () { return store.saveSettings(rec.settings); })
      .then(function () {
        ['books', 'progress', 'settings'].forEach(function (k) {
          try { global.localStorage.removeItem(LEGACY_KEYS[k]); } catch (e) {}
        });
        if (rec.books.length || rec.progress.length) {
          toast('已从旧版本迁移：' + rec.books.length + ' 本书、' + rec.progress.length + ' 条进度');
        }
      })
      .catch(function () { /* 迁移失败不影响本次使用，旧键也先留着 */ });
  }

  function persistBook(book) {
    if (!store || book.source !== 'local') return Promise.resolve();
    return store.saveBook(book).catch(function (e) {
      toast('保存《' + book.title + '》失败：' + ((e && e.message) || e));
    });
  }

  /** 保留旧函数名：把当前所有本地导入的书整体写一遍（恢复备份时用） */
  function persistImportedBooks() {
    if (!store) return Promise.resolve ? Promise.resolve() : Promise.resolve();
    var local = state.books.filter(function (b) { return b.source === 'local'; });
    return store.saveBooks(local).catch(function (e) {
      toast('保存失败：' + ((e && e.message) || e));
    });
  }

  function persistProgressAll() {
    if (!store) return;
    var keys = Object.keys(state.progress);
    keys.forEach(function (k) {
      store.saveProgress(state.progress[k]).catch(function () {});
    });
  }

  function saveSettings() {
    if (!store) return;
    store.saveSettings(state.settings).catch(function () {});
  }

  /* ================= 书与章节模型 ================= */

  function bookById(id) {
    for (var i = 0; i < state.books.length; i++) if (state.books[i].id === id) return state.books[i];
    return null;
  }

  /** 为书构建 cue（句）索引；结果缓存在 book._cues */
  function cuesOf(book, chapterIndex) {
    if (!book._cues) book._cues = {};
    if (!book._cues[chapterIndex]) {
      var ch = book.chapters[chapterIndex];
      book._cues[chapterIndex] = ch ? core.splitSentences(ch.text) : [];
    }
    return book._cues[chapterIndex];
  }
  function cueCounts(book) {
    if (!book._counts) {
      book._counts = book.chapters.map(function (_, i) { return cuesOf(book, i).length; });
    }
    return book._counts;
  }
  function currentBook() { return bookById(state.bookId); }

  /* ================= 书架 ================= */

  // 内置样书不在存储层里（软件自带内容），所以对它只能记「隐藏名单」，不能走真删除
  function visibleSamples(list) {
    var hidden = (state.settings && state.settings.hiddenSamples) || [];
    return (list || []).slice().filter(function (b) { return hidden.indexOf(b.id) < 0; });
  }

  // 「是不是内置样书」按 id 判定，不按 book.source：备份恢复进来的书 source 字段不一定规范，
  // 误判会让它走隐藏分支而不是真删除，结果就是「点了删除却怎么也删不掉」。
  function isSampleBook(book) {
    var hit = false;
    (global.ReadItSamples || []).forEach(function (b) { if (b.id === book.id) hit = true; });
    return hit;
  }

  function renderShelf() {
    var shelf = els.shelf;
    shelf.innerHTML = '';
    els['shelf-count'].textContent = '(' + state.books.length + ')';
    if (els['btn-show-samples']) {
      els['btn-show-samples'].hidden = !(state.settings.hiddenSamples || []).length;
    }

    state.books.forEach(function (b) {
      var p = state.progress[b.id];
      // 卡片和删除按钮是兄弟节点：button 里再套 button 是非法 HTML，iOS Safari 上点击归属不可靠
      var wrap = doc.createElement('div');
      wrap.className = 'book-wrap';

      var btn = doc.createElement('button');
      btn.className = 'book-item' + (b.id === state.bookId ? ' active' : '');
      btn.type = 'button';

      var cover = doc.createElement('div');
      cover.className = 'cover';
      cover.style.background = 'linear-gradient(150deg,' + b.cover.from + ',' + b.cover.to + ')';
      // 首字已全局隐藏（app.css 基础规则 .cover-letter{display:none}，2026-11-14 用户指定）；
      // span 照旧生成，恢复显示只需删那条 CSS，不动这里的 DOM
      var letter = doc.createElement('span');
      letter.className = 'cover-letter';
      letter.setAttribute('aria-hidden', 'true');
      letter.textContent = b.title.slice(0, 1);
      cover.appendChild(letter);

      var meta = doc.createElement('div');
      meta.className = 'book-meta';
      var t = doc.createElement('b'); t.textContent = b.title;
      var a = doc.createElement('span'); a.textContent = b.author + ' · ' + b.chapters.length + ' 章';
      meta.appendChild(t); meta.appendChild(a);

      var progressText = '';
      if (p) {
        var e = doc.createElement('em');
        var ch = b.chapters[p.chapterIndex];
        var ratio = Math.round(core.readingRatio(cueCounts(b), p.chapterIndex, p.cueIndex) * 100);
        progressText = ratio + '% ' + (ch ? ch.title : '');
        e.textContent = ratio + '% · ' + (ch ? ch.title : '');
        meta.appendChild(e);
      }

      btn.appendChild(cover); btn.appendChild(meta);
      btn.setAttribute('aria-label', b.title + '，' + b.author + '，共 ' + b.chapters.length + ' 章' +
        (progressText ? '，已读 ' + progressText : ''));
      btn.addEventListener('click', function () { openBook(b.id); });

      var del = doc.createElement('button');
      del.type = 'button';
      del.className = 'book-del';
      del.textContent = '×';
      del.title = (isSampleBook(b) ? '隐藏内置样书《' : '删除《') + b.title + '》';
      del.setAttribute('aria-label', del.title);
      del.addEventListener('click', function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); removeBook(b); });

      wrap.appendChild(btn); wrap.appendChild(del);
      shelf.appendChild(wrap);
    });
  }

  /* ================= 删除书架上的书 ================= */

  function removeBook(book) {
    var builtin = isSampleBook(book);
    var msg = !builtin
      ? '删除《' + book.title + '》？\n\n正文和阅读进度会一起删掉，删完找不回来（除非你导出过备份）。'
      : '隐藏内置样书《' + book.title + '》？\n\n样书是软件自带的，不会真的删除，之后点书架上方的「显示内置样书」就能恢复。';
    if (!global.confirm(msg)) return;

    if (builtin) {
      var hid = (state.settings.hiddenSamples || []).slice();
      if (hid.indexOf(book.id) < 0) hid.push(book.id);
      state.settings.hiddenSamples = hid;
      saveSettings();
      dropFromShelf(book.id);
      toast('已隐藏样书《' + book.title + '》');
      return;
    }

    // 真删除：等存储层确认成功再改界面，避免「界面没了但服务端还在」这种不一致
    if (!store) { dropFromShelf(book.id); toast('已删除《' + book.title + '》（本机存储不可用，仅本次生效）'); return; }
    store.removeBook(book.id).then(function () {
      dropFromShelf(book.id);
      toast('已删除《' + book.title + '》');
    }).catch(function (e) {
      toast('删除《' + book.title + '》失败：' + ((e && e.message) || e) + '。书还在书架上，没有改动。');
    });
  }

  function dropFromShelf(bookId) {
    state.books = state.books.filter(function (b) { return b.id !== bookId; });
    delete state.progress[bookId];
    if (state.bookId === bookId) {
      if (engine && engine.stop) { try { engine.stop(); } catch (e) { /* 忽略 */ } }
      state.bookId = null;
      els.workbench.hidden = true;
      els['empty-state'].hidden = false;
    }
    renderShelf();
  }

  function showHiddenSamples() {
    state.settings.hiddenSamples = [];
    saveSettings();
    // 按内置顺序重建，别用 unshift 逐本插，否则恢复后样书顺序会整个倒过来。
    // 判断「是不是样书」按 id 而不是按 source：备份恢复可能带进 source 不规范的书，不能把它们弄丢。
    var sampleId = {};
    (global.ReadItSamples || []).forEach(function (b) { sampleId[b.id] = true; });
    var keep = state.books.filter(function (b) { return !sampleId[b.id]; });
    state.books = visibleSamples(global.ReadItSamples).concat(keep);
    renderShelf();
    toast('内置样书已恢复');
  }

  /* ================= 打开书 / 渲染章节 ================= */

  function openBook(id) {
    var book = bookById(id);
    if (!book) return;
    state.bookId = id;
    var p = state.progress[id];
    state.pos = p ? { chapterIndex: p.chapterIndex, cueIndex: p.cueIndex }
                  : { chapterIndex: 0, cueIndex: 0 };
    state.follow = true;
    pageCache = null;

    els['empty-state'].hidden = true;
    els.workbench.hidden = false;
    els['book-title'].textContent = book.title;
    els['book-sub'].textContent = book.author + ' · ' + book.intro;

    renderChapterSelect(book);
    renderShelf();
    // 选书后先落扉页（书名/读到哪/目录/一键继续），不再一上来糊一整屏从头到尾的正文
    renderTitlePage(book);
    // 记住这台设备最后在看的书：下次冷启动直接进扉页，一键回到上次那句
    if (state.settings.lastBookId !== id) { state.settings.lastBookId = id; saveSettings(); }
  }

  /* ================= 扉页 ================= */

  function renderTitlePage(book) {
    var p = state.progress[book.id];
    var cov = els['tp-cover'];
    cov.style.background = 'linear-gradient(150deg,' +
      ((book.cover && book.cover.from) || '#2f6f5f') + ',' +
      ((book.cover && book.cover.to) || '#6aa88f') + ')';
    els['tp-title'].textContent = book.title;
    els['tp-author'].textContent = book.author + ' · 共 ' + book.chapters.length + ' 章';

    if (p) {
      var ratio = Math.round(core.readingRatio(cueCounts(book), p.chapterIndex, p.cueIndex) * 100);
      var ch = book.chapters[p.chapterIndex];
      els['tp-line'].textContent = '上次阅读 ' + ratio + '%' + (ch ? ' · ' + ch.title : '');
      els['btn-tp-continue'].textContent = ratio >= 99 ? '已读完 · 从头重读' : '继续阅读';
    } else {
      els['tp-line'].textContent = '还没开始 · 直接开读或从目录挑一章';
      els['btn-tp-continue'].textContent = '开始阅读';
    }

    var toc = els['tp-toc'];
    toc.innerHTML = '';
    book.chapters.forEach(function (ch, i) {
      var li = doc.createElement('li');
      var b = doc.createElement('b');
      b.textContent = ch.title;
      li.appendChild(b);
      if (p && i === p.chapterIndex) {
        li.className = 'cur';
        var em = doc.createElement('em');
        em.textContent = '上次在这';
        li.appendChild(em);
      }
      li.addEventListener('click', function () {
        state.pos = { chapterIndex: i, cueIndex: 0 };
        saveProgress('read');
        startReading(false);
      });
      toc.appendChild(li);
    });
    showTitlePage(true);
  }

  function showTitlePage(on) {
    els['title-page'].hidden = !on;
    els.topbar.hidden = on;
    els['chapter-bar'].hidden = on;
    els.reader.hidden = on;
    els['listen-panel'].hidden = on || state.mode !== 'listen';
  }

  /** 从扉页进入正文。fromStart=true 表示「从头开始」 */
  function startReading(fromStart) {
    if (fromStart) {
      state.pos = { chapterIndex: 0, cueIndex: 0 };
      saveProgress('read');
    }
    showTitlePage(false);
    renderChapter();
    updateStatus();
  }

  function renderChapterSelect(book) {
    var sel = els['chapter-select'];
    sel.innerHTML = '';
    book.chapters.forEach(function (ch, i) {
      var o = doc.createElement('option');
      o.value = String(i); o.textContent = ch.title;
      sel.appendChild(o);
    });
    sel.value = String(state.pos.chapterIndex);
  }

  /* ================= 分页排版引擎 =================
     一章按「句」装箱成整屏书页：往真实页面容器里一句句加，
     超出页高就把这句退回下一页。测量用的就是真实渲染样式，
     所以永远不会出现「算出来能放下、实际溢出」。页码 → 首句句号，
     进度依旧是句级（state.pos.cueIndex），看书/听书共用不受影响。 */

  /** 章内句子按源文本的换行归段：[[0,1,2],[3,4],...] */
  function chapterParas(book, ci) {
    var ch = book.chapters[ci];
    var cues = cuesOf(book, ci);
    var paras = [];
    var cur = [];
    var cursor = 0;
    for (var i = 0; i < cues.length; i++) {
      cur.push(i);
      cursor = cues[i].end;
      var nextBefore = (i + 1 < cues.length) ? ch.text.slice(cursor, cues[i + 1].start) : '';
      if (/[\n\r]/.test(nextBefore) || /[\n\r]\s*$/.test(cues[i].text) || i === cues.length - 1) {
        paras.push(cur);
        cur = [];
      }
    }
    if (cur.length) paras.push(cur);
    return paras;
  }

  function pageKey(book, ci) {
    var box = els.reader.querySelector('.page-text');
    var w = box ? box.clientWidth : 0;
    var h = box ? box.clientHeight : 0;
    return [book.id, ci, state.settings.fontStep, w, h, state.settings.theme].join('|');
  }

  var PAGE_END_TEXT = '本章完 · 再点一下右边继续 →';

  /**
   * 把一章装进页面盒，返回 [{s,e}] 页区间。
   * 逐页测量：每页装箱前把盒子清回「占位标题」基线再一句句加。
   * 两个真机实测换来的规矩，别再改回去：
   *  ① 占位标题恒在——渲染时第 1 页有真标题，测量必须按同一高度扣；
   *  ② 「本章完」占位块恒挂在测量尾部——它只在末章渲染，但若不按它预留，
   *     末句的段末 margin 会被 overflow:hidden 吞进父元素（实测装箱峰值 621、
   *     渲染真实 644），页尾就裁字。宁可每页少装一行，绝不少一行读不到。
   */
  function packPages(book, ci) {
    var cues = cuesOf(book, ci);
    if (!cues.length) return [{ s: 0, e: 0 }];
    var box = els.reader.querySelector('.page-text');
    var base = '<h2 class="page-title title-ghost" aria-hidden="true">' +
               esc(book.chapters[ci].title) + '</h2>';
    var flat = [];
    chapterParas(book, ci).forEach(function (pr) {
      pr.forEach(function (i) { flat.push(i); });
    });

    var pages = [];
    var f = 0;
    while (f < flat.length) {
      box.innerHTML = base;
      var start = flat[f];
      var lastFit = start - 1;
      var curP = null;
      while (f < flat.length) {
        var i = flat[f];
        if (!curP) { curP = doc.createElement('p'); box.appendChild(curP); }
        var sp = doc.createElement('span');
        sp.className = 'cue';
        sp.setAttribute('data-i', String(i));
        sp.textContent = cues[i].text.trim();
        curP.appendChild(sp);
        var pe = doc.createElement('div');
        pe.className = 'page-end';
        pe.textContent = PAGE_END_TEXT;
        box.appendChild(pe);                       // 占位块永远在盒子最尾
        if (i > start && box.scrollHeight > box.clientHeight + 1) {
          curP.removeChild(sp);
          if (!curP.childNodes.length) curP.parentNode.removeChild(curP);
          box.removeChild(pe);
          curP = null;
          break;                                   // 本页装满；i 留给下一页（f 不动）
        }
        lastFit = i;
        f++;
      }
      pages.push({ s: start, e: lastFit });
      // 防死锁：一页连一句加占位都放不下时，也把它记为一页并前进，绝不原地打转
      if (lastFit < start) { lastFit = start; f = Math.max(f, flat.indexOf(start) + 1); }
    }
    return pages;
  }

  function renderChapter() {
    var book = currentBook();
    if (!book) return;
    var ci = state.pos.chapterIndex;

    els.reader.innerHTML =
      '<div class="page-box"><div class="page-text"></div>' +
      '<footer class="page-foot"><span class="pf-ch"></span><span class="pf-page"></span></footer></div>';
    els['chapter-select'].value = String(ci);

    pageCache = { pages: packPages(book, ci), paras: chapterParas(book, ci), key: pageKey(book, ci) };
    showPage(core.findPage(pageCache.pages, state.pos.cueIndex), false);
    highlight(state.pos.cueIndex, false);
    updateRatio();
  }

  /** 渲染第 pi 页。remember=true 时把进度记到这一页的第一句（翻页即「读到这」） */
  function showPage(pi, remember) {
    var book = currentBook();
    if (!book || !pageCache) return;
    var ci = state.pos.chapterIndex;
    var pages = pageCache.pages;
    var cues = cuesOf(book, ci);
    pi = core.clamp(pi, 0, pages.length - 1);
    state.pageIndex = pi;
    var pg = pages[pi];
    if (remember) {
      state.pos.cueIndex = pg.s;
      saveProgress('read');
      updateRatio();
      updateStatus();
    }

    var html = [];
    if (pi === 0) html.push('<h2 class="page-title">', esc(book.chapters[ci].title), '</h2>');
    pageCache.paras.forEach(function (pr) {
      var s = Math.max(pr[0], pg.s);
      var e = Math.min(pr[pr.length - 1], pg.e);
      if (s > e) return;
      html.push('<p>');
      for (var i = s; i <= e && i < cues.length; i++) {
        html.push('<span class="cue" data-i="', String(i), '">', esc(cues[i].text.trim()), '</span>');
      }
      html.push('</p>');
    });
    if (pi === pages.length - 1) {
      html.push('<div class="page-end">',
                ci < book.chapters.length - 1 ? PAGE_END_TEXT : '全书完',
                '</div>');
    }
    var box = els.reader.querySelector('.page-text');
    box.innerHTML = html.join('');
    var foot = els.reader.querySelector('.page-foot');
    foot.querySelector('.pf-ch').textContent = book.chapters[ci].title;
    foot.querySelector('.pf-page').textContent =
      (pi + 1) + ' / ' + pages.length + ' 页 · ' +
      Math.round(core.readingRatio(cueCounts(book), ci, pg.s) * 100) + '%';
  }

  /** 翻页。dir=+1 下一页 / -1 上一页；页界外的翻页自然衔接下一章/上一章 */
  function turnPage(dir) {
    var book = currentBook();
    if (!book || !pageCache || !els['title-page'].hidden) return;
    var np = state.pageIndex + dir;
    if (np < 0) {
      if (state.pos.chapterIndex > 0) {
        var prevCi = state.pos.chapterIndex - 1;
        gotoChapter(prevCi, Math.max(0, cuesOf(book, prevCi).length - 1));
      }
      return;
    }
    if (np >= pageCache.pages.length) {
      if (state.pos.chapterIndex < book.chapters.length - 1) {
        gotoChapter(state.pos.chapterIndex + 1, 0);
      } else {
        toast('已经读完全书了');
      }
      return;
    }
    showPage(np, true);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ================= 定位与高亮（分页版） =================
     DOM 里只有当前页的句子，高亮按 data-i 匹配；
     要找的句子不在本页（朗读走到页尾、点句跳读、恢复进度）就先翻到那页。 */

  function highlight(cueIndex) {
    if (!currentBook() || !pageCache) return;
    var pi = core.findPage(pageCache.pages, cueIndex);
    if (pi !== state.pageIndex) showPage(pi, false);
    var list = els.reader.querySelectorAll('.page-text .cue');
    for (var i = 0; i < list.length; i++) {
      list[i].classList.toggle('active', Number(list[i].getAttribute('data-i')) === cueIndex);
    }
  }

  function setPosition(ci, cueIndex, opts) {
    opts = opts || {};
    var book = currentBook();
    if (!book) return;
    ci = core.clamp(ci, 0, book.chapters.length - 1);
    cueIndex = core.clamp(cueIndex, 0, Math.max(0, cuesOf(book, ci).length - 1));

    var changedChapter = ci !== state.pos.chapterIndex;
    state.pos = { chapterIndex: ci, cueIndex: cueIndex };
    if (changedChapter) { renderChapter(); } else { highlight(cueIndex, opts.scroll); }
    saveProgress(opts.mode || 'read');
    updateRatio();
    if (opts.status !== false) updateStatus();
  }

  function saveProgress(mode) {
    state.progress[state.bookId] = core.makeProgress(state.bookId, state.pos.chapterIndex,
                                                     state.pos.cueIndex, mode);
    persistProgress(state.bookId);
    renderShelf();
  }

  /** 单条进度落库（存储层已换成 ReadItStore，不能再走旧的 saveJSON） */
  function persistProgress(bookId) {
    if (!store || !state.progress[bookId]) return;
    store.saveProgress(state.progress[bookId]).catch(function () {});
  }

  /** 清空进度：必须真的删库，只清内存对象会在下次启动时被旧记录复活 */
  function clearProgressAll() {
    state.progress = {};
    if (store) store.clearProgress().catch(function (e) { toast('清空进度失败：' + ((e && e.message) || e)); });
  }

  function updateRatio() {
    var book = currentBook();
    if (!book) return;
    var ratio = core.readingRatio(cueCounts(book), state.pos.chapterIndex, state.pos.cueIndex);
    els.ratio.textContent = Math.round(ratio * 100) + '%';
    els['progress-fill'].style.width = (ratio * 100).toFixed(2) + '%';
  }

  /* ================= 朗读 ================= */

  var engine = null;

  /** 两个引擎接口一致：system = 浏览器/系统音色；cloud = 本机 /tts 中转的云端神经音色 */
  function makeEngine(hooks) {
    if (state.settings.engine === 'cloud' && global.ReadItTtsCloud) {
      return global.ReadItTtsCloud.createCloudEngine(hooks);
    }
    return global.ReadItTts.createTtsEngine(hooks);
  }

  /**
   * 探一次云端中转在不在，分四种结论，别一棍子打死：
   *   ok     —— 有中转且拿到音色列表，放心切
   *   locked —— 有中转但你还没解锁（401）
   *   retry  —— 网络抖动 / 服务 5xx，**说不清**，不能据此断定不能用
   *   none   —— 404 或压根没有 fetch，这台就是纯静态托管
   */
  function probeCloud() {
    if (!global.fetch) return Promise.resolve('none');
    return Promise.resolve(global.fetch('/tts/voices')).then(function (r) {
      if (r.ok) {
        return r.json().then(function (d) {
          return (d && d.voices && d.voices.length) ? 'ok' : 'retry';
        }, function () { return 'retry'; });
      }
      if (r.status === 404) return 'none';
      if (r.status === 401) return 'locked';
      return 'retry';
    }, function () { return 'retry'; });      // fetch 本身失败：说不清
  }

  function switchEngine(name) {
    if (name !== 'cloud') { applyEngine(name); return; }
    // 静态托管（GitHub Pages 就是）没有 /tts：切过去只会一声不响地失败，必须当场说清。
    probeCloud().then(function (s) {
      if (s === 'ok') { applyEngine('cloud'); return; }
      if (s === 'locked') {
        applyEngine('cloud');
        warn('服务器在，但当前还没解锁：解锁之前取不到音色列表，播放会失败。');
        return;
      }
      if (s === 'retry') {
        // 只是这一次没取到列表，不能因此断人说「你用不了」—— 保留选择，只提醒
        applyEngine('cloud');
        warn('暂时没取到云端音色列表（网络或服务异常）。已切到云端音色，要是播放没声音，再切回系统音色。');
        return;
      }
      applyEngine('system');
      warn('这个地址上没有 TTS 中转服务（GitHub Pages 之类的纯静态托管就是这样），' +
           '云端神经音色用不了，已自动切回系统音色。要用云端音色请用带 server.py 的地址打开。');
    });
  }

  function applyEngine(name) {
    state.settings.engine = name;
    saveSettings();
    if (engine && engine.stop) { try { engine.stop(); } catch (e) { /* 忽略 */ } }
    setupTts();
    renderPlayerState();
    if (els['engine-select']) els['engine-select'].value = name === 'cloud' ? 'cloud' : 'system';
    toast(name === 'cloud' ? '已切到云端神经音色（逐句合成）' : '已切回系统音色');
  }

  function setupTts() {
    var hooks = {
      getCues: function (ci) { var b = currentBook(); return b ? cuesOf(b, ci) : []; },
      onCueStart: function (e) {
        if (e.chapterIndex !== state.pos.chapterIndex) return;
        highlight(e.cueIndex, true);
        updateStatus();
      },
      onCueEnd: function (e) {
        setPosition(e.chapterIndex, e.cueIndex, { mode: 'listen', scroll: false, status: false });
        if (state.sleepAt && Date.now() >= state.sleepAt) {
          engine.stop(); toast('定时关闭已到点，播放停止');
        }
      },
      onChapterEnd: function (e) {
        var book = currentBook();
        if (!book) return;
        if (state.settings.autoNext && e.chapterIndex < book.chapters.length - 1) {
          state.pos = { chapterIndex: e.chapterIndex + 1, cueIndex: 0 };
          renderChapter();
          engine.playChapter(state.pos.chapterIndex, 0);
        } else {
          updateStatus('本章播放完毕');
        }
      },
      onStateChange: function () { renderPlayerState(); }
    };

    engine = makeEngine(hooks);

    engine.refreshVoices(function (list) {
      var sel = els['voice-select'];
      sel.innerHTML = '';
      if (!list.length) {
        var o = doc.createElement('option');
        o.value = ''; o.textContent = '（系统默认语音）';
        sel.appendChild(o);
        return;
      }

      // 旧代码把第一个中文音色当默认值，Chrome 上那个位置永远是机械的 Huihui ——
      // 用户不手动翻就永远听着假。现在按自然音色优先排序，并分组，Edge 上自动落到 Neural。
      var ranked = core.rankVoices(list);
      var zh = ranked.filter(function (v) { return /^zh/i.test(v.lang || ''); });
      var rest = ranked.filter(function (v) { return !/^zh/i.test(v.lang || ''); });

      [[zh, '中文'], [rest, '其他语言']].forEach(function (pair) {
        if (!pair[0].length) return;
        var g = doc.createElement('optgroup');
        g.label = pair[1];
        pair[0].forEach(function (v) {
          var op = doc.createElement('option');
          op.value = v.id;
          op.textContent = (core.isGoodVoice(v) ? '★ ' : '') + v.name +
            ' · ' + (v.lang || '?') + (v.localService ? '' : ' · 需联网');
          g.appendChild(op);
        });
        sel.appendChild(g);
      });

      var prefer = zh[0] || ranked[0];
      var saved = state.settings.voiceId;
      var picked = null;
      if (saved && list.some(function (v) { return v.id === saved; })) {
        sel.value = saved; picked = saved;
      } else if (prefer) {
        sel.value = prefer.id; picked = prefer.id;
      }
      if (picked) engine.setVoice(picked);
      showVoiceQualityHint(zh.length ? zh : ranked);
    });
  }

  /** 就近说明"为什么听着假"：设备里没有自然音色时，这句话必须看得见，不能等用户去猜 */
  function showVoiceQualityHint(list) {
    var sel = els['voice-select'];
    if (!sel || !sel.parentNode) return;
    var id = 'voice-quality-hint';
    var el = doc.getElementById(id);
    var hasGood = (list || []).some(function (v) { return core.isGoodVoice(v); });

    if (hasGood) { if (el && el.parentNode) el.parentNode.removeChild(el); return; }
    if (!el) {
      el = doc.createElement('p');
      el.id = id;
      el.className = 'hint';
      el.style.color = '#c07a2a';
      sel.parentNode.insertBefore(el, sel.nextSibling);
    }
    el.textContent = '本机只有系统机械音色。用 Edge 打开本页会自动选到微软自然音色（需联网）；' +
      '要更接近真人需接云端 TTS（设置里填自己的 Key）。';
  }

  function playFromCurrent() {
    engine.playChapter(state.pos.chapterIndex, state.pos.cueIndex);
  }

  function renderPlayerState() {
    var s = engine.state;
    els['btn-play'].textContent = s.playing && !s.paused ? '⏸ 暂停' : '▶ 播放';
    els['btn-play'].classList.toggle('playing', !!(s.playing && !s.paused));
    updateStatus();
  }

  function updateStatus(extra) {
    var book = currentBook();
    if (!book) return;
    var cues = cuesOf(book, state.pos.chapterIndex);
    var s = engine ? engine.state : {};
    var head = extra || (!s.playing ? '未播放' : (s.paused ? '已暂停' : '朗读中'));
    var pos = '第 ' + (state.pos.cueIndex + 1) + ' / ' + cues.length + ' 句';
    var remain = core.estimateSpeechMs(core.countSpeechChars(cues, state.pos.cueIndex + 1), state.settings.rate);
    els['status-text'].textContent = head + ' · ' + pos +
      (remain > 0 ? ' · 本章剩约 ' + core.formatDuration(remain / 1000) : ' · 本章已到末句');
    els['rate-val'].textContent = Number(state.settings.rate).toFixed(1);
  }

  /* ================= 定时关闭 ================= */

  function setSleep(minutes) {
    if (state.sleepTimer) { clearInterval(state.sleepTimer); state.sleepTimer = null; }
    var m = Number(minutes) || 0;
    if (!m) { state.sleepAt = 0; els['sleep-text'].textContent = ''; return; }
    state.sleepAt = Date.now() + m * 60000;
    state.sleepTimer = setInterval(function () {
      var left = state.sleepAt - Date.now();
      if (left <= 0) {
        els['sleep-text'].textContent = '定时：将在本句结束后停止';
        if (!engine.state.playing) { clearInterval(state.sleepTimer); state.sleepTimer = null; }
        return;
      }
      els['sleep-text'].textContent = '定时剩 ' + core.formatDuration(left / 1000);
    }, 1000);
  }

  /* ================= 交互绑定 ================= */

  function bindEvents() {
    els['btn-open-sample'].addEventListener('click', function () { openBook(state.books[0].id); });
    els['btn-back'].addEventListener('click', function () {
      engine.stop();
      els.workbench.hidden = true; els['empty-state'].hidden = false;
      showTitlePage(false);              // 复位扉页对各区块的遮挡，下次进书由 openBook 重新决定
      pageCache = null;
      state.bookId = null; renderShelf();
      // 明确回到书架：下次启动不再自动进书，这是用户自己的选择
      if (state.settings.lastBookId) { state.settings.lastBookId = ''; saveSettings(); }
    });

    // 扉页三件套
    els['btn-tp-continue'].addEventListener('click', function () {
      var book = currentBook();
      if (!book) return;
      var p = state.progress[book.id];
      var done = p && core.readingRatio(cueCounts(book), p.chapterIndex, p.cueIndex) >= 0.99;
      startReading(!!done);
    });
    els['btn-tp-restart'].addEventListener('click', function () { startReading(true); });
    els['btn-tp-back'].addEventListener('click', function () { els['btn-back'].click(); });

    els['btn-import'].addEventListener('click', function () { els['file-input'].click(); });
    els['file-input'].addEventListener('change', onImport);

    els['btn-clear-progress'].addEventListener('click', function () {
      if (!global.confirm('确定清空所有书的阅读进度？（不会删除导入的书籍）')) return;
      clearProgressAll(); renderShelf(); toast('进度已清空');
    });

    if (els['btn-show-samples']) els['btn-show-samples'].addEventListener('click', showHiddenSamples);

    els['btn-export'].addEventListener('click', exportBackup);
    els['btn-import-backup'].addEventListener('click', function () { els['backup-input'].click(); });
    els['backup-input'].addEventListener('change', onRestoreBackup);

    els.reader.addEventListener('click', function (ev) {
      if (Date.now() - lastSwipeAt < 600) return;   // 刚滑过页：忽略浏览器补发的 click
      var el = ev.target.closest ? ev.target.closest('.cue') : null;
      if (el) {
        var idx = Number(el.getAttribute('data-i'));
        var wasPlaying = engine.state.playing && !engine.state.paused;
        setPosition(state.pos.chapterIndex, idx, { mode: 'read', scroll: false });
        if (wasPlaying) engine.jumpTo(state.pos.chapterIndex, idx);
        else toast('已把续读位置设在这一句');
        return;
      }
      // 空白处：点屏幕左/右约四分之一 = 上一页/下一页（书页直觉）
      var box = els.reader.getBoundingClientRect();
      var x = (ev.clientX - box.left) / Math.max(1, box.width);
      if (x < 0.26) turnPage(-1);
      else if (x > 0.74) turnPage(1);
    });

    // 手指横扫翻页（手机上的主流手势）；轻点不算滑动
    var touchX = 0, touchY = 0;
    els.reader.addEventListener('touchstart', function (ev) {
      if (ev.touches.length !== 1) { touchX = 0; return; }
      touchX = ev.touches[0].clientX; touchY = ev.touches[0].clientY;
    }, { passive: true });
    els.reader.addEventListener('touchend', function (ev) {
      if (!touchX || !ev.changedTouches || !ev.changedTouches.length) return;
      var t = ev.changedTouches[0];
      var dx = t.clientX - touchX, dy = t.clientY - touchY;
      touchX = 0;
      if (Math.abs(dx) > 46 && Math.abs(dx) > Math.abs(dy) * 1.6) {
        lastSwipeAt = Date.now();
        turnPage(dx < 0 ? 1 : -1);
      }
    }, { passive: true });

    els['btn-prev-chapter'].addEventListener('click', function () { gotoChapter(state.pos.chapterIndex - 1); });
    els['btn-next-chapter'].addEventListener('click', function () { gotoChapter(state.pos.chapterIndex + 1); });
    els['chapter-select'].addEventListener('change', function (e) { gotoChapter(Number(e.target.value)); });

    els['mode-read'].addEventListener('click', function () { setMode('read'); });
    els['mode-listen'].addEventListener('click', function () {
      setMode('listen');
      if (!engine.state.playing) playFromCurrent();
    });

    els['btn-play'].addEventListener('click', function () {
      setMode('listen');
      if (!engine.state.playing) playFromCurrent(); else engine.toggle();
    });
    els['btn-stop'].addEventListener('click', function () { engine.stop(); });
    els['btn-prev-cue'].addEventListener('click', function () { stepCue(-1); });
    els['btn-next-cue'].addEventListener('click', function () { stepCue(1); });

    els.rate.addEventListener('input', function (e) {
      state.settings.rate = Number(e.target.value);
      engine.setRate(state.settings.rate);
      updateStatus(); saveSettings();
    });
    els['voice-select'].addEventListener('change', function (e) {
      state.settings.voiceId = e.target.value; engine.setVoice(e.target.value); saveSettings();
    });
    // 音色来源：系统音色离线可用但音质封顶；云端神经音色要本机 server.py（Key 只在服务端）
    if (els['engine-select']) {
      els['engine-select'].value = state.settings.engine === 'cloud' ? 'cloud' : 'system';
      els['engine-select'].addEventListener('change', function (e) { switchEngine(e.target.value); });
    }
    els['sleep-select'].addEventListener('change', function (e) { setSleep(e.target.value); });
    els['auto-next'].addEventListener('change', function (e) {
      state.settings.autoNext = !!e.target.checked; saveSettings();
    });

    els['btn-font-plus'].addEventListener('click', function () { bumpFont(1); });
    els['btn-font-minus'].addEventListener('click', function () { bumpFont(-1); });
    els['btn-theme'].addEventListener('click', function () {
      var i = THEMES.indexOf(state.settings.theme);
      state.settings.theme = THEMES[(i + 1) % THEMES.length];
      applySettings();
    });

    doc.addEventListener('keydown', function (e) {
      if (!state.bookId || e.target !== doc.body) return;
      if (e.code === 'Space') { e.preventDefault(); els['btn-play'].click(); }
      if (e.code === 'ArrowLeft') stepCue(-1);
      if (e.code === 'ArrowRight') stepCue(1);
      if (e.code === 'PageUp') { e.preventDefault(); turnPage(-1); }
      if (e.code === 'PageDown') { e.preventDefault(); turnPage(1); }
    });

    // 旋转屏幕 / 窗口尺寸变化：页面盒子的物理高度变了，装箱结果作废，就地重排。
    // 位置锚在句级，重排后依旧落在正在读的这句附近。
    var resizeTimer = 0;
    global.addEventListener('resize', function () {
      if (resizeTimer) global.clearTimeout(resizeTimer);
      resizeTimer = global.setTimeout(function () {
        resizeTimer = 0;
        if (state.bookId && pageCache && els['title-page'].hidden) renderChapter();
      }, 350);
    });
  }

  function stepCue(delta) {
    var book = currentBook();
    if (!book) return;
    var cues = cuesOf(book, state.pos.chapterIndex);
    var next = state.pos.cueIndex + delta;
    var wasPlaying = engine.state.playing && !engine.state.paused;
    if (next < 0) {
      if (state.pos.chapterIndex > 0) gotoChapter(state.pos.chapterIndex - 1, cues.length - 1, wasPlaying);
      return;
    }
    if (next >= cues.length) {
      if (state.settings.autoNext && state.pos.chapterIndex < book.chapters.length - 1) {
        gotoChapter(state.pos.chapterIndex + 1, 0, wasPlaying);
      }
      return;
    }
    setPosition(state.pos.chapterIndex, next, { mode: wasPlaying ? 'listen' : 'read' });
    if (wasPlaying) engine.jumpTo(state.pos.chapterIndex, next);
  }

  function gotoChapter(ci, cueIndex, keepPlaying) {
    var book = currentBook();
    if (!book) return;
    ci = core.clamp(ci, 0, book.chapters.length - 1);
    engine.stop();
    state.pos = { chapterIndex: ci, cueIndex: Math.max(0, cueIndex || 0) };
    state.follow = true;
    renderChapter();
    saveProgress('read');
    updateStatus();          // 切章后立即重算状态栏（修复：曾残留上一章的句子计数）
    if (keepPlaying) engine.playChapter(ci, state.pos.cueIndex);
  }

  function setMode(mode) {
    state.mode = mode;
    els['mode-read'].classList.toggle('active', mode === 'read');
    els['mode-listen'].classList.toggle('active', mode === 'listen');
    els['listen-panel'].hidden = mode !== 'listen';
    state.follow = mode === 'listen';
    if (mode === 'listen') highlight(state.pos.cueIndex, true);
  }

  function bumpFont(delta) {
    state.settings.fontStep = core.clamp(state.settings.fontStep + delta, 0, FONT_STEPS.length - 1);
    applySettings();
  }

  function applySettings() {
    doc.documentElement.setAttribute('data-theme', state.settings.theme);
    els.reader.style.fontSize = FONT_STEPS[state.settings.fontStep] + 'px';
    els['btn-theme'].textContent = ({ paper: '纸白', sepia: '护眼', dark: '夜间' })[state.settings.theme];
    els.rate.value = String(state.settings.rate);
    els['auto-next'].checked = !!state.settings.autoNext;
    if (engine) engine.setRate(state.settings.rate);
    saveSettings();
    // 字号变了每一页装得下的句子就变了：正在读的话重装箱，
    // 锚点仍是当前句（renderChapter 内部按句位找回所在页）
    if (state.bookId && pageCache && els['title-page'] && els['title-page'].hidden) renderChapter();
  }

  /* ================= 导入 ================= */

  var COVERS = [['#6d5a3f', '#2f2418'], ['#2b4c66', '#0f1a26'], ['#5b3f5e', '#1e1422'],
                ['#4a5a4f', '#1d2621'], ['#6b3a3a', '#241010'], ['#3f4a63', '#151a26']];

  /** 把 File 读成 parse.parseBook 需要的入参 */
  function readForParse(file) {
    var ext = parse.extOf(file.name);
    if (parse.EPUB_EXT.indexOf(ext) >= 0 || parse.DOCX_EXT.indexOf(ext) >= 0 ||
        parse.PDF_EXT.indexOf(ext) >= 0) {
      return file.arrayBuffer().then(function (ab) {
        return { name: file.name, size: file.size, lastModified: file.lastModified,
                 arrayBuffer: ab, deps: parseDeps() };
      });
    }
    return file.text().then(function (text) {
      return { name: file.name, size: file.size, lastModified: file.lastModified,
               text: text, deps: parseDeps() };
    });
  }

  function parseDeps() {
    if (global.pdfjsLib && global.pdfjsLib.GlobalWorkerOptions) {
      global.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }
    return { JSZip: global.JSZip, mammoth: global.mammoth, pdfjsLib: global.pdfjsLib };
  }

  /** 单个文件的导入流水线：读 → 解析 → 建书 → 落库 */
  function importOne(file, index) {
    if (!parse || typeof parse.parseBook !== 'function') {
      return Promise.reject(new Error('解析模块未加载（检查 js/parse.js 是否被引入）'));
    }
    var id = 'local-' + String(file.name).replace(/[^\w\u4e00-\u9fa5-]+/g, '_') +
             '-' + (file.size || 0) + '-' + (file.lastModified || 0);
    if (bookById(id)) {
      toast('《' + file.name + '》已在书架上（同一份文件重复导入）');
      return Promise.resolve(null);
    }
    return readForParse(file)
      .then(function (arg) { return parse.parseBook(arg); })
      .then(function (r) {
        var pair = COVERS[index % COVERS.length];
        var book = {
          id: id, title: r.title, author: r.author || '本地导入', source: 'local', lang: 'zh',
          // 落库时保留真实文件格式；之前只在 intro 文案里露一次，
          // 导致书架与「导出诊断」都无法区分 epub/pdf/docx（诊断只能显示 local）
          format: r.format || '',
          intro: (r.format || '').toUpperCase() + ' · ' + r.chapters.length + ' 章 · 导入于 ' +
                 new Date().toLocaleDateString(),
          cover: { from: pair[0], to: pair[1] },
          chapters: r.chapters.map(function (c) { return { title: c.title, text: c.text }; })
        };
        state.books.push(book);
        return persistBook(book).then(function () { return book; });
      });
  }

  function onImport(ev) {
    var files = Array.prototype.slice.call(ev.target.files || []);
    ev.target.value = '';
    if (!files.length) return;
    if (!store || store.backend() === 'none') {
      toast('本机存储不可用，导入的书不会保存。请先在设置里排查存储问题。');
    }

    var i = 0, added = 0;
    els['btn-import'].disabled = true;
    toast('正在解析 ' + files.length + ' 个文件…');

    // 串行：一次只解一本，避免大 PDF 与 EPUB 并发把主线程打满，也便于报错定位到具体文件
    function next() {
      if (i >= files.length) {
        els['btn-import'].disabled = false;
        renderShelf();
        toast(added ? ('已导入 ' + added + ' 本，书架共 ' + state.books.length + ' 本')
                    : '没有新文件被导入（可能都已存在或全部失败）');
        return;
      }
      var file = files[i++];
      importOne(file, i).then(function (book) {
        if (book) added++;
      }, function (e) {
        toast('「' + file.name + '」导入失败：' + ((e && e.message) || e));
      }).then(next);
    }
    next();
  }
  /* ================= 备份（自用保命：浏览器数据一清就没） ================= */

  function exportBackup() {
    var local = state.books.filter(function (b) { return b.source === 'local'; });
    var payload = core.makeBackup(state.settings, state.progress, local);
    var text = JSON.stringify(payload);
    var name = 'readit-backup-' + core.dateStamp() + '.json';   // 本地日期，不用 UTC

    try {
      var blob = new global.Blob([text], { type: 'application/json' });
      var url = global.URL.createObjectURL(blob);
      var a = doc.createElement('a');
      a.href = url; a.download = name;
      doc.body.appendChild(a); a.click(); doc.body.removeChild(a);
      setTimeout(function () { global.URL.revokeObjectURL(url); }, 2000);
      toast('已导出：你导入的书 ' + local.length + ' 本 + 进度 ' +
            Object.keys(state.progress).length + ' 条（内置示例书不需备份）');
    } catch (e) {
      toast('导出失败：' + e.message);
    }
  }

  function onRestoreBackup(ev) {
    var file = (ev.target.files || [])[0];
    ev.target.value = '';
    if (!file) return;
    var fr = new global.FileReader();
    fr.onload = function () {
      var parsed = core.parseBackup(String(fr.result || ''));
      if (!parsed.ok) { toast('恢复失败：' + parsed.reason); return; }

      var merged = core.mergeBackup(state.books, state.progress, parsed.data);
      state.books = merged.books;
      state.progress = merged.progress;
      persistImportedBooks();
      persistProgressAll();
      renderShelf();
      if (state.bookId) { renderChapterSelect(currentBook()); renderChapter(); }

      toast('恢复完成：新增 ' + merged.added + ' 本，已存在跳过 ' + merged.skipped +
            ' 本，进度更新 ' + merged.progressUpdated + ' 条');
    };
    fr.onerror = function () { toast('读取文件失败'); };
    fr.readAsText(file, 'utf-8');
  }

  /* ================= 提示 ================= */

  var toastTimer = null;
  function toast(msg) {
    els.toast.hidden = false;
    els.toast.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toast.hidden = true; }, 3600);
  }
  function warn(msg) { els['tts-warn'].hidden = false; els['tts-warn'].textContent = msg; }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', boot);
  else boot();

  // 对外最小面：便于自动化验证与高级用户从控制台驱动导入
  global.ReadItApp = {
    state: state,
    openBook: openBook,
    core: core,
    importOne: importOne,                       // (File, index) -> Promise<book|null>
    storeInfo: function () { return store ? store.backend() : 'none'; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
