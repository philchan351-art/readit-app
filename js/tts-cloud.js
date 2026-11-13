/*
 * tts-cloud.js —— 云端神经音色引擎（走本机 server.py 的 /tts 中转）
 *
 * 对外接口与 js/tts.js 完全一致，app.js 可以互换使用：
 *   supported / state{playing,paused,chapterIndex,cueIndex,rate,voiceId,lastError}
 *   playChapter(ci, idx) / jumpTo(ci, idx) / toggle() / stop()
 *   setRate(rate) / setVoice(id) / refreshVoices(cb)
 *
 * 两个设计要点：
 *   1) **一句一请求**。音频边界天然等于 cue 边界，所以逐句高亮不需要任何时间戳对齐，
 *      也不会像逐词对齐那样一崩全崩。单次音频上限 10 分钟，一句最多几十个字，完全用不到。
 *   2) **语速用 playbackRate，不重新合成**。这样缓存键只跟「文本 + 音色」有关，
 *      同一句换语速不用重复请求（省额度、省等待）。
 *
 * 失败一定看得见：任何一次请求失败都写进 state.lastError 并触发 onStateChange，
 * 由界面显示，绝不静默停住。
 */
(function (global) {
  'use strict';

  var MAX_KEEP = 40;          // 内存里最多缓存多少句的 blob，超了就把最老的释放掉

  function createCloudEngine(hooks) {
    hooks = hooks || {};

    var state = {
      playing: false, paused: false, chapterIndex: -1, cueIndex: 0,
      rate: 1, voiceId: '', lastError: '', backend: 'cloud', mock: false
    };
    var gen = 0;
    var audio = new global.Audio();
    audio.preload = 'auto';
    var cache = {};           // key -> {url, bytes}
    var order = [];

    function safe(name, arg) {
      var fn = hooks[name];
      if (typeof fn === 'function') {
        try { fn(arg); } catch (e) { /* 回调出错不能打断播放 */ }
      }
    }

    function cuesOf(chapterIndex) {
      var list = null;
      try { list = hooks.getCues ? hooks.getCues(chapterIndex) : null; } catch (e) { list = null; }
      return list || [];
    }

    function cueText(cue) {
      if (!cue) return '';
      if (typeof cue.text === 'string') return cue.text;
      return String(cue.str || '');
    }

    function cachedUrl(text) {
      var hit = cache[text];
      if (hit) {
        for (var i = 0; i < order.length; i++) {
          if (order[i] === text) { order.splice(i, 1); break; }
        }
        order.push(text);
        return hit.url;
      }
      return null;
    }

    function remember(text, blobUrl) {
      if (cache[text]) { global.URL.revokeObjectURL(cache[text].url); delete cache[text]; }
      cache[text] = { url: blobUrl };
      order.push(text);
      while (order.length > MAX_KEEP) {
        var old = order.shift();
        if (cache[old] && cache[old].url !== audio.src) {
          global.URL.revokeObjectURL(cache[old].url);
          delete cache[old];
        } else { order.push(old); break; }
      }
    }

    function request(text) {
      var payload = { text: text };
      if (state.voiceId) { payload.voice = state.voiceId; }
      return global.fetch('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (resp) {
        if (!resp.ok) {
          return resp.text().then(function (t) { throw new Error(t.slice(0, 160) || ('HTTP ' + resp.status)); });
        }
        state.mock = /wav/.test(resp.headers.get('Content-Type') || '');
        return resp.blob();
      }).then(function (blob) {
        return global.URL.createObjectURL(blob);
      });
    }

    function playCurrent(myGen) {
      var cues = cuesOf(state.chapterIndex);
      var cue = cues[state.cueIndex];
      if (!cue) { finishChapter(myGen); return; }

      safe('onCueStart', { chapterIndex: state.chapterIndex, cueIndex: state.cueIndex });
      state.playing = true;
      state.paused = false;
      safe('onStateChange', snapshot());

      var text = cueText(cue).trim();
      if (!text) { advance(myGen); return; }

      var known = cachedUrl(text);
      var pending = known ? Promise.resolve(known) : request(text);

      pending.then(function (url) {
        if (myGen !== gen) { if (!known) global.URL.revokeObjectURL(url); return; }
        if (!known) remember(text, url);
        audio.src = url;
        audio.playbackRate = Math.min(2, Math.max(0.5, Number(state.rate) || 1));
        return audio.play();
      }).catch(function (e) {
        if (myGen !== gen) return;
        state.lastError = (e && e.message) ? e.message : String(e);
        state.playing = false;
        state.paused = false;
        safe('onStateChange', snapshot());
      });

      prefetchNext(myGen, cues);
    }

    function prefetchNext(myGen, cues) {
      var next = cues[state.cueIndex + 1];
      if (!next) return;
      var text = cueText(next).trim();
      if (!text || cachedUrl(text)) return;
      request(text).then(function (url) { if (myGen === gen) remember(text, url); })
        .catch(function () { /* 预取失败没关系，轮到它时会再请求一次 */ });
    }

    function advance(myGen) {
      var cues = cuesOf(state.chapterIndex);
      state.cueIndex += 1;
      if (state.cueIndex >= cues.length) { finishChapter(myGen); return; }
      safe('onCueEnd', { chapterIndex: state.chapterIndex, cueIndex: state.cueIndex - 1 });
      playCurrent(myGen);
    }

    function finishChapter(myGen) {
      if (myGen !== gen) return;
      var last = state.chapterIndex;
      state.playing = false;
      state.paused = false;
      safe('onChapterEnd', { chapterIndex: last });
      safe('onStateChange', snapshot());
    }

    function snapshot() {
      return {
        playing: state.playing, paused: state.paused,
        chapterIndex: state.chapterIndex, cueIndex: state.cueIndex,
        rate: state.rate, voiceId: state.voiceId, lastError: state.lastError
      };
    }

    audio.addEventListener('ended', function () { advance(gen); });
    audio.addEventListener('error', function () {
      if (!state.playing) return;
      state.lastError = '音频播放失败（可能这一句的缓存坏了）';
      gen += 1;
      state.playing = false;
      state.paused = false;
      safe('onStateChange', snapshot());
    });

    return {
      supported: true,
      state: state,

      playChapter: function (chapterIndex, cueIndex) {
        gen += 1;
        state.chapterIndex = chapterIndex;
        state.cueIndex = Math.max(0, cueIndex || 0);
        state.lastError = '';
        playCurrent(gen);
      },

      jumpTo: function (chapterIndex, cueIndex) {
        state.chapterIndex = chapterIndex;
        state.cueIndex = Math.max(0, cueIndex || 0);
        safe('onStateChange', snapshot());
      },

      toggle: function () {
        var myGen = gen;
        if (!state.playing) { playCurrent(myGen); return; }
        if (state.paused) {
          audio.play();
          state.paused = false;
        } else {
          audio.pause();
          state.paused = true;
        }
        safe('onStateChange', snapshot());
      },

      stop: function () {
        gen += 1;
        try { audio.pause(); } catch (e) { /* 忽略 */ }
        audio.removeAttribute('src');
        state.playing = false;
        state.paused = false;
        safe('onStateChange', snapshot());
      },

      setRate: function (rate) {
        state.rate = Number(rate) || 1;
        // 语速只改播放器，不重新合成 → 同一句换语速不用二次请求，也不重复计费
        try { audio.playbackRate = Math.min(2, Math.max(0.5, state.rate)); } catch (e) { /* 忽略 */ }
        safe('onStateChange', snapshot());
      },

      setVoice: function (id) {
        state.voiceId = String(id || '');
        safe('onStateChange', snapshot());
      },

      refreshVoices: function (done) {
        global.fetch('/tts/voices').then(function (r) { return r.json(); }).then(function (data) {
          state.mock = !!data.mock;
          var list = (data.voices || []).map(function (v) {
            var short = v.ShortName || v.id || '';
            return {
              id: short,
              name: (v.DisplayName ? v.DisplayName + ' ' : '') + short,   // 含 Neural → 界面自动打 ★
              lang: v.Locale || 'zh-CN',
              localService: false
            };
          });
          if (typeof done === 'function') done(list, { mock: state.mock, error: data.error || '' });
        }).catch(function (e) {
          if (typeof done === 'function') done([], { mock: true, error: (e && e.message) || String(e) });
        });
      }
    };
  }

  global.ReadItTtsCloud = { createCloudEngine: createCloudEngine };
})(typeof window !== 'undefined' ? window : globalThis);
