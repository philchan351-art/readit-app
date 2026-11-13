/*
 * tts.js —— 朗读后端（可插拔）
 *
 * 当前实现：浏览器 Web Speech API（零成本、无需 API Key，用于 M0 原型）。
 * 换成云端 TTS 时只需保留同一对外接口（supported/state/speakCue/stop…），
 * 内部改为「请求音频 → 播放 <audio> → ended 回调」，上层 app.js 与 core.js 不用改。
 *
 * 对外接口：
 *   createTtsEngine({ getCues, onCueStart, onCueEnd, onStateChange, onChapterEnd })
 *     .supported        boolean
 *     .voices()         -> [{ id, name, lang, localService }]
 *     .state            -> { playing, paused, chapterIndex, cueIndex, rate, voiceId }
 *     .playChapter(ci, startCue)
 *     .toggle() / pause() / resume() / stop()
 *     .jumpTo(ci, cueIndex)
 *     .setRate(r) / setVoice(id)
 */
(function (global) {
  'use strict';

  var KEEP_ALIVE_MS = 9000; // Chrome 长文本会静默中断，周期性 pause/resume 规避

  function createTtsEngine(opts) {
    var syn = global.speechSynthesis || null;
    var SpeechUtterance = global.SpeechSynthesisUtterance || global.SpeechSynthesisUtterance || null;
    var getCues = opts.getCues;                 // (chapterIndex) => cues[]
    var onCueStart = opts.onCueStart || noop;
    var onCueEnd = opts.onCueEnd || noop;
    var onStateChange = opts.onStateChange || noop;
    var onChapterEnd = opts.onChapterEnd || noop;

    var gen = 0;                // 代数令牌：stop/jump 后旧回调一律作废
    var keepAliveTimer = null;
    var current = { ci: -1, idx: -1 };
    var state = { playing: false, paused: false, chapterIndex: -1, cueIndex: -1, rate: 1, voiceId: '' };

    function noop() {}
    function emit() { onStateChange({ state: state, supported: !!syn }); }

    function allVoices() {
      if (!syn) return [];
      try { return syn.getVoices() || []; } catch (e) { return []; }
    }

    function voices() {
      return allVoices().map(function (v, i) {
        return {
          id: v.voiceURI || (v.name + '#' + i),
          name: v.name,
          lang: v.lang,
          localService: !!v.localService,
          default: !!v.default
        };
      });
    }

    function pickVoice(id) {
      var list = allVoices();
      for (var i = 0; i < list.length; i++) {
        var vid = list[i].voiceURI || (list[i].name + '#' + i);
        if (vid === id) return list[i];
      }
      // 未指定/找不到 → 优先中文语音
      var zh = list.filter(function (v) { return /^zh/i.test(v.lang || ''); });
      return zh.length ? zh[0] : (list[0] || null);
    }

    function stopKeepAlive() {
      if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
    }
    function startKeepAlive(myGen) {
      stopKeepAlive();
      keepAliveTimer = setInterval(function () {
        if (myGen !== gen) return stopKeepAlive();
        try {
          if (syn.speaking && !syn.paused) { syn.pause(); syn.resume(); }
        } catch (e) { /* 忽略：部分浏览器不支持 */ }
      }, KEEP_ALIVE_MS);
    }

    function halt() {
      gen++;
      stopKeepAlive();
      if (syn) { try { syn.cancel(); } catch (e) {} }
    }

    function playCue(ci, idx) {
      var myGen = gen;
      var cues = getCues(ci) || [];
      if (idx >= cues.length) {
        state.playing = false; state.paused = false;
        state.chapterIndex = ci; state.cueIndex = idx;
        emit();
        onChapterEnd({ chapterIndex: ci });
        return;
      }
      var core = global.ReadItCore;
      var text = core ? core.speechText(cues[idx]) : String(cues[idx].text || '').trim();
      current = { ci: ci, idx: idx };
      state.playing = true; state.paused = false;
      state.chapterIndex = ci; state.cueIndex = idx;
      emit();

      if (!text) return playCue(ci, idx + 1);

      var u = new SpeechUtterance();
      u.text = text;
      u.rate = state.rate;
      u.pitch = 1;
      u.volume = 1;
      var v = pickVoice(state.voiceId);
      if (v) { u.voice = v; u.lang = v.lang; }

      u.onstart = function () { if (myGen !== gen) return; onCueStart({ chapterIndex: ci, cueIndex: idx }); };
      u.onend = function () {
        if (myGen !== gen) return;
        onCueEnd({ chapterIndex: ci, cueIndex: idx });
        playCue(ci, idx + 1);
      };
      u.onerror = function (ev) {
        if (myGen !== gen) return;
        var reason = (ev && ev.error) || 'unknown';
        if (reason === 'interrupted' || reason === 'canceled') return; // 主动停止，不算失败
        onStateChange({ state: state, supported: true, error: '语音合成出错：' + reason });
        playCue(ci, idx + 1);                  // 单句失败不阻塞整本书
      };
      try { syn.speak(u); } catch (e) {
        onStateChange({ state: state, supported: true, error: '无法启动语音合成：' + e.message });
      }
    }

    return {
      supported: !!syn && !!SpeechUtterance,

      voices: voices,

      state: state,

      refreshVoices: function (cb) {
        if (!syn) return cb && cb([]);
        var list = voices();
        if (list.length) return cb && cb(list);
        var done = false;
        var handler = function () {
          if (done) return;
          done = true;
          cb && cb(voices());
        };
        syn.onvoiceschanged = handler;
        setTimeout(handler, 800); // 兜底：部分实现不触发事件
      },

      setRate: function (r) {
        state.rate = global.ReadItCore ? global.ReadItCore.clamp(r, 0.5, 2) : r;
        emit(); // 语速对「下一句」生效，不打断当前句
      },

      setVoice: function (id) { state.voiceId = id; emit(); },

      playChapter: function (ci, startCue) {
        if (!this.supported) {
          onStateChange({ state: state, supported: false,
            error: '当前浏览器不支持语音合成（Web Speech API）。' });
          return;
        }
        halt();
        startKeepAlive(gen);
        playCue(ci, Math.max(0, startCue | 0));
      },

      jumpTo: function (ci, cueIndex) {
        if (!this.supported) return;
        var wasPlaying = state.playing && !state.paused;
        halt();
        if (wasPlaying || state.playing) { startKeepAlive(gen); playCue(ci, cueIndex | 0); }
        else { state.chapterIndex = ci; state.cueIndex = cueIndex | 0; emit(); }
      },

      pause: function () {
        if (!syn) return;
        try { syn.pause(); } catch (e) {}
        state.paused = true; emit();
      },

      resume: function () {
        if (!syn) return;
        try { syn.resume(); } catch (e) {}
        state.paused = false; emit();
      },

      toggle: function () {
        if (!this.supported) {
          onStateChange({ state: state, supported: false,
            error: '当前浏览器不支持语音合成（Web Speech API）。' });
          return;
        }
        if (state.playing && !state.paused) return this.pause();
        if (state.playing && state.paused) return this.resume();
        this.playChapter(state.chapterIndex < 0 ? 0 : state.chapterIndex,
                         state.cueIndex < 0 ? 0 : state.cueIndex);
      },

      stop: function () {
        halt();
        state.playing = false; state.paused = false;
        emit();
      },

      dispose: function () { halt(); }
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createTtsEngine: createTtsEngine };
  else global.ReadItTts = { createTtsEngine: createTtsEngine };
})(typeof globalThis !== 'undefined' ? globalThis : this);
