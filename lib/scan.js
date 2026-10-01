/* scan.js - ISBN (EAN-13 978/979) camera scanner overlay.
   window.ISBNScanner.open({title}) -> Promise<string|null>. Never rejects.
   Uses native BarcodeDetector when it supports ean_13, otherwise lazy-loads zxing-ean.js
   (resolved from this script's URL, or window.ISBNScanner.base if set). */
(function (w, doc) {
  'use strict';
  var GOLD = '#d4b97a';
  var cur = doc.currentScript && doc.currentScript.src;
  var SCRIPT_BASE = cur ? cur.replace(/[^\/]*$/, '') : 'lib/';
  var MSG = {
    denied: 'Camera access is turned off for this app. You can type the ISBN instead.',
    nocam: 'No camera was found on this device. You can type the ISBN instead.',
    busy: 'The camera is being used by another app. You can type the ISBN instead.',
    insecure: 'The camera needs a secure (https) connection. You can type the ISBN instead.',
    decoder: 'The barcode reader couldn\u2019t load. You can type the ISBN instead.',
    other: 'The camera couldn\u2019t start. You can type the ISBN instead.'
  };
  var CSS =
    '.isbnscan{position:fixed;inset:0;z-index:1000;background:#0b0907;color:#f3ead8;overflow:hidden;' +
    'font:15px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-user-select:none;user-select:none;touch-action:none}' +
    '.isbnscan video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}' +
    '.isbnscan .vf{position:absolute;left:50%;top:44%;width:min(84vw,520px);height:min(40vw,240px);transform:translate(-50%,-50%);' +
    'border:2px solid ' + GOLD + ';border-radius:18px;box-shadow:0 0 0 200vmax rgba(8,6,4,.58),inset 0 0 0 1px rgba(0,0,0,.25)}' +
    '.isbnscan .vf::after{content:"";position:absolute;left:8%;right:8%;top:50%;height:1px;background:rgba(212,185,122,.55)}' +
    '.isbnscan .vf.ok{border-width:3px;background:rgba(212,185,122,.38)}' +
    '.isbnscan .ttl{position:absolute;left:0;right:0;top:calc(env(safe-area-inset-top,0px) + 22px);text-align:center;' +
    'font-size:17px;font-weight:600;letter-spacing:.02em;padding:0 72px;text-shadow:0 1px 3px rgba(0,0,0,.6)}' +
    '.isbnscan .hint{position:absolute;left:50%;top:calc(44% + min(20vw,120px) + 18px);transform:translateX(-50%);width:max-content;' +
    'max-width:min(84vw,520px);box-sizing:border-box;padding:6px 14px;border-radius:999px;background:rgba(12,9,7,.62);' +
    'text-align:center;color:rgba(243,234,216,.92)}' +
    '.isbnscan .x{position:absolute;top:calc(env(safe-area-inset-top,0px) + 12px);right:calc(env(safe-area-inset-right,0px) + 12px);' +
    'width:44px;height:44px;border-radius:22px;border:1px solid rgba(212,185,122,.55);background:rgba(20,16,12,.6);color:#f3ead8;' +
    'font-size:26px;line-height:42px;padding:0;cursor:pointer;-webkit-tap-highlight-color:transparent;' +
    '-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}' +
    '.isbnscan .x:focus-visible{outline:2px solid ' + GOLD + ';outline-offset:2px}' +
    '.isbnscan .msg{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);width:min(80vw,380px);box-sizing:border-box;' +
    'padding:18px 20px;border-radius:16px;background:rgba(24,19,14,.94);border:1px solid rgba(212,185,122,.5);text-align:center;display:none}' +
    '.isbnscan.err .msg{display:block}.isbnscan.err .vf,.isbnscan.err .hint{display:none}' +
    '@media (prefers-reduced-motion:no-preference){.isbnscan .vf.ok{animation:isbnflash .45s ease-out}' +
    '@keyframes isbnflash{0%{background:rgba(212,185,122,.75);box-shadow:0 0 0 200vmax rgba(212,185,122,.35)}' +
    '100%{background:rgba(212,185,122,.15)}}}';

  var active = null, decoderP = null;

  function validISBN13(s) {
    if (!/^97[89]\d{10}$/.test(s)) return false;
    var sum = 0;
    for (var i = 0; i < 12; i++) sum += (s.charCodeAt(i) - 48) * (i % 2 ? 3 : 1);
    return (10 - sum % 10) % 10 === s.charCodeAt(12) - 48;
  }

  function base() {
    var b = w.ISBNScanner && w.ISBNScanner.base;
    if (!b) return SCRIPT_BASE;
    return /\/$/.test(b) ? b : b + '/';
  }

  function loadDecoder() {
    if (w.ZXingEAN) return Promise.resolve(w.ZXingEAN);
    if (decoderP) return decoderP;
    decoderP = new Promise(function (res, rej) {
      var s = doc.createElement('script');
      s.src = base() + 'zxing-ean.js';
      s.async = true;
      s.onload = function () { w.ZXingEAN ? res(w.ZXingEAN) : rej(new Error('no decoder')); };
      s.onerror = function () { s.remove(); rej(new Error('decoder load failed')); };
      doc.head.appendChild(s);
    });
    decoderP.catch(function () { decoderP = null; });
    return decoderP;
  }

  function nativeDetector() {
    try {
      if (!('BarcodeDetector' in w) || typeof w.BarcodeDetector !== 'function') return Promise.resolve(null);
      var BD = w.BarcodeDetector;
      var p = BD.getSupportedFormats ? BD.getSupportedFormats() : Promise.resolve(['ean_13']);
      return Promise.resolve(p).then(function (f) {
        return f && f.indexOf('ean_13') >= 0 ? new BD({ formats: ['ean_13'] }) : null;
      }, function () { return null; });
    } catch (e) { return Promise.resolve(null); }
  }

  function el(tag, cls, parent) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (parent) parent.appendChild(e);
    return e;
  }

  function reducedMotion() {
    try { return w.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }

  function open(opts) {
    if (active) return active;
    opts = opts || {};
    active = new Promise(function (resolve) {
      var done = false, stream = null, timer = 0, msgTimer = 0, frame = 0, lastCode = '', lastAt = 0;
      var detector = null, zx = null, busy = false, prevFocus = doc.activeElement;

      if (!doc.getElementById('isbnscan-css')) {
        var st = el('style'); st.id = 'isbnscan-css'; st.textContent = CSS; doc.head.appendChild(st);
      }
      var root = el('div', 'isbnscan', null);
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-modal', 'true');
      root.setAttribute('aria-label', opts.title || 'Scan ISBN');
      var video = el('video', '', root);
      video.setAttribute('playsinline', ''); video.setAttribute('muted', ''); video.setAttribute('autoplay', '');
      video.playsInline = true; video.muted = true; video.autoplay = true;
      var vf = el('div', 'vf', root);
      var ttl = el('div', 'ttl', root); ttl.textContent = opts.title || 'Scan ISBN';
      var hint = el('div', 'hint', root); hint.textContent = 'Point the camera at the barcode on the back of the book';
      var msg = el('div', 'msg', root); msg.setAttribute('role', 'alert');
      var x = el('button', 'x', root); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.textContent = '\u00d7';
      var canvas = doc.createElement('canvas'), ctx = null;
      doc.body.appendChild(root);
      try { x.focus({ preventScroll: true }); } catch (e) {}

      function stopTracks() {
        if (stream) { try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {} stream = null; }
        try { video.pause(); video.srcObject = null; } catch (e) {}
      }
      function finish(val) {
        if (done) return;
        done = true;
        clearTimeout(timer); clearTimeout(msgTimer);
        stopTracks();
        doc.removeEventListener('visibilitychange', onVis);
        doc.removeEventListener('keydown', onKey, true);
        if (root.parentNode) root.parentNode.removeChild(root);
        active = null;
        try { if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true }); } catch (e) {}
        resolve(val);
      }
      function fail(key) {
        if (done) return;
        stopTracks();
        clearTimeout(timer);
        msg.textContent = MSG[key] || MSG.other;
        root.classList.add('err');
        msgTimer = setTimeout(function () { finish(null); }, 2500);
      }
      function onVis() { if (doc.hidden) finish(null); }
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); finish(null); } }
      x.addEventListener('click', function () { finish(null); });
      doc.addEventListener('visibilitychange', onVis);
      doc.addEventListener('keydown', onKey, true);

      function success(code) {
        if (done) return;
        clearTimeout(timer);
        try { if (navigator.vibrate) navigator.vibrate(30); } catch (e) {}
        vf.classList.add('ok');
        setTimeout(function () { finish(code); }, reducedMotion() ? 120 : 380);
      }
      function candidate(code) {
        code = String(code || '').replace(/\D/g, '');
        if (!validISBN13(code)) return false;
        var now = Date.now();
        // require two matching reads within 1.5 s to reject one-off misreads
        if (code === lastCode && now - lastAt < 1500) { success(code); return true; }
        lastCode = code; lastAt = now;
        return false;
      }

      // Region of the video frame under the viewfinder (video is object-fit:cover).
      function cropRect(pad) {
        var vw = video.videoWidth, vh = video.videoHeight, R = root.getBoundingClientRect(), V = vf.getBoundingClientRect();
        var s = Math.max(R.width / vw, R.height / vh), ox = (R.width - vw * s) / 2, oy = (R.height - vh * s) / 2;
        var cx = (V.left + V.width / 2 - R.left - ox) / s, cy = (V.top + V.height / 2 - R.top - oy) / s;
        var cw = V.width * pad / s, ch = V.height * pad / s;
        cw = Math.min(cw, vw); ch = Math.min(ch, vh);
        var sx = Math.max(0, Math.min(vw - cw, cx - cw / 2)), sy = Math.max(0, Math.min(vh - ch, cy - ch / 2));
        return [Math.round(sx), Math.round(sy), Math.round(cw), Math.round(ch)];
      }
      function grab(r, rotate) {
        var sw = r[2], sh = r[3], k = Math.min(1, 800 / Math.max(sw, sh)), dw = Math.round(sw * k), dh = Math.round(sh * k);
        var W = rotate ? dh : dw, H = rotate ? dw : dh;
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; ctx = null; }
        if (!ctx) ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.save();
        if (rotate) { ctx.translate(W, 0); ctx.rotate(Math.PI / 2); }
        ctx.drawImage(video, r[0], r[1], sw, sh, 0, 0, dw, dh);
        ctx.restore();
        var d = ctx.getImageData(0, 0, W, H).data, n = W * H, lum = new Uint8ClampedArray(n);
        for (var i = 0, j = 0; i < n; i++, j += 4) lum[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
        return [lum, W, H];
      }

      function tick() {
        if (done) return;
        timer = setTimeout(tick, detector ? 120 : 90);
        if (busy || video.readyState < 2 || !video.videoWidth) return;
        frame++;
        try {
          if (detector) {
            busy = true;
            detector.detect(video).then(function (list) {
              busy = false;
              for (var i = 0; list && i < list.length; i++) if (candidate(list[i].rawValue)) return;
            }, function () { busy = false; });
          } else if (zx) {
            // 2 of 3 frames: the viewfinder band; every 3rd: a taller area rotated 90deg (book held sideways)
            var rot = frame % 3 === 0, g;
            if (rot) {
              var r = cropRect(1), side = Math.min(video.videoWidth, video.videoHeight);
              var cx = r[0] + r[2] / 2, cy = r[1] + r[3] / 2;
              g = grab([Math.round(Math.max(0, Math.min(video.videoWidth - side, cx - side / 2))), Math.round(Math.max(0, Math.min(video.videoHeight - side, cy - side / 2))), side, side], true);
            } else g = grab(cropRect(1.35), false);
            var code = zx.decode(g[0], g[1], g[2], false);
            if (code) candidate(code);
          }
        } catch (e) { busy = false; }
      }

      if (!w.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        fail(w.isSecureContext === false ? 'insecure' : 'nocam');
        return;
      }
      var decP = nativeDetector().then(function (d) {
        if (d) { detector = d; return; }
        return loadDecoder().then(function (z) { zx = z; });
      });
      var camP;
      try {
        camP = navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
        });
      } catch (e) { camP = Promise.reject(e); }
      camP.then(function (s) {
        if (done) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
        stream = s;
        var track = s.getVideoTracks()[0];
        if (track) {
          track.addEventListener('ended', function () { if (!done && stream) fail('other'); });
          // iPhone Pro main lenses cannot focus close up; a little zoom lets the book sit further away.
          try {
            var caps = track.getCapabilities ? track.getCapabilities() : {}, adv = {};
            if (caps.focusMode && caps.focusMode.indexOf('continuous') >= 0) adv.focusMode = 'continuous';
            if (caps.zoom && caps.zoom.max >= 1.6) adv.zoom = Math.max(caps.zoom.min || 1, Math.min(2, caps.zoom.max));
            if (Object.keys(adv).length) track.applyConstraints({ advanced: [adv] }).catch(function () {});
          } catch (e) {}
        }
        video.srcObject = s;
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
        return decP.then(function () { if (!done) tick(); }, function () { fail('decoder'); });
      }, function (e) {
        var n = e && e.name;
        fail(n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError' ? 'denied' :
          n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError' ? 'nocam' :
            n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError' ? 'busy' : 'other');
      }).catch(function () { fail('other'); });
    });
    return active;
  }

  function safeOpen(opts) {
    try { return open(opts); } catch (e) { active = null; return Promise.resolve(null); }
  }

  var api = w.ISBNScanner || {};
  api.open = safeOpen;
  api.isValidISBN13 = validISBN13;
  api.preload = function () { return loadDecoder().then(function () { return true; }, function () { return false; }); };
  w.ISBNScanner = api;
})(window, document);
