(function () {
  'use strict';
  var CHORDS = [
    'Ctrl+W', 'Ctrl+N', 'Ctrl+T', 'Ctrl+Shift+T', 'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+R', 'F5',
    'Ctrl+P', 'Ctrl+F', 'Ctrl+L', 'Ctrl+J', 'Ctrl+H', 'Ctrl+O', 'Ctrl+B', 'Ctrl+G', 'Ctrl+D',
    'Ctrl+U', 'Ctrl+Shift+V', 'F11', 'Alt+ArrowLeft',
    'Ctrl+Shift+N', 'Ctrl+Shift+W', 'Ctrl+PageDown', 'F12', 'Ctrl+Shift+I', 'Ctrl+Shift+S',
    'Ctrl+Shift+E', 'Ctrl+Shift+Y', 'Ctrl+Shift+M', 'Ctrl+Shift+O', 'Ctrl+K', 'Ctrl+E',
    'Alt+B', 'Alt+F', 'Alt+V', 'Ctrl+Z', 'Ctrl+S', 'Ctrl+Q', 'Alt+Space', 'F10', 'Alt+F4'
  ];
  var sid = String(Date.now());
  var session = {};
  try { session = JSON.parse(sessionStorage.getItem('skydeck-check') || '{}'); } catch (e) {}
  session.loads = (session.loads || 0) + 1;
  try { sessionStorage.setItem('skydeck-check', JSON.stringify(session)); } catch (e) {}

  function $(id) { return document.getElementById(id); }
  function logLine(s) {
    var d = $('log'); d.textContent = new Date().toISOString().slice(11, 23) + ' ' + s + '\n' + d.textContent;
  }
  function post(entry) {
    entry.sid = sid; entry.ua = navigator.userAgent;
    try {
      fetch('/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(entry), keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  function name(ev) {
    var p = [];
    if (ev.ctrlKey) p.push('Ctrl');
    if (ev.shiftKey) p.push('Shift');
    if (ev.altKey) p.push('Alt');
    if (ev.metaKey) p.push('Meta');
    var k = ev.key === ' ' ? 'Space' : ev.key;
    if (k.length === 1) k = k.toUpperCase();
    if (['Control', 'Shift', 'Alt', 'Meta'].indexOf(ev.key) < 0) p.push(k);
    return p.join('+');
  }

  $('secure').textContent = String(window.isSecureContext);
  $('origin').textContent = location.origin;
  $('mode').textContent = ['standalone', 'minimal-ui', 'fullscreen', 'browser'].filter(function (m) {
    return matchMedia('(display-mode: ' + m + ')').matches;
  })[0] || '?';
  $('loads').textContent = String(session.loads) + (session.loads > 1 ? '  (reloaded!)' : '');
  $('ua').textContent = (navigator.userAgent.match(/(Edg|Chrome|Electron)\/[\d.]+/g) || []).join(' ');

  var grid = $('chords');
  var cards = {};
  CHORDS.forEach(function (c) {
    var d = document.createElement('div'); d.className = 'chord'; d.textContent = c;
    var s = document.createElement('small'); s.textContent = 'not pressed'; d.appendChild(s);
    grid.appendChild(d); cards[c] = d;
  });
  $('bClear').onclick = function () {
    Object.keys(cards).forEach(function (c) { cards[c].className = 'chord'; cards[c].lastChild.textContent = 'not pressed'; });
  };

  window.addEventListener('keydown', function (ev) {
    var n = name(ev);
    var pre = ev.defaultPrevented;
    ev.preventDefault();
    $('last').textContent = n + '  code=' + ev.code + '  key=' + JSON.stringify(ev.key) + (ev.repeat ? ' (repeat)' : '') +
      (ev.getModifierState && ev.getModifierState('AltGraph') ? ' AltGraph' : '');
    if (cards[n]) { cards[n].className = 'chord seen'; cards[n].lastChild.textContent = 'page got it'; }
    logLine('keydown ' + n);
    post({ kind: 'keydown', chord: n, code: ev.code, key: ev.key, ctrl: ev.ctrlKey, shift: ev.shiftKey, alt: ev.altKey, altgr: !!(ev.getModifierState && ev.getModifierState('AltGraph')), repeat: ev.repeat, preDefaultPrevented: pre });
  }, true);
  window.addEventListener('keyup', function (ev) { if (ev.key === 'Alt' || ev.key === 'F10') ev.preventDefault(); }, true);
  window.addEventListener('beforeunload', function () { post({ kind: 'beforeunload' }); });
  window.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });

  $('bNotif').onclick = function () {
    if (!('Notification' in window)) { logLine('Notification API missing'); return; }
    logLine('Notification.permission before: ' + Notification.permission);
    Notification.requestPermission().then(function (p) {
      logLine('permission: ' + p);
      post({ kind: 'notification-permission', value: p });
      if (p === 'granted') { new Notification('skydeck check', { body: 'toast from ' + location.origin }); }
    });
  };
  $('bClipW').onclick = function () {
    navigator.clipboard.writeText('skydeck-check ' + new Date().toISOString()).then(
      function () { logLine('clipboard write ok'); post({ kind: 'clip-write', ok: true }); },
      function (e) { logLine('clipboard write failed: ' + e); post({ kind: 'clip-write', ok: false, err: String(e) }); });
  };
  $('bClipR').onclick = function () {
    navigator.clipboard.readText().then(
      function (t) { logLine('clipboard read ok (' + t.length + ' chars)'); post({ kind: 'clip-read', ok: true, len: t.length }); },
      function (e) { logLine('clipboard read failed: ' + e); post({ kind: 'clip-read', ok: false, err: String(e) }); });
  };
  $('bKlock').onclick = function () {
    if (!navigator.keyboard || !navigator.keyboard.lock) { logLine('Keyboard Lock API missing'); post({ kind: 'klock', ok: false, err: 'missing' }); return; }
    navigator.keyboard.lock(['KeyW', 'KeyN', 'KeyT']).then(
      function () { logLine('keyboard.lock resolved (not in fullscreen)'); post({ kind: 'klock', ok: true }); },
      function (e) { logLine('keyboard.lock rejected: ' + e); post({ kind: 'klock', ok: false, err: String(e) }); });
  };

  var okCount = 0, failCount = 0, lastBoot = null, lastOk = Date.now();
  function ping() {
    var t0 = performance.now();
    fetch('/ping', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (j) {
      okCount++; lastOk = Date.now();
      $('ping').className = ''; $('ping').textContent = 'ping ok ' + Math.round(performance.now() - t0) + ' ms  (ok ' + okCount + ', failed ' + failCount + ')';
      $('boot').textContent = j.boot_id.slice(0, 8); $('up').textContent = Math.round(j.uptime_s) + ' s';
      if (lastBoot && lastBoot !== j.boot_id) { logLine('BOOT ID CHANGED: WSL restarted'); post({ kind: 'boot-changed', from: lastBoot, to: j.boot_id }); }
      lastBoot = j.boot_id;
    }).catch(function (e) {
      failCount++;
      $('ping').className = 'bad'; $('ping').textContent = 'ping FAILED for ' + Math.round((Date.now() - lastOk) / 1000) + ' s (ok ' + okCount + ', failed ' + failCount + ')';
    });
  }
  setInterval(ping, 1000); ping();
  post({ kind: 'load', secure: window.isSecureContext, mode: $('mode').textContent, loads: session.loads, dpr: window.devicePixelRatio, platform: navigator.platform, lang: navigator.language });
})();
