/* csv.js - Goodreads / StoryGraph CSV import + Goodreads-compatible export.
   window.LibraryCSV.parse(text) -> {source, books, skipped}
   window.LibraryCSV.toCSV(books) -> string
   window.LibraryCSV.rows(text) -> string[][] (raw RFC 4180 parse) */
(function (w) {
  'use strict';

  // ---- RFC 4180 parser: quoted fields, "" escapes, embedded commas / newlines, CRLF/LF/CR, BOM ----
  function rows(text) {
    text = String(text == null ? '' : text);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    var out = [], row = [], f = '', i = 0, n = text.length, q = false, c;
    while (i < n) {
      c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { f += '"'; i += 2; continue; }
          q = false; i++; continue;
        }
        f += c; i++; continue;
      }
      if (c === '"' && f === '') { q = true; i++; continue; }
      if (c === ',') { row.push(f); f = ''; i++; continue; }
      if (c === '\r' || c === '\n') {
        row.push(f); out.push(row); row = []; f = '';
        i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      f += c; i++;
    }
    if (f !== '' || row.length) { row.push(f); out.push(row); }
    return out;
  }

  // ---- helpers ----
  function clean(s) { return String(s == null ? '' : s).replace(/[\s ]+/g, ' ').trim(); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function num(s) {
    s = clean(s).replace(/,/g, '');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return +s;
  }
  function isbn10to13(s) {
    var b = '978' + s.slice(0, 9), sum = 0;
    for (var i = 0; i < 12; i++) sum += (+b[i]) * (i % 2 ? 3 : 1);
    return b + (10 - sum % 10) % 10;
  }
  function isbn(s) {
    s = String(s || '').replace(/^=|"/g, '').replace(/[\s-]/g, '').toUpperCase();
    if (/^97[89]\d{10}$/.test(s)) return s;
    if (/^\d{9}[\dX]$/.test(s)) return isbn10to13(s);
    if (/^\d{13}$/.test(s)) return s;
    return '';
  }
  var MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  // -> {y, m, d} or null. Accepts 2023/05/14, 2023-05-14, 2023/05, 05/14/2023, "May 14, 2023", "14 May 2023"
  function date(s) {
    s = clean(s);
    if (!s) return null;
    var m = /^(\d{4})[\/\-.](\d{1,2})(?:[\/\-.](\d{1,2}))?/.exec(s);
    if (m) return ok(+m[1], +m[2], m[3] ? +m[3] : 1);
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (m) return ok(+m[3], +m[1], +m[2]);
    m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/.exec(s) || /^(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4})/.exec(s);
    if (m) {
      var mon = MON[(isNaN(+m[1]) ? m[1] : m[2]).toLowerCase()];
      if (mon) return ok(+m[3], mon, +(isNaN(+m[1]) ? m[2] : m[1]));
    }
    return null;
    function ok(y, mo, d) { return y > 0 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? { y: y, m: mo, d: d } : null; }
  }
  function ym(d) { return d ? d.y + '-' + pad(d.m) : null; }
  function ms(d) { return d ? new Date(d.y, d.m - 1, d.d).getTime() : null; }
  function entities(s) {
    return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, function (all, e) {
      var k = e.toLowerCase();
      if (k[0] === '#') {
        var cp = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : all;
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k];
    });
  }
  function review(s) {
    s = String(s || '').replace(/\r\n?/g, '\n');
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n').replace(/<[^>]+>/g, '');
    return entities(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function list(s) {
    return clean(s).split(/\s*[,;]\s*/).filter(Boolean);
  }
  function titleCase(s) {
    return clean(s).toLowerCase().replace(/(^|[\s\-\/])(\S)/g, function (a, b, c) { return b + c.toUpperCase(); });
  }
  var STATUS_SHELVES = { 'read': 1, 'to-read': 1, 'currently-reading': 1, 'did-not-finish': 1, 'dnf': 1, 'paused': 1 };
  function tags(s, extraExclude) {
    var seen = {}, out = [];
    list(s).forEach(function (t) {
      var k = t.toLowerCase();
      if (STATUS_SHELVES[k] || k === extraExclude || seen[k]) return;
      seen[k] = 1; out.push(t);
    });
    return out;
  }
  // "Harry Potter and the Chamber of Secrets (Harry Potter, #2)" -> title, series, seriesNo
  function series(t) {
    var r = { title: clean(t), series: null, seriesNo: null };
    var m = /\s*\(([^()]*#[^()]*)\)\s*$/.exec(r.title);
    if (!m) return r;
    var first = m[1].split(';')[0], s = /^(.*?),?\s*#\s*(\d+(?:\.\d+)?)?/.exec(first);
    if (!s || !clean(s[1])) return r;
    var rest = r.title.slice(0, m.index).trim();
    if (!rest) return r;
    r.title = rest;
    r.series = clean(s[1]);
    r.seriesNo = s[2] != null ? +s[2] : null;
    return r;
  }

  // ---- parse ----
  function parse(text) {
    var all = rows(text).filter(function (r) { return !/^\s*#/.test(String(r[0] == null ? '' : r[0])); }), h = -1, i; // lines starting with # are notes
    for (i = 0; i < all.length; i++) if (all[i].some(function (c) { return clean(c); })) { h = i; break; }
    if (h < 0) return { source: 'unknown', books: [], skipped: 0 };
    var head = all[h].map(function (c) { return clean(c).toLowerCase(); }), col = {};
    var ALIAS = { '書名': 'title', '书名': 'title', '作者': 'author', '狀態': 'status', '状态': 'status', '閱讀狀態': 'status', '阅读状态': 'status',
      '評分': 'rating', '评分': 'rating', '分數': 'rating', '分数': 'rating', '星': 'rating', '日期': 'date read', '讀完日期': 'date read', '读完日期': 'date read', '完成日期': 'date read',
      '心得': 'review', '評語': 'review', '评语': 'review', '感受': 'moods', 'feelings': 'moods', '類別': 'genre', '类别': 'genre', '系列': 'series', '系列編號': 'series no', '喜愛': 'favourite', '最愛': 'favourite', '借出': 'lent to', '筆記': 'notes', '笔记': 'notes', '摘錄': 'quotes', '摘录': 'quotes', '副書名': 'second title', '譯者': 'translator', '譯': 'translator' };
    head.forEach(function (name, j) { name = ALIAS[name] || name; if (!(name in col)) col[name] = j; });
    var has = function (n) { return n in col; };
    var source = has('exclusive shelf') || (has('my rating') && has('bookshelves')) || has('book id') ? 'goodreads' :
      has('read status') || has('isbn/uid') || has('star rating') ? 'storygraph' : 'unknown';
    var books = [], skipped = 0, now = Date.now(), now_ym = new Date().toISOString().slice(0, 7);

    for (i = h + 1; i < all.length; i++) {
      var r = all[i];
      if (!r.some(function (c) { return clean(c); })) continue;
      var get = function () {
        for (var a = 0; a < arguments.length; a++) {
          var j = col[arguments[a]];
          if (j != null && r[j] != null && clean(r[j]) !== '') return r[j];
        }
        return '';
      };
      var st = series(get('title', 'book title', 'name'));
      if (!st.title) { skipped++; continue; }
      var b = {
        title: st.title,
        author: clean(get('author', 'authors', 'author l-f')),
        isbn: isbn(get('isbn13', 'isbn/uid', 'isbn', 'isbn10')) || isbn(get('isbn')),
        year: null, publisher: clean(get('publisher')), pages: null, rating: null,
        status: 'want', dateRead: null, reads: [], review: review(get('my review', 'review')),
        tags: [], feelings: [], series: st.series, seriesNo: st.seriesNo, createdAt: now
      };
      var y = num(get('original publication year', 'year published', 'year', 'publication year'));
      b.year = y != null && y === Math.round(y) ? y : null;
      var pg = num(get('number of pages', 'pages', 'page count'));
      b.pages = pg != null && pg > 0 ? Math.round(pg) : null;
      var rtRaw = clean(get('my rating', 'star rating', 'rating')), rt = num(rtRaw);
      if (rt == null) { var stars = (rtRaw.match(/[★⭐]/g) || []).length; if (stars) rt = stars + (/½|\.5/.test(rtRaw) ? 0.5 : 0); else { var fr = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+)$/.exec(rtRaw); if (fr && +fr[2] > 0) rt = Math.round(+fr[1] / +fr[2] * 5 * 2) / 2; } }
      if (rt != null && rt > 5 && rt <= 10) rt = Math.round(rt) / 2; // a 10-point score
      b.rating = rt != null && rt > 0 ? Math.min(5, rt) : null;
      var added = date(get('date added'));
      if (added) b.createdAt = ms(added);

      var stat = clean(get('exclusive shelf', 'read status', 'status', 'shelf')).toLowerCase().replace(/[\s_]+/g, '-'), dnf = false;
      if (stat === 'read' || stat === 'finished' || stat === 'done' || stat === 'r' || stat === '已讀' || stat === '已读' || stat === '讀完' || stat === '读完') b.status = 'read';
      else if (stat === 'put-aside' || stat === 'aside' || stat === 'on-hold' || stat === '暫停' || stat === '放低') { b.status = 'reading'; b.pausedAt = now_ym; }
      else if (stat === 'currently-reading' || stat === 'reading' || stat === 'paused' || stat === '在讀' || stat === '在读' || stat === '閱讀中' || stat === '阅读中') b.status = 'reading';
      else if (stat === 'did-not-finish' || stat === 'dnf' || stat === 'abandoned' || stat === '未讀完' || stat === '未读完') { b.status = 'read'; dnf = true; }
      else if (stat === 'to-read' || stat === 'toread' || stat === 'want' || stat === 'want-to-read' || stat === 'tbr' || stat === 't' || stat === '想讀' || stat === '想读' || stat === '待讀' || stat === '待读' || stat === '未讀' || stat === '未读') b.status = 'want';
      else if (date(get('date read', 'last date read'))) b.status = 'read';
      else if (b.rating) b.status = 'read'; // a rating means she has read it

      // reads: StoryGraph "Dates Read" = "2021/01/02-2021/01/20, 2023/04/01-2023/05/14"; Goodreads: single Date Read
      var finishes = [];
      clean(get('dates read')).split(/\s*[,;]\s*/).forEach(function (seg) {
        var ds = seg.match(/\d{4}[\/.\-]\d{1,2}(?:[\/.\-]\d{1,2})?/g);
        var d = ds && date(ds[ds.length - 1]);
        if (d) finishes.push(ym(d));
      });
      if (!finishes.length) {
        var drRaw = clean(get('date read', 'last date read', 'date finished')), drs = drRaw.split(/\s*;\s*/);
        drs.forEach(function (seg) { var dd = date(/^\d{4}-\d{2}$/.test(seg) ? seg + '-01' : seg); if (dd) finishes.push(ym(dd)); });
      }
      finishes = finishes.filter(function (f, k) { return finishes.indexOf(f) === k; }).sort();
      if (b.status === 'read' || b.status === 'reading') {
        b.reads = finishes.map(function (f) { return { finish: f }; });
        b.dateRead = finishes.length ? finishes[finishes.length - 1] : null;
      }
      if (b.status === 'reading') { b.dateRead = null; }

      b.tags = tags(get('bookshelves', 'tags', 'shelves'), stat);
      var moods = list(get('moods')).map(titleCase);
      if (dnf) moods.push('Did not finish');
      b.feelings = moods.filter(function (m, k) { return moods.indexOf(m) === k; });
      // the library's own columns
      var gtext = clean(get('genre', 'section')); if (gtext) b.genreText = gtext;
      var sr = clean(get('series')); if (sr) { b.series = sr; var sn = num(get('series no', 'series number', 'number in series')); b.seriesNo = sn != null ? sn : null; }
      var fv = clean(get('favourite', 'favorite')).toLowerCase(); if (fv) b.favourite = /^(y|yes|true|1|x|♥|❤|★|favou?rite)/.test(fv);
      ['lent to', 'format', 'translator', 'second title', 'notes', 'want note'].forEach(function (k) {
        var v = String(get(k) == null ? '' : get(k)).replace(/\r/g, '').trim(); if (v) b[{ 'lent to': 'lentTo', 'format': 'format', 'translator': 'translator', 'second title': 'titleAlt', 'notes': 'notes', 'want note': 'wantNote' }[k]] = v;
      });
      var qraw = String(get('quotes') == null ? '' : get('quotes')).replace(/\r/g, '').trim();
      if (qraw) b.quotes = qraw.split(/\s*\|\|\s*/).filter(Boolean).map(function (s) { var m = /^([\s\S]*?)\s*\(p\.\s*([^)]+)\)$/.exec(s); return m ? { text: m[1].trim(), page: m[2].trim() } : { text: s.trim(), page: '' }; });
      // which cells were really filled in (blank cells must never overwrite what the library already has)
      b._has = {
        status: !!(stat || clean(get('date read', 'last date read', 'dates read'))), reads: finishes.length > 0, rating: !!rtRaw, review: !!clean(get('my review', 'review')),
        feelings: moods.length > 0, tags: b.tags.length > 0, year: y != null, pages: pg != null && pg > 0, publisher: !!clean(get('publisher')), isbn: !!b.isbn,
        series: !!sr || !!st.series, genre: !!gtext, favourite: fv !== '', lentTo: !!b.lentTo, format: !!b.format, translator: !!b.translator, titleAlt: !!b.titleAlt, notes: !!b.notes, wantNote: !!b.wantNote, quotes: !!(b.quotes && b.quotes.length), author: !!b.author
      };
      books.push(b);
    }
    return { source: source, books: books, skipped: skipped };
  }

  // ---- export: the library's own columns, the same ones the importer reads and the template shows ----
  var COLS = ['Title', 'Author', 'Status', 'Rating', 'Date Read', 'Feelings', 'Review', 'Genre', 'Series', 'Series No', 'Year', 'Publisher', 'Pages', 'ISBN', 'Tags', 'Favourite', 'Lent To', 'Format', 'Translator', 'Second Title', 'Want Note', 'Notes', 'Quotes'];
  function q(v) {
    v = v == null ? '' : String(v);
    return /[",\r\n]|^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function statusWord(b) {
    var fe = b.feelings || [];
    if (b.status === 'reading') return b.pausedAt ? 'put aside' : 'reading';
    if (b.status === 'want') return 'want to read';
    return fe.indexOf('Did not finish') >= 0 ? 'did not finish' : 'read';
  }
  function toCSV(books) {
    var lines = [COLS.join(',')];
    (books || []).forEach(function (b) {
      if (!b) return;
      var finishes = (b.reads || []).map(function (r) { return r && r.finish; }).filter(Boolean);
      if (!finishes.length && b.dateRead) finishes = [b.dateRead];
      var feel = (b.feelings || []).filter(function (f) { return f !== 'Did not finish'; }).join('; ');
      var quotes = (b.quotes || []).filter(function (x) { return x && String(x.text || '').trim(); }).map(function (x) { return String(x.text).trim() + (x.page ? ' (p. ' + x.page + ')' : ''); }).join(' || ');
      lines.push([
        b.title, b.author, statusWord(b), b.rating == null ? '' : b.rating, finishes.join('; '), feel, b.review, b.genre, b.series, b.seriesNo == null ? '' : b.seriesNo,
        b.year == null ? '' : b.year, b.publisher, b.pages || '', b.isbn, (b.tags || []).join(', '), b.favourite ? 'yes' : '', b.lentTo, b.format, b.translator, b.titleAlt, b.wantNote, b.notes, quotes
      ].map(q).join(','));
    });
    return lines.join('\n') + '\n';
  }

  w.LibraryCSV = { parse: parse, toCSV: toCSV, rows: rows, COLS: COLS };
})(typeof window !== 'undefined' ? window : globalThis);
