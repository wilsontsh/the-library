/* qr.js - tiny QR encoder (byte mode, ECC level M, versions 1-40) -> SVG string.
   Algorithm after Nayuki's QR Code generator (MIT). window.QR.svg(text, opts), window.QR.matrix(text) */
(function (w) {
  'use strict';
  var ECC = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  var NB = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];

  function rawModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) { var n = (v / 7 | 0) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
    return r;
  }
  function dataCodewords(v) { return (rawModules(v) >> 3) - ECC[v] * NB[v]; }
  function gmul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; }
    return z;
  }
  function divisor(deg) {
    var r = [], root = 1, i, j;
    for (i = 0; i < deg - 1; i++) r.push(0);
    r.push(1);
    for (i = 0; i < deg; i++) {
      for (j = 0; j < deg; j++) { r[j] = gmul(r[j], root); if (j + 1 < deg) r[j] ^= r[j + 1]; }
      root = gmul(root, 2);
    }
    return r;
  }
  function remainder(data, div) {
    var r = div.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ r.shift();
      r.push(0);
      for (var i = 0; i < div.length; i++) r[i] ^= gmul(div[i], f);
    });
    return r;
  }
  function utf8(s) {
    if (w.TextEncoder) return Array.prototype.slice.call(new TextEncoder().encode(s));
    s = unescape(encodeURIComponent(s));
    var a = [];
    for (var i = 0; i < s.length; i++) a.push(s.charCodeAt(i));
    return a;
  }
  var MASKS = [
    function (x, y) { return (x + y) % 2 === 0; },
    function (x, y) { return y % 2 === 0; },
    function (x) { return x % 3 === 0; },
    function (x, y) { return (x + y) % 3 === 0; },
    function (x, y) { return ((x / 3 | 0) + (y / 2 | 0)) % 2 === 0; },
    function (x, y) { return x * y % 2 + x * y % 3 === 0; },
    function (x, y) { return (x * y % 2 + x * y % 3) % 2 === 0; },
    function (x, y) { return ((x + y) % 2 + x * y % 3) % 2 === 0; }
  ];

  function encode(text) {
    var bytes = utf8(String(text)), v, cap;
    for (v = 1; ; v++) {
      if (v > 40) throw new RangeError('QR: text too long');
      cap = dataCodewords(v) * 8;
      if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= cap) break;
    }
    // bit stream
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - bits.length % 8) % 8);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

    // error correction + interleave
    var nb = NB[v], el = ECC[v], raw = rawModules(v) >> 3, nShort = nb - raw % nb, shortLen = raw / nb | 0;
    var div = divisor(el), blocks = [], k = 0, b;
    for (b = 0; b < nb; b++) {
      var dat = data.slice(k, k + shortLen - el + (b < nShort ? 0 : 1));
      k += dat.length;
      var ecc = remainder(dat, div);
      if (b < nShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    var cw = [];
    for (i = 0; i < blocks[0].length; i++)
      for (b = 0; b < nb; b++) if (i !== shortLen - el || b >= nShort) cw.push(blocks[b][i]);

    // matrix
    var n = v * 4 + 17, M = [], F = [], x, y, dx, dy;
    for (y = 0; y < n; y++) { M.push(new Array(n).fill(false)); F.push(new Array(n).fill(false)); }
    function set(x, y, d) { M[y][x] = d; F[y][x] = true; }
    for (i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    [[3, 3], [n - 4, 3], [3, n - 4]].forEach(function (c) {
      for (dy = -4; dy <= 4; dy++) for (dx = -4; dx <= 4; dx++) {
        var xx = c[0] + dx, yy = c[1] + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (xx >= 0 && xx < n && yy >= 0 && yy < n) set(xx, yy, d !== 2 && d !== 4);
      }
    });
    var al = [];
    if (v > 1) {
      var na = (v / 7 | 0) + 2, step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (na * 2 - 2)) * 2;
      al = [6];
      for (var p = n - 7; al.length < na; p -= step) al.splice(1, 0, p);
    }
    al.forEach(function (ay, i) {
      al.forEach(function (ax, j) {
        if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
        for (dy = -2; dy <= 2; dy++) for (dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      });
    });
    function format(mask) {
      var d = mask, r = d; // ECC M format bits = 00
      for (var i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
      var f = ((d << 10) | r) ^ 0x5412, g = function (i) { return ((f >>> i) & 1) === 1; };
      for (i = 0; i <= 5; i++) set(8, i, g(i));
      set(8, 7, g(6)); set(8, 8, g(7)); set(7, 8, g(8));
      for (i = 9; i < 15; i++) set(14 - i, 8, g(i));
      for (i = 0; i < 8; i++) set(n - 1 - i, 8, g(i));
      for (i = 8; i < 15; i++) set(8, n - 15 + i, g(i));
      set(8, n - 8, true);
    }
    format(0);
    if (v >= 7) {
      var r = v;
      for (i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
      var vb = (v << 12) | r;
      for (i = 0; i < 18; i++) { var bit = ((vb >>> i) & 1) === 1, a = n - 11 + i % 3, c = i / 3 | 0; set(a, c, bit); set(c, a, bit); }
    }
    // place codewords
    k = 0;
    for (var right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < n; vert++) for (var j = 0; j < 2; j++) {
        x = right - j;
        y = ((right + 1) & 2) === 0 ? n - 1 - vert : vert;
        if (!F[y][x] && k < cw.length * 8) { M[y][x] = ((cw[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
      }
    }
    // choose mask by penalty
    function applyMask(m) {
      for (y = 0; y < n; y++) for (x = 0; x < n; x++) if (!F[y][x] && MASKS[m](x, y)) M[y][x] = !M[y][x];
    }
    function penalty() {
      var s = 0, dark = 0, lines = [], row, col;
      for (y = 0; y < n; y++) {
        row = ''; col = '';
        for (x = 0; x < n; x++) {
          row += M[y][x] ? 1 : 0; col += M[x][y] ? 1 : 0;
          if (M[y][x]) dark++;
          if (x < n - 1 && y < n - 1 && M[y][x] === M[y][x + 1] && M[y][x] === M[y + 1][x] && M[y][x] === M[y + 1][x + 1]) s += 3;
        }
        lines.push(row, col);
      }
      lines.forEach(function (l) {
        (l.match(/0{5,}|1{5,}/g) || []).forEach(function (run) { s += run.length - 2; });
        s += 40 * (('0000' + l + '0000').match(/(?=10111010000|00001011101)/g) || []).length;
      });
      return s + (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
    }
    var best = 0, bestP = Infinity;
    for (var m = 0; m < 8; m++) {
      applyMask(m); format(m);
      var pp = penalty();
      if (pp < bestP) { bestP = pp; best = m; }
      applyMask(m);
    }
    applyMask(best); format(best);
    return M;
  }

  function esc(s) { return String(s).replace(/[&"<>]/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }

  function svg(text, o) {
    o = o || {};
    var M = encode(text), n = M.length, mg = o.margin == null ? 4 : +o.margin, t = n + 2 * mg, size = o.size || 256;
    var dark = o.dark || '#000', light = o.light == null ? '#fff' : o.light, d = '';
    for (var y = 0; y < n; y++) {
      for (var x = 0; x < n; x++) {
        if (!M[y][x]) continue;
        var s = x;
        while (x + 1 < n && M[y][x + 1]) x++;
        d += 'M' + (s + mg) + ' ' + (y + mg) + 'h' + (x - s + 1) + 'v1h-' + (x - s + 1) + 'z';
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + t + ' ' + t + '" width="' + size + '" height="' + size +
      '" shape-rendering="crispEdges">' +
      (light && light !== 'transparent' && light !== 'none' ? '<rect width="100%" height="100%" fill="' + esc(light) + '"/>' : '') +
      '<path fill="' + esc(dark) + '" d="' + d + '"/></svg>';
  }

  w.QR = { svg: svg, matrix: encode };
})(typeof window !== 'undefined' ? window : globalThis);
