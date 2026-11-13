/*
 * parse.js —— 内容接入层：把用户手里的文件变成可朗读的书
 *   输入：{ name, size?, lastModified?, text? | arrayBuffer?, deps? }
 *   输出：Promise<{ title, author, format, chapters:[{title,text}], warnings[] }>
 *
 * 设计约定（不要改回去）：
 *   · 纯文本处理，不用 DOMParser —— 这样 node 里能直接跑单元测试（test/parse.test.js）
 *   · 第三方库通过 deps 注入（JSZip / mammoth / pdfjsLib），缺哪一个就报哪一个的名字
 *   · 失败必须抛中文原因，绝不出"一本空书"；章节标题没找到要自动切分并留 warning
 *
 * 事故记录：本文件原实现被我（Accio）在另一轮里用自写版本覆盖丢失，
 * 现版本按它留下的 test/parse.test.js 逐条重建 —— 测试即规格。
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    root.ReadItParse = factory(root.ReadItCore);
  }
}(typeof window !== 'undefined' ? window : globalThis, function (core) {
  'use strict';

  /* ================= 扩展名 ================= */
  var TEXT_EXT = ['txt', 'text'];
  var MD_EXT = ['md', 'markdown', 'mdown'];
  var HTML_EXT = ['html', 'htm', 'xhtml'];
  var EPUB_EXT = ['epub'];
  var DOCX_EXT = ['docx'];
  var PDF_EXT = ['pdf'];
  var NO_SUPPORT_EXT = ['mobi', 'azw', 'azw3', 'fb2', 'lit', 'djvu', 'doc'];

  function extOf(name) {
    var m = /\.([A-Za-z0-9]+)$/.exec(String(name == null ? '' : name));
    return m ? m[1].toLowerCase() : '';
  }
  function baseName(name) {
    var s = String(name == null ? '' : name).replace(/\\/g, '/');
    s = s.slice(s.lastIndexOf('/') + 1);
    s = s.replace(/\.[A-Za-z0-9]+$/, '');
    s = s.replace(/_+/g, ' ').trim();
    return s || '未命名';
  }
  function supportedExt() {
    return TEXT_EXT.concat(MD_EXT, HTML_EXT, EPUB_EXT, DOCX_EXT, PDF_EXT);
  }
  function inList(list, ext) { return list.indexOf(ext) >= 0; }

  /* ================= 实体解码 ================= */
  var NAMED = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
    mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', middot: '\u00B7',
    ldquo: '\u201C', rdquo: '\u201D', lsquo: '\u2018', rsquo: '\u2019',
    laquo: '\u00AB', raquo: '\u00BB', bull: '\u2022', copy: '\u00A9',
    reg: '\u00AE', trade: '\u2122', times: '\u00D7', divide: '\u00F7',
    deg: '\u00B0', plusmn: '\u00B1', frac12: '\u00BD', sup2: '\u00B2',
    sup3: '\u00B3', micro: '\u00B5', para: '\u00B6', sect: '\u00A7',
    prime: '\u2032', Prime: '\u2033', larr: '\u2190', rarr: '\u2192'
  };

  function decodeEntities(s) {
    return String(s == null ? '' : s).replace(/&(#[Xx]?[0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/g,
      function (whole, body) {
        if (body.charAt(0) === '#') {
          var hex = body.charAt(1) === 'X' || body.charAt(1) === 'x';
          var code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
          if (!isFinite(code) || code < 0 || code > 0x10FFFF) return whole;
          try { return String.fromCodePoint ? String.fromCodePoint(code) : String.fromCharCode(code); }
          catch (e) { return whole; }
        }
        return Object.prototype.hasOwnProperty.call(NAMED, body) ? NAMED[body] : whole;
      });
  }

  /** 属性提取：必须带前置边界，否则 id 会误配到 idref 上；
   *  绝不要用「先匹配引号」的备选分支——那会让 href 被前一个属性的收尾引号抢先命中而取空。 */
  function attr(tagText, name) {
    var s = String(tagText == null ? '' : tagText);
    var esc = String(name).replace(/[-[\]{}()*+?.\\^$|/]/g, '\\$&');
    var re = new RegExp('[\\s;,]' + esc + '\\s*=\\s*"([^"]*)"|[\\s;,]' + esc + "\\s*=\\s*'([^']*)'", 'i');
    var m = re.test(' ' + s) ? re.exec(' ' + s) : null;
    if (!m) return '';
    return decodeEntities(m[1] != null ? m[1] : m[2]);
  }

  /* ================= HTML → 纯文本（无 DOM） ================= */
  function stripNoise(html) {
    return String(html == null ? '' : html)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<\?[\s\S]*?\?>/g, ' ')
      .replace(/<![^>]*>/g, ' ')
      .replace(/<(script|style|head|nav|aside|footer|iframe|svg|form|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  }

  /** 行内：去标签 + 解码实体（脚本样式已在上一步整体删掉） */
  function inline(s) {
    return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\u00A0/g, ' ');
  }

  function htmlToPlainText(html) {
    var s = stripNoise(html);

    // h1~h3 → "# 标题"（core.splitChapters 认这个前缀）；h4+ 只当普通行
    s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, function (m0, lvl, inner) {
      var t = inline(inner).replace(/\s+/g, ' ').trim();
      if (!t) return ' ';
      return (Number(lvl) <= 3 ? '\n\n# ' + t + '\n\n' : '\n\n' + t + '\n\n');
    });

    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<\/(p|div|li|ul|ol|blockquote|tr|td|th|dd|dt|figure|figcaption|article|section|h[1-6])\s*>/gi, '\n');
    s = s.replace(/<(li|p|div|blockquote|tr|dd|dt)\b[^>]*>/gi, '\n');

    s = inline(s);

    var lines = s.split('\n').map(function (l) { return l.replace(/[ \t\u3000]+/g, ' ').trim(); });
    var out = [];
    lines.forEach(function (l) {
      if (!l) return;
      if (/^#/.test(l)) {                    // 标题行：前后各留空行，然后必须 return
        out.push(''); out.push(l); out.push('');
        return;                              // ← 少了这句会把标题行重复一遍
      }
      if (out.length && out[out.length - 1] !== '') out.push('');   // 段落之间留空行
      out.push(l);
    });
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ================= Markdown → 纯文本 ================= */
  function mdToPlain(md) {
    var s = String(md == null ? '' : md);
    var fences = [];
    s = s.replace(/```[\s\S]*?```/g, function (block) {
      fences.push(block);
      return '\n\n\u0000FENCE' + (fences.length - 1) + '\u0000\n\n';
    });

    s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');                       // 图片整体删
    s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');                     // 链接只留文字
    s = s.replace(/(\*\*\*|___)(.+?)\1/g, '$2');
    s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
    s = s.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, '$1$2');
    s = s.replace(/`([^`\n]+)`/g, '$1');
    s = s.replace(/^\s{0,3}#{1,6}[ \t]+/gm, '# ');                      // 各级标题统一成 #
    s = s.replace(/^[ \t]*[-*+][ \t]+/gm, '');                          // 无序列表符号
    s = s.replace(/^[ \t]*\d+\.[ \t]+/gm, '');                          // 有序列表号
    s = s.replace(/^[ \t]*>[ \t]?/gm, '');                              // 引用
    s = s.replace(/^[ \t]*(?:[-*_][ \t]*){2,}[ \t]*$/gm, '');           // 分割线

    s = s.replace(/\u0000FENCE(\d+)\u0000/g, function (m0, i) {         // 还原代码块（内容原样，内部不转换）
      var b = fences[Number(i)] || '';
      return '\n\n' + b.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '').trim() + '\n\n';
    });

    return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /* ================= EPUB 结构 ================= */
  function parseContainerXml(xml) {
    var s = String(xml == null ? '' : xml);
    var m = /<rootfile\b[^>]*?full-path\s*=\s*["']([^"']+)["']/i.exec(s);
    if (!m || !m[1].trim()) throw new Error('不是有效的 EPUB：container.xml 里找不到 rootfile');
    return m[1].trim();
  }

  function parseOpf(xml) {
    var s = String(xml == null ? '' : xml);
    if (!/<package\b/i.test(s)) throw new Error('不是 OPF 文件：缺少 package 根节点');

    function tagText(tag) {
      var m = new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)</' + tag + '\\s*>', 'i').exec(s);
      return m ? decodeEntities(m[1].replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim() : '';
    }

    var items = {};
    var reItem = /<item\b([^>]*?)\/?>/gi, mi;
    while ((mi = reItem.exec(s))) {
      var id = attr(mi[1], 'id'), href = attr(mi[1], 'href');
      if (!id || !href) continue;
      items[id] = { href: href, type: attr(mi[1], 'media-type'), props: attr(mi[1], 'properties') };
    }

    var spine = [], seen = {};
    var reRef = /<itemref\b([^>]*?)\/?>/gi, mr;
    while ((mr = reRef.exec(s))) {
      if (attr(mr[1], 'linear').toLowerCase() === 'no') continue;
      var it = items[attr(mr[1], 'idref')];
      if (!it) continue;
      var type = String(it.type || '').toLowerCase();
      var isDoc = /html/.test(type) || (/xml/.test(type) && !/ncx/.test(type));
      if (!isDoc) continue;                                  // CSS / 图片 / 目录文件不进正文
      if (seen[it.href]) continue;
      seen[it.href] = true;
      spine.push(it.href);
    }

    var tocPath = '';
    Object.keys(items).forEach(function (k) {
      var it = items[k];
      if (/ncx/i.test(it.type) || /ncx$/i.test(it.href)) { if (!tocPath) tocPath = it.href; }
      else if (/nav/.test(it.props) || /nav\.x?html?$/i.test(it.href)) { tocPath = it.href; }
    });

    if (!spine.length) throw new Error('EPUB 的 spine 是空的，没有可朗读的正文');
    return { title: tagText('dc:title'), author: tagText('dc:creator'), spine: spine, tocPath: tocPath };
  }

  function joinPath(opfPath, href) {
    var p = String(href == null ? '' : href).split('#')[0];
    if (!p) return '';
    try { p = decodeURIComponent(p); } catch (e) { /* 保留原样 */ }
    var dir = String(opfPath || '');
    dir = dir.indexOf('/') >= 0 ? dir.slice(0, dir.lastIndexOf('/') + 1) : '';
    var out = [];
    (dir + p).split('/').forEach(function (seg) {
      if (!seg || seg === '.') return;
      if (seg === '..') { out.pop(); return; }
      out.push(seg);
    });
    return out.join('/');
  }

  /** entries 的键大小写可能与 spine 不一致，做忽略大小写 + 同文件名的两级回退查找 */
  function entryAt(entries, want) {
    var lower = String(want).toLowerCase();
    var keys = Object.keys(entries);
    for (var i = 0; i < keys.length; i++) if (keys[i].toLowerCase() === lower) return entries[keys[i]];
    var base = lower.split('/').pop();
    for (var j = 0; j < keys.length; j++) {
      if (keys[j].toLowerCase().split('/').pop() === base) return entries[keys[j]];
    }
    return null;
  }

  /** 从 nav.xhtml / toc.ncx 抽 href → 标题，给没有标题的章补名字 */
  function readToc(text) {
    var map = {};
    if (!text) return map;
    function put(href, label) {
      var key = String(href || '').split('#')[0].split('/').pop();
      var t = decodeEntities(String(label || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (key && t && !map[key]) map[key] = t;
    }
    var m;
    var navRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{1,200}?)<\/a>/gi;
    while ((m = navRe.exec(text))) put(m[1], m[2]);
    var ncxRe = /<navLabel>\s*<text>([\s\S]{1,200}?)<\/text>\s*<\/navLabel>[\s\S]{0,300}?<content\b[^>]*src\s*=\s*["']([^"']+)["']/gi;
    while ((m = ncxRe.exec(text))) put(m[2], m[1]);
    return map;
  }

  var MAX_CHAPTER_TEXT = 4000;      // 单章上限，整本书塞一个 xhtml 时自动再切

  /** 超长章按段落再切，不丢字 */
  function splitLongChapter(title, text, cap) {
    cap = cap || MAX_CHAPTER_TEXT;
    if (text.length <= cap) return [{ title: title, text: text }];
    var paras = text.split(/\n{2,}/);
    if (paras.length === 1) paras = text.split('\n');
    var parts = [], buf = '';
    function flush() { if (buf.trim()) parts.push(buf.trim()); buf = ''; }
    paras.forEach(function (p) {
      if (!p) return;
      if (p.length > cap) {                                  // 单段就超长：先按句，再按字数兜底
        flush();
        var chunk = '';
        core.splitSentences(p).forEach(function (c) {
          var t = c.text;
          while (t.length > cap) {          // 极端情况：整段只有一个超长句（无标点文本）
            parts.push(t.slice(0, cap));
            t = t.slice(cap);
          }
          if (!t) return;
          if (chunk && (chunk + t).length > cap) { parts.push(chunk); chunk = ''; }
          chunk += t;
        });
        if (chunk.trim()) parts.push(chunk.trim());
        return;
      }
      if (buf && (buf + '\n\n' + p).length > cap) flush();
      buf = buf ? buf + '\n\n' + p : p;
    });
    flush();
    return parts.map(function (t, i) {
      return { title: i === 0 ? title : title + ' · ' + (i + 1), text: t };
    });
  }

  function epubChapters(entries, opf, opfPath, fallbackTitle, tocMap) {
    entries = entries || {};
    tocMap = tocMap || {};
    var bookTitle = (opf && opf.title) || fallbackTitle || '未命名';
    var chapters = [];

    ((opf && opf.spine) || []).forEach(function (href) {
      var joined = joinPath(opfPath, href);
      var raw = entryAt(entries, joined);
      if (raw == null) return;                                          // 缺文件：跳过，最后统一判空
      var plain = htmlToPlainText(raw);
      // 只跳"读不出东西"的页：空页，或既很短又没有任何句末标点（典型封面/版权页）
      var flat = core.stripWhitespace(plain);
      if (!flat) return;
      if (flat.length < 40 && !/[。！？!?；;]/.test(flat)) return;

      var lines = plain.split('\n');
      var title = '', body = plain;
      for (var i = 0; i < lines.length; i++) {
        var t = lines[i].trim();
        if (!t) continue;
        if (/^#[ \t]/.test(t)) {
          title = t.replace(/^#[ \t]+/, '').trim();
          body = lines.slice(i + 1).join('\n').trim();
        } else {
          title = tocMap[joined.split('/').pop()] || '';
        }
        break;
      }
      if (!title) title = bookTitle + ' · ' + (chapters.length + 1);
      if (!core.stripWhitespace(body)) return;      // 只有标题没有正文的分片，不配占一章

      splitLongChapter(title, core.normalizeText(body)).forEach(function (part) {
        chapters.push(part);
      });
    });

    if (!chapters.length) {
      throw new Error('EPUB 里没读到任何正文（可能是纯图片扫描版，或缺少正文分片）');
    }
    return chapters;
  }

  /* ================= 各格式入口 ================= */
  function toArrayBuffer(buf) {
    if (!buf) return buf;
    if (typeof ArrayBuffer !== 'undefined' && buf instanceof ArrayBuffer) return buf;
    if (buf.buffer instanceof ArrayBuffer) {
      return buf.buffer.slice(buf.byteOffset || 0, (buf.byteOffset || 0) + (buf.byteLength || buf.length));
    }
    return buf;
  }

  function parseEpub(input) {
    var zipLib = (input.deps || {}).JSZip;
    if (!zipLib) return Promise.reject(new Error('EPUB 解析库未加载（缺 JSZip）'));
    var warnings = [];
    var loaded = zipLib.loadAsync ? Promise.resolve(zipLib.loadAsync(input.arrayBuffer))
      : Promise.reject(new Error('JSZip 版本过旧，没有 loadAsync'));

    return loaded.then(function (zip) {
      var cf = zip.file('META-INF/container.xml');
      if (!cf) throw new Error('不是有效的 EPUB：找不到 META-INF/container.xml');
      return cf.async('string').then(function (xml) {
        var opfPath = parseContainerXml(xml);
        var of = zip.file(opfPath);
        if (!of) throw new Error('EPUB 目录文件缺失：' + opfPath);
        return of.async('string').then(function (opfStr) {
          var opf = parseOpf(opfStr);
          var need = {};
          opf.spine.forEach(function (h) { need[joinPath(opfPath, h)] = true; });
          if (opf.tocPath) need[joinPath(opfPath, opf.tocPath)] = true;

          var entries = {}, jobs = [];
          Object.keys(need).forEach(function (path) {
            var f = zip.file(path);
            if (!f) { warnings.push('包里缺文件：' + path); return; }
            jobs.push(f.async('string').then(function (t) { entries[path] = t; }, function () {
              warnings.push('读取失败：' + path);
            }));
          });

          return Promise.all(jobs).then(function () {
            var tocMap = opf.tocPath ? readToc(entries[joinPath(opfPath, opf.tocPath)]) : {};
            return {
              title: opf.title || baseName(input.name),
              author: opf.author || '未知',
              format: 'epub',
              chapters: epubChapters(entries, opf, opfPath, baseName(input.name), tocMap),
              warnings: warnings
            };
          });
        });
      });
    });
  }

  function parseDocx(input) {
    var mammoth = (input.deps || {}).mammoth;
    if (!mammoth) return Promise.reject(new Error('DOCX 解析库未加载（缺 mammoth）'));
    return Promise.resolve(mammoth.extractRawText({ arrayBuffer: toArrayBuffer(input.arrayBuffer) }))
      .then(function (res) {
        var text = core.normalizeText((res && res.value) || '');
        if (!core.stripWhitespace(text)) throw new Error('DOCX 里没提取到文字（可能是纯图片文档）');
        var warnings = [];
        if (res && res.messages && res.messages.length) warnings.push('mammoth 给了 ' + res.messages.length + ' 条提示');
        var chapters = core.splitChapters(text);
        if (chapters.length === 1 && core.stripWhitespace(text).length > 6000) {
          warnings.push('文档没用标题样式，章节按长度自动切分');
        }
        return { title: baseName(input.name), author: '未知', format: 'docx', chapters: chapters, warnings: warnings };
      });
  }

  function parsePdf(input) {
    var pdfjs = (input.deps || {}).pdfjsLib;
    if (!pdfjs) return Promise.reject(new Error('PDF 解析库未加载（缺 pdfjsLib）'));
    // app.js 会设好 workerSrc；这里补一个兜底，否则 pdf.js 直接抛
    // "No GlobalWorkerOptions.workerSrc specified"
    try {
      if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
      }
    } catch (e) { /* 版本差异，忽略 */ }
    var pending;
    try {
      pending = pdfjs.getDocument({ data: toArrayBuffer(input.arrayBuffer), isEvalSupported: false }).promise;
    } catch (e) {
      return Promise.reject(new Error('PDF 打不开：' + ((e && e.message) || e)));
    }
    return Promise.resolve(pending).then(function (doc) {
      // 必须**逐页**分组再拼接：不同页的 y 坐标会重复，混在一起排序会把两页同一行高的
      // 文字并成一行（实测过，英文样本里出现 "sentence.Chapter two" 这种跨页粘连）
      var pageTexts = [];
      var seq = Promise.resolve();
      for (var p = 1; p <= doc.numPages; p++) {
        (function (n) {
          seq = seq.then(function () {
            return doc.getPage(n).then(function (page) { return page.getTextContent(); })
              .then(function (c) {
                pageTexts.push(core.groupPdfItems(c.items || []));
              }, function () { pageTexts.push(''); });   // 单页失败不拖垮整本
          });
        })(p);
      }
      return seq.then(function () {
        var text = core.normalizeText(pageTexts.filter(function (t) { return t; }).join('\n\n'));
        if (core.stripWhitespace(text).length < 30) {
          throw new Error('PDF 没有文字层，这是扫描版；要做听书得先 OCR');
        }
        var chapters = core.splitChapters(text);
        if (chapters.length === 1) chapters = splitLongChapter(baseName(input.name), text);
        return {
          title: baseName(input.name), author: '未知', format: 'pdf', chapters: chapters,
          warnings: ['PDF 共 ' + doc.numPages + ' 页，未读取书签目录，章节按标题或长度切分']
        };
      });
    });
  }

  /** 疑似编码错误：出现替换字符 U+FFFD，或典型的 GBK→UTF8 误读特征 */
  function looksGarbled(text) {
    var s = core.stripWhitespace(String(text || '')).slice(0, 400);
    if (!s) return false;
    if (s.indexOf('\uFFFD') >= 0) return true;
    var mojibake = (s.match(/[ÃÅÐ][\u0080-\u00BF]|â\u0080[\u0080-\u00BF]/g) || []).length;
    return mojibake >= 2;
  }

  function parseTextual(input, ext) {
    var raw = String(input.text == null ? '' : input.text);
    if (!core.stripWhitespace(raw)) return Promise.reject(new Error('文件是空的（或只有空白字符）'));
    var text = raw;
    if (inList(MD_EXT, ext)) text = mdToPlain(raw);
    else if (inList(HTML_EXT, ext)) text = htmlToPlainText(raw);

    var chapters = core.splitChapters(text);
    if (!chapters.length) return Promise.reject(new Error('没解析出正文内容'));
    var warnings = [];
    if (looksGarbled(text)) {
      warnings.push('内容疑似不是 UTF-8，若看到乱码请用记事本「另存为」选 UTF-8 后重导');
    }
    return Promise.resolve({
      title: baseName(input.name), author: '未知',
      format: inList(TEXT_EXT, ext) ? 'txt' : ext, chapters: chapters, warnings: warnings
    });
  }

  /* ================= 总入口 ================= */
  function parseBook(input) {
    input = input || {};
    var ext = extOf(input.name);

    if (inList(NO_SUPPORT_EXT, ext)) {
      return Promise.reject(new Error('不支持 .' + ext + ' 格式。请先用免费软件 Calibre 转成 EPUB 再导入'));
    }
    if (inList(EPUB_EXT, ext)) return parseEpub(input);
    if (inList(DOCX_EXT, ext)) return parseDocx(input);
    if (inList(PDF_EXT, ext)) return parsePdf(input);
    if (inList(TEXT_EXT, ext) || inList(MD_EXT, ext) || inList(HTML_EXT, ext)) {
      return parseTextual(input, ext);
    }
    return Promise.reject(new Error('不支持的文件类型：.' + (ext || '?') +
      '。目前支持 ' + supportedExt().join(' / ')));
  }

  return {
    TEXT_EXT: TEXT_EXT, MD_EXT: MD_EXT, HTML_EXT: HTML_EXT,
    EPUB_EXT: EPUB_EXT, DOCX_EXT: DOCX_EXT, PDF_EXT: PDF_EXT,
    NO_SUPPORT_EXT: NO_SUPPORT_EXT, MAX_CHAPTER_TEXT: MAX_CHAPTER_TEXT,
    extOf: extOf, baseName: baseName, supportedExt: supportedExt,
    decodeEntities: decodeEntities, attr: attr,
    htmlToPlainText: htmlToPlainText, mdToPlain: mdToPlain,
    parseContainerXml: parseContainerXml, parseOpf: parseOpf, joinPath: joinPath,
    readToc: readToc, epubChapters: epubChapters, splitLongChapter: splitLongChapter,
    looksGarbled: looksGarbled, parseBook: parseBook
  };
}));
