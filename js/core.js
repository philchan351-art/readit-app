/*
 * core.js —— ReadIt 纯逻辑层
 * 职责：文本归一化 / 自动分章 / 句级切分(cue) / 偏移查找 / 进度计算与合并
 * 约束：不依赖任何 DOM 或浏览器 API，可在 Node 中直接 require 做单元测试，
 *       迁移到 React Native / Flutter 时这一层可原样复用。
 *
 * 核心概念：cue（句）= 书内唯一定位单位。
 *   阅读进度与朗读进度都表达为 (chapterIndex, cueIndex)，
 *   因此"看书 ↔ 听书"的接续不需要任何坐标换算。
 */
(function (global) {
  'use strict';

  /* ---------- 可调常量 ---------- */
  var HARD_END = '。！？!?；;…';           // 句子结束标点
  var SOFT_END = '，,、：:—–　';            // 次级断句标点（超长句时使用）
  var CLOSERS = '”’』）)】》"\'';        // 跟在句末标点后的闭引号/括号
  // 单句上限 56 字：Readium《SpeechSynthesis in browsers and OSes》记录 Chrome 桌面的 Google 语音
  // 在单条 utterance 朗读超过约 14 秒时会出问题。中文约 4.2 字/秒 → 14 秒 ≈ 59 字，取 56 留余量。
  // 顺带让高亮粒度更细，跟读更准。
  var MAX_SENT = 56;
  var SOFT_SENT = 30;                       // 超长句回溯寻找次级标点的最短保留长度（必须 < MAX_SENT）
  var MAX_CHAPTER = 2500;                   // 无章节标题时的自动分段长度
  var HEADING_MAX_LEN = 30;                 // 超过此长度不当作标题
  var CHARS_PER_SECOND = 4.2;               // 中文朗读经验估算常数（仅用于预估，非承诺值）

  var HEADING_RE = new RegExp(
    '^(?:#{1,6}\\s*)?(?:' +
    '第\\s*[0-9〇零一二三四五六七八九十百千万两]+\\s*[章回节卷篇折回]|' +
    '序\\s*言|前\\s*言|引\\s*言|后\\s*记|尾\\s*声|结\\s*语|附\\s*录|目录' +
    ')'
  );

  // Markdown 标题（# ~ ######）视为章节标题，内容任意
  var MD_HEADING_RE = /^#{1,6}\s+\S/;

  /* ---------- 基础工具 ---------- */

  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }

  /** 统一换行、去掉行尾空白、压缩 3 个以上连续换行 */
  function normalizeText(raw) {
    return String(raw == null ? '' : raw)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function stripWhitespace(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '');
  }

  function isHeading(line) {
    var t = String(line == null ? '' : line).trim();
    if (!t || t.length > HEADING_MAX_LEN) return false;
    return MD_HEADING_RE.test(t) || HEADING_RE.test(t);
  }

  /* ---------- 句级切分 ---------- */

  /**
   * 把文本切成 cue（句）序列。
   * 强不变式（有单测保证）：cues.map(c => c.text).join('') === text
   *   —— 即 cue 覆盖原文且互不重叠，因此 char_start/char_end 可直接用于渲染与音频对齐。
   * 例外：text 全为空白时返回空数组（此时不存在可朗读内容）。
   * @param {string} text 已归一化的章节正文
   * @returns {Array<{idx:number,start:number,end:number,text:string}>}
   */
  function splitSentences(text) {
    text = String(text == null ? '' : text);
    var n = text.length;
    var cues = [];
    var start = 0;

    function push(end) {
      if (end <= start) return;
      var slice = text.slice(start, end);
      if (!slice.trim()) {
        // 纯空白片段：已有句子 → 并入上一句尾部；否则留给下一句作前导空白。
        // 两种处理都不推进"覆盖缺口"，因此拼接不变式恒成立。
        if (cues.length) {
          var last = cues[cues.length - 1];
          last.end = end;
          last.text = text.slice(last.start, end);
          start = end;
        }
        return;
      }
      cues.push({ idx: cues.length, start: start, end: end, text: slice });
      start = end;
    }

    for (var i = 0; i < n; i++) {
      var ch = text.charAt(i);

      if (HARD_END.indexOf(ch) >= 0) {
        var end = i + 1;
        // 吸收紧随其后的闭引号、连续句末标点、空白
        while (end < n && (CLOSERS.indexOf(text.charAt(end)) >= 0 ||
                           HARD_END.indexOf(text.charAt(end)) >= 0 ||
                           text.charAt(end) === ' ')) {
          end++;
        }
        if (end < n && text.charAt(end) === '\n') end++; // 句末紧跟换行 → 一并归入本句
        push(end);
        i = end - 1;
        continue;
      }

      if (ch === '\n') { push(i + 1); continue; }

      if (i + 1 - start >= MAX_SENT) {
        var cut = -1;
        for (var j = i; j > start + SOFT_SENT; j--) {
          if (SOFT_END.indexOf(text.charAt(j)) >= 0) { cut = j + 1; break; }
        }
        if (cut < 0) {
          // 连次级标点都没有 → 拉丁文回退到最近的空格处断开。
          // 否则 56 字硬切会把单词切成两半，且切点那个空格会被当成首尾空白 trim 掉，
          // 两句朗读/显示时粘成 "cannotkeep"（浏览器实测出现过）。
          // 空格留给下一句当前导空白：拼接不变式仍然成立，展示时再 trim。
          for (var k = i; k > start + SOFT_SENT; k--) {
            if (text.charAt(k) === ' ') { cut = k; break; }
          }
        }
        if (cut > start) { push(cut); i = cut - 1; } else { push(i + 1); }
      }
    }

    if (start < n) push(n);
    return cues;
  }

  /** cue 的朗读文本：去首尾空白，压缩内部换行 */
  function speechText(cue) {
    return String(cue && cue.text ? cue.text : '').replace(/\s+/g, ' ').trim();
  }

  /** 二分查找：包含（或紧随其后）给定字符偏移的 cue 下标；无 cue 返回 -1 */
  function findCueIndexAt(cues, charOffset) {
    if (!cues || !cues.length) return -1;
    var off = Number(charOffset) || 0;
    var lo = 0, hi = cues.length - 1, ans = cues.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].end > off) { ans = mid; hi = mid - 1; } else { lo = mid + 1; }
    }
    return ans;
  }

  /* ---------- 中文排版噪音与无标记章题 ---------- */

  var CJK_CHARS = '\u2E80-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF';
  var CJK_SPACE_RE = new RegExp('([' + CJK_CHARS + '])[ \t\u00A0]+(?=[' + CJK_CHARS + '])', 'g');

  var CJK_ISOLATED_RE = new RegExp('[' + CJK_CHARS + '][ \t](?=[' + CJK_CHARS + '])', 'g');

  /**
   * 清除「逐字被空格拆开」的行内噪音：PDF 用 Type3 字体逐字定位时，pdf.js 会在每个字之间
   * 塞空格，真书实测提取出来是「修 正 文 库」「全 书 已 无 此 状 态」。
   *
   * ⚠ 必须设门槛：「第一章 起点」的空格是合法排版，一刀切会把正常章题改坏（单测抓到过）。
   *   所以只有当一行里出现 ≥3 处"单字+空格+单字"时，才认定它是被拆开的，动手清理。
   */
  function isolatedCjkCount(s) {
    return (String(s == null ? '' : s).match(CJK_ISOLATED_RE) || []).length;
  }

  /** 无条件清除中文间空格（调用方自己确认这确实是拆字噪音时用） */
  function tidySpacingAlways(s) {
    return String(s == null ? '' : s).replace(CJK_SPACE_RE, '$1');
  }

  function tidyCjkSpacing(s) {
    var str = String(s == null ? '' : s);
    if (isolatedCjkCount(str) < 3) return str;
    return str.replace(CJK_SPACE_RE, '$1');
  }

  // 打印稿没有标题标记，章题长这样：「127 ｜ 财富天问…」；编号也可能被拆成「1 2 7」，
  // 所以数字之间的空白是**可选**的（写成必须有就会漏掉最常见的 127｜ 形式）
  var NUM_HEADING_RE = /^(?:\d[ \t]?){1,4}[｜|]\s*\S/;

  function headingKind(line) {
    var t = tidyCjkSpacing(String(line == null ? '' : line).trim());
    if (!t) return '';
    if (NUM_HEADING_RE.test(t)) return 'num';
    return isHeading(t) ? 'word' : '';
  }

  /** 这行文本本身像不像标题（PDF 分组时用来强制断段） */
  function isHeadingText(t) {
    return !!String(t == null ? '' : t).trim() && headingKind(t) !== '';
  }

  /** 章题归一：编号内的空格去掉，并剥掉「深度修订 1,678 字 ｜ 6 段」这类排版统计尾巴 */
  function cleanHeadingTitle(line, kind) {
    var t = tidyCjkSpacing(String(line == null ? '' : line).trim()).replace(/^#{1,6}\s*/, '');
    if (kind !== 'num') return t;
    var m = /^((?:\d[ \t]*){1,4})[ \t]*[｜|][ \t]*([\s\S]*)$/.exec(t);
    if (!m) return t;
    var num = m[1].replace(/[ \t]+/g, '');
    var rest = m[2].replace(/[ \t]+/g, ' ').trim()
      .replace(/[ \t]*(?:深度修订|逐篇修订|修订|句读重建)?[ \t]*[\d,]+[ \t]*字[ \t]*[｜|][ \t]*[\d,]+[ \t]*[段篇条]?[ \t]*$/, '')
      .trim();
    return num + '｜' + (rest || '未命名');
  }

  /**
   * 标出每行的标题类型，并把"连续 ≥4 行的编号标题"降级为正文。
   * 那几乎一定是**目录页**：真章题后面总跟着正文，目录条目则是一条挨一条。
   * 不降级就会像实测那样：目录页 150 行全被当成章，章数直接翻倍。空行不打断这种连续。
   */
  /** 取章题行首的编号（「1 2 7 ｜ …」→ 127），取不到返回 null */
  function headingNumber(line) {
    var t = tidyCjkSpacing(String(line == null ? '' : line).trim());
    var m = /^((?:\d[ \t]?){1,4})\s*[｜|]/.exec(t);
    return m ? Number(m[1].replace(/[ \t]+/g, '')) : null;
  }

  function markHeadings(lines) {
    var kinds = lines.map(headingKind);
    var i = 0;
    while (i < kinds.length) {
      if (kinds[i] !== 'num') { i++; continue; }
      var start = i, count = 0, last = i, j = i;
      while (j < kinds.length) {
        if (kinds[j] === 'num') { count++; last = j; j++; continue; }
        if (kinds[j] === '' && !String(lines[j] == null ? '' : lines[j]).trim()) { j++; continue; }
        break;
      }
      // 只降级"编号逐条 +1 递增"的那一段 —— 那才是目录页。
      // 只按"连续几行"降级的话，目录最后一条紧跟着的第一章会被一起误杀（单测抓到过）。
      var seq = [];
      for (var a = start; a <= last; a++) {
        if (kinds[a] === 'num') seq.push({ line: a, num: headingNumber(lines[a]) });
      }
      var cut = seq.length ? 1 : 0;
      for (var b = 1; b < seq.length; b++) {
        if (seq[b].num != null && seq[b - 1].num != null && seq[b].num === seq[b - 1].num + 1) cut++;
        else break;
      }
      if (cut >= 4) for (var c = 0; c < cut; c++) kinds[seq[c].line] = '';
      i = Math.max(j, last + 1);
    }
    return kinds;
  }

  /* ---------- 分章 ---------- */

  /**
   * 自动分章：优先识别"第X章/回/节…"与 Markdown 标题；
   * 识别不到则按段落窗口自动切段；超长章节同样再切。
   * 保证不丢正文（仅去空白差异，见单测）。
   * @returns {Array<{index:number,title:string,text:string}>}
   */
  function splitChapters(raw, opts) {
    var maxLen = (opts && opts.maxChapterLen) || MAX_CHAPTER;
    var text = normalizeText(raw);
    if (!text) return [];

    var lines = text.split('\n');
    var kinds = markHeadings(lines);          // 先标标题，再顺手把目录页那种连续编号降级掉
    var groups = [];
    var cur = { title: '正文', lines: [] };

    for (var i = 0; i < lines.length; i++) {
      if (kinds[i]) {
        if (stripWhitespace(cur.lines.join('\n'))) groups.push(cur);
        cur = { title: cleanHeadingTitle(lines[i], kinds[i]), lines: [] };
      } else {
        cur.lines.push(lines[i]);
      }
    }
    if (stripWhitespace(cur.lines.join('\n'))) groups.push(cur);

    var chapters = groups.map(function (g) {
      return { index: 0, title: g.title, text: normalizeText(g.lines.join('\n')) };
    });
    if (!chapters.length) chapters = [{ index: 0, title: '正文', text: text }];

    // 二次切分只该用于"整本书一个标题都没识别出来"的情况。
    // 真书实测：正常章长约 3,750 字，把无标题书的 2,500 字上限套到有真章题的书上，
    // 会把 150 章劈成 342 个假章（「006｜创刊词 · 1..6」就是这么来的）。
    var anyHeading = false;
    for (var h = 0; h < kinds.length; h++) { if (kinds[h]) { anyHeading = true; break; } }
    var hardCap = (opts && opts.hardChapterCap) || 20000;
    var out = [];
    chapters.forEach(function (c) {
      var cap = anyHeading ? hardCap : maxLen;
      if (c.text.length <= cap * 1.25) { out.push(c); return; }
      var parts = breakByLength(c.text, cap);
      parts.forEach(function (p, k) {
        out.push({ index: 0, title: c.title + ' · ' + (k + 1), text: p });
      });
    });

    return out.map(function (c, idx) {
      return { index: idx, title: c.title, text: c.text };
    });
  }

  function breakByLength(text, maxLen) {
    var paras = text.split(/\n+/);
    var parts = [], buf = '';
    for (var i = 0; i < paras.length; i++) {
      var p = paras[i];
      while (p.length > maxLen) {           // 单段就超长 → 硬切
        var room = buf ? maxLen - buf.length : maxLen;
        if (room > 0) { buf += (buf ? '\n' : '') + p.slice(0, room); p = p.slice(room); }
        parts.push(normalizeText(buf)); buf = '';
      }
      if ((buf + '\n' + p).replace(/\n+/g, '\n').trim().length > maxLen && buf) {
        parts.push(normalizeText(buf)); buf = p;
      } else {
        buf += (buf ? '\n' : '') + p;
      }
    }
    if (stripWhitespace(buf)) parts.push(normalizeText(buf));
    return parts.length ? parts : [normalizeText(text)];
  }

  /* ---------- 进度 ---------- */

  /**
   * 全书阅读比例（0~1）。以 cue 数为分母 → 与字号、屏宽、排版无关。
   * @param {number[]} cueCounts 每章 cue 数
   */
  function readingRatio(cueCounts, chapterIndex, cueIndex) {
    if (!cueCounts || !cueCounts.length) return 0;
    var total = 0, i;
    for (i = 0; i < cueCounts.length; i++) total += cueCounts[i];
    if (!total) return 0;
    var ci = clamp(chapterIndex | 0, 0, cueCounts.length - 1);
    var done = 0;
    for (i = 0; i < ci; i++) done += cueCounts[i];
    done += clamp((cueIndex | 0) + 1, 0, cueCounts[ci] || 0);
    return clamp(done / total, 0, 1);
  }

  /** 进度冲突时取更新时间较新的一方（为后续多设备同步预留） */
  function mergeProgress(existing, incoming) {
    if (!existing) return incoming || null;
    if (!incoming) return existing;
    var a = Number(existing.updatedAt) || 0;
    var b = Number(incoming.updatedAt) || 0;
    return b > a ? incoming : existing;
  }

  function makeProgress(bookId, chapterIndex, cueIndex, mode) {
    return {
      bookId: bookId,
      chapterIndex: chapterIndex | 0,
      cueIndex: cueIndex | 0,
      mode: mode === 'listen' ? 'listen' : 'read',
      updatedAt: Date.now()
    };
  }

  /* ---------- 展示辅助 ---------- */

  function formatDuration(seconds) {
    var s = Math.max(0, Math.floor(Number(seconds) || 0));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var mm = (m < 10 ? '0' : '') + m, ss = (sec < 10 ? '0' : '') + sec;
    return h > 0 ? (h + ':' + mm + ':' + ss) : (mm + ':' + ss);
  }

  /** 朗读时长预估：仅用于界面预估显示，非精确值 */
  function estimateSpeechMs(charCount, rate) {
    var r = Number(rate) > 0 ? Number(rate) : 1;
    return Math.round((Math.max(0, charCount | 0) / CHARS_PER_SECOND / r) * 1000);
  }

  function countSpeechChars(cues, fromIndex) {
    var total = 0;
    for (var i = Math.max(0, fromIndex | 0); i < cues.length; i++) {
      total += stripWhitespace(speechText(cues[i])).length;
    }
    return total;
  }

  /* ---------- 备份（自用场景的保命功能：清浏览器数据 = 书架与进度全没） ---------- */

  var BACKUP_KIND = 'readit-backup';
  var BACKUP_VERSION = 1;

  /** 去掉运行时缓存字段（_cues / _counts），只留可序列化内容与进度 */
  function slimBook(b) {
    return {
      id: b.id, title: b.title, author: b.author, lang: b.lang || 'zh',
      intro: b.intro || '', source: b.source || 'local',
      cover: b.cover || null,
      chapters: (b.chapters || []).map(function (c) {
        return { title: c.title, text: c.text };
      })
    };
  }

  function makeBackup(settings, progress, books) {
    return {
      kind: BACKUP_KIND, version: BACKUP_VERSION, exportedAt: Date.now(),
      settings: settings || {}, progress: progress || {},
      books: (books || []).map(slimBook)
    };
  }

  /** 解析并校验备份文本；返回 {ok:true,data} 或 {ok:false,reason}（宁可拒绝也不要半截数据） */
  function parseBackup(raw) {
    var data;
    try { data = JSON.parse(String(raw)); }
    catch (e) { return { ok: false, reason: '不是合法的 JSON 文件' }; }
    if (!data || typeof data !== 'object') return { ok: false, reason: '内容不是对象' };
    if (data.kind !== BACKUP_KIND) return { ok: false, reason: '这不是本应用导出的备份文件' };
    if (Number(data.version) > BACKUP_VERSION) {
      return { ok: false, reason: '备份版本 ' + data.version + ' 高于当前支持的 ' + BACKUP_VERSION };
    }
    if (!Array.isArray(data.books)) return { ok: false, reason: '缺少 books 数组' };
    for (var i = 0; i < data.books.length; i++) {
      var b = data.books[i];
      if (!b || !b.id || !b.title || !Array.isArray(b.chapters)) {
        return { ok: false, reason: '第 ' + (i + 1) + ' 本书结构不完整（缺 id/title/chapters）' };
      }
      for (var j = 0; j < b.chapters.length; j++) {
        if (typeof b.chapters[j].text !== 'string') {
          return { ok: false, reason: '《' + b.title + '》第 ' + (j + 1) + ' 章正文不是字符串' };
        }
      }
    }
    return { ok: true, data: data };
  }

  /**
   * 合并备份：书按 id 去重（**不覆盖**已有内容，避免旧备份把新读的书打回原形），
   * 进度按 updatedAt 较新者胜出。
   */
  function mergeBackup(existingBooks, existingProgress, data) {
    var books = (existingBooks || []).slice();
    var progress = Object.assign({}, existingProgress || {});
    var byId = {};
    books.forEach(function (b) { byId[b.id] = true; });

    var added = 0, skipped = 0;
    (data.books || []).forEach(function (b) {
      if (byId[b.id]) { skipped++; return; }
      byId[b.id] = true;
      books.push(slimBook(b));
      added++;
    });

    var progressUpdated = 0;
    Object.keys(data.progress || {}).forEach(function (id) {
      var incoming = data.progress[id];
      if (!incoming || !incoming.bookId) return;
      var before = progress[id];
      var after = mergeProgress(before, incoming);
      if (after !== before) progressUpdated++;
      progress[id] = after;
    });

    return { books: books, progress: progress, added: added, skipped: skipped,
             progressUpdated: progressUpdated };
  }

  function isAscii(ch) { return ch >= '\u0021' && ch <= '\u007E'; }
  function isCjk(ch) {
    return (ch >= '\u3000' && ch <= '\u30FF') || (ch >= '\u3400' && ch <= '\u9FFF') ||
           (ch >= '\uF900' && ch <= '\uFAFF') || (ch >= '\uFF00' && ch <= '\uFFEF');
  }
  /** 同段内相邻两行的连接符：拉丁/数字之间补空格，中文之间不补 */
  function lineJoiner(prev, next) {
    var a = String(prev || '').slice(-1), b = String(next || '').charAt(0);
    if (!a || !b) return ' ';
    if (isCjk(a) || isCjk(b)) return '';
    return (isAscii(a) && isAscii(b)) ? ' ' : '';
  }

  /**
   * PDF 文本项 → 带段落的纯文本（纯函数，可在 Node 里测）。
   * items 直接吃 pdf.js 的 getTextContent().items：{ str, transform:[a,b,c,d,e,f] }
   *   e = x 坐标，f = y 坐标（PDF y 轴向上，取负后变成"越往下越大"）。
   * 分行：|Δy| ≤ tolerance 视为同一行，行内按 x 排序拼接；
   * 分段：相邻行间距 > 基准行距（取间距的 25 分位）× paragraphFactor 视为换段。
   */
  function groupPdfItems(items, opt) {
    opt = opt || {};
    var tol = opt.tolerance == null ? 2 : opt.tolerance;
    var factor = opt.paragraphFactor == null ? 1.6 : opt.paragraphFactor;

    var norm = [];
    (items || []).forEach(function (it) {
      if (!it || typeof it.str !== 'string' || !it.str.length) return;
      var tr = it.transform;
      var x = (tr && tr.length >= 5) ? Number(tr[4]) || 0 : Number(it.x) || 0;
      var y = (tr && tr.length >= 6) ? -(Number(tr[5]) || 0) : Number(it.y) || 0;
      norm.push({ str: it.str, x: x, y: y });
    });
    if (!norm.length) return '';

    norm.sort(function (a, b) { return (a.y - b.y) || (a.x - b.x); });

    var lines = [];
    norm.forEach(function (n) {
      var last = lines[lines.length - 1];
      if (last && Math.abs(last.y - n.y) <= tol) last.parts.push(n);
      else lines.push({ y: n.y, parts: [n] });
    });
    var joinedProbe = '';
    lines.forEach(function (L) {
      L.parts.sort(function (a, b) { return a.x - b.x; });
      var text = '';
      L.parts.forEach(function (p) {
        if (!text) { text = p.str; return; }
        // 拉丁/数字之间补空格，否则 "sentence" + "Chapter" 会粘成一个词；中文不补
        if (isAscii(text.slice(-1)) && isAscii(p.str.charAt(0))) text += ' ';
        text += p.str;
      });
      L.text = text.replace(/[ \t\u00A0]+/g, ' ').replace(/^ | $/g, '');
      joinedProbe += L.text + '\n';
    });

    // 是否清除中文间空格，按**整页**判定而不是按单行：逐字定位是全文一致的现象，
    // 按行判会漏掉只有 1~2 处空格的短行——章题「007｜精 华」就是这么漏网的（真书实测）。
    // 阈值 8 处：正常中文 PDF 极少出现这么多"单字+空格+单字"，不会误伤「第一章 起点」。
    if (isolatedCjkCount(joinedProbe) >= 8) {
      lines.forEach(function (L) { L.text = tidySpacingAlways(L.text); });
    }

    var gaps = [];
    for (var i = 1; i < lines.length; i++) {
      var g = lines[i].y - lines[i - 1].y;
      if (g > 0.5) gaps.push(g);
    }
    gaps.sort(function (a, b) { return a - b; });
    // 基准行距取 25 分位而不是中位数：行数少的时候中位数会被"段间距"这种大值带偏，
    // 导致段界永远识别不出来（实测 3 行样本就翻过车）。
    var base = gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.25))] : 12;

    var out = [];
    for (var j = 0; j < lines.length; j++) {
      if (j > 0) {
        var gap = lines[j].y - lines[j - 1].y;
        // 标题行必须独立成段。真书实测：章题行与正文行行距正常（16），会被当成同一段
        // 粘成「…6 段家好，我是陪我APP创始人…」，章题不在行首，后面所有行锚定的
        // 标题识别规则全部失效（355 个假章节就是这么来的）。
        var forceBreak = isHeadingText(lines[j].text) || isHeadingText(lines[j - 1].text);
        // 段内换行不能输出 \n —— splitSentences 会把 \n 当句末，把一句切成两半
        out.push((forceBreak || gap > base * factor) ? '\n\n'
                                                     : lineJoiner(lines[j - 1].text, lines[j].text));
      }
      out.push(lines[j].text);
    }
    return normalizeText(out.join(''));
  }

  /** 本地日期戳 YYYY-MM-DD（不能用 toISOString，那是 UTC，会让当天文件日期多一天） */
  function dateStamp(d) {
    var x = d instanceof Date ? d : new Date();
    var m = x.getMonth() + 1, day = x.getDate();
    return x.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
  }

  /* ---------- 音色挑选 ---------- */

  // 微软自然音色名字里带 Natural/Neural（Edge 上会列出 250+ 个，Chrome 不列）
  var GOOD_VOICE_RE = /(natural|neural|premium|enhanced)/i;

  /**
   * 给音色打分，分高的排前面。依据来自 Readium《SpeechSynthesis in browsers and OSes》：
   *   · 桌面 Edge 预装大量 natural voices，Chrome 只列少量且必须联网；
   *   · Chrome 桌面的 Google 语音有"单条 utterance 超 14 秒出问题"的已知 bug → 轻微降权。
   * 不做任何"哪个音色更好听"的主观断言，只按这些可查到的特征排。
   */
  function voiceScore(v) {
    var name = String((v && v.name) || '');
    var s = 0;
    if (GOOD_VOICE_RE.test(name)) s += 100;
    if (v && v.localService === false) s += 20;                       // 在线音色通常是厂商新的那批
    if (/^zh/i.test(String((v && v.lang) || ''))) s += 5;              // 同档内中文靠前
    if (/google/i.test(name)) s -= 10;
    return s;
  }

  /** 稳定排序：分数相同保持原顺序，避免每次刷新音色列表跳来跳去 */
  function rankVoices(list) {
    return (list || [])
      .map(function (v, i) { return { v: v, i: i, s: voiceScore(v) }; })
      .sort(function (a, b) { return (b.s - a.s) || (a.i - b.i); })
      .map(function (x) { return x.v; });
  }

  function isGoodVoice(v) {
    return GOOD_VOICE_RE.test(String((v && v.name) || ''));
  }

  var api = {
    groupPdfItems: groupPdfItems,
    voiceScore: voiceScore,
    rankVoices: rankVoices,
    isGoodVoice: isGoodVoice,
    tidyCjkSpacing: tidyCjkSpacing,
    headingKind: headingKind,
    cleanHeadingTitle: cleanHeadingTitle,
    markHeadings: markHeadings,
    isHeadingText: isHeadingText,
    dateStamp: dateStamp,
    BACKUP_KIND: BACKUP_KIND,
    BACKUP_VERSION: BACKUP_VERSION,
    slimBook: slimBook,
    makeBackup: makeBackup,
    parseBackup: parseBackup,
    mergeBackup: mergeBackup,
    HARD_END: HARD_END,
    MAX_SENT: MAX_SENT,
    MAX_CHAPTER: MAX_CHAPTER,
    clamp: clamp,
    normalizeText: normalizeText,
    stripWhitespace: stripWhitespace,
    isHeading: isHeading,
    splitSentences: splitSentences,
    speechText: speechText,
    findCueIndexAt: findCueIndexAt,
    splitChapters: splitChapters,
    breakByLength: breakByLength,
    readingRatio: readingRatio,
    mergeProgress: mergeProgress,
    makeProgress: makeProgress,
    formatDuration: formatDuration,
    estimateSpeechMs: estimateSpeechMs,
    countSpeechChars: countSpeechChars
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ReadItCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
