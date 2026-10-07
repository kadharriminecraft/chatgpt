/* ============================================================
   Superwork 5.0 — Cloudflare Worker (pure API proxy, no build deps)
   ------------------------------------------------------------
   Deploy:  npx wrangler deploy     (or paste into the dashboard)

   This worker serves NO pages of its own. It is a pure JSON/API
   backend for the standalone single-file client (index.html kept
   on your phone / computer, opened from file:// or anywhere).

   v5: the client renders every page with fetch() + sandboxed
   iframe srcdoc — NO navigation requests ever hit this worker.
   All rewritten URLs are therefore ABSOLUTE (origin-prefixed).

   API surface:
     • GET  /               → status JSON (connectivity check)
     • /service/<b64url>    → proxied + rewritten web content
                              (HTML/CSS/JS rewriting, cookies,
                              redirects, recovery router)
     • POST /jar            → cookie-jar + settings sync
                              (text/plain body, no CORS preflight)
     • /ws/<b64url>         → WebSocket tunnel
     • OPTIONS *            → CORS preflight (file:// origin is
                              null, so everything answers ACAO:*)
   ============================================================ */

/* ===== embedded asset (injected by build script) ===== */
const HOOK_JS = "/* ============================================================\n   Superwork 5.0 — Runtime Hook (injected into every proxied\n   page BEFORE any site script runs).\n   ------------------------------------------------------------\n   v5 \"zero navigation\" mode: the page lives in a sandboxed\n   srcdoc iframe. The browser must NEVER navigate this frame —\n   network filters block navigation requests while allowing\n   API requests. Therefore every navigation surface (link\n   clicks, form submits, location writes, window.open, meta\n   refresh, history) is intercepted and relayed to the parent\n   app, which fetches the document through the worker and\n   swaps the srcdoc.\n\n   Every patch is individually defensive: a failure must never\n   break the page.\n   ============================================================ */\n(function () {\n  'use strict';\n  if (window.__SW_HOOKED) return;\n  try { window.__SW_HOOKED = 1; } catch (e) { return; }\n\n  var CFG = {};\n  try { CFG = window.__SWCFG || {}; } catch (e) { }\n  var PREFIX = '/service/';\n\n  /* worker origin — pages are srcdoc documents (about:srcdoc),\n     so every service URL we build must be ABSOLUTE. */\n  var WO = '';\n  try {\n    WO = CFG.worker || '';\n    if (!WO && location.origin && location.origin !== 'null' && location.origin.indexOf('http') === 0) WO = location.origin;\n  } catch (e) { }\n\n  /* ---------- codec ---------- */\n  function b64e(str) {\n    try {\n      var bytes = new TextEncoder().encode(str), bin = '';\n      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);\n      return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');\n    } catch (e) { return ''; }\n  }\n  function b64d(str) {\n    try {\n      var s = String(str).replace(/-/g, '+').replace(/_/g, '/');\n      while (s.length % 4) s += '=';\n      var bin = atob(s), bytes = new Uint8Array(bin.length);\n      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n      return new TextDecoder().decode(bytes);\n    } catch (e) { return ''; }\n  }\n  var SKIP = /^(data:|blob:|javascript:|about:|mailto:|tel:|sms:|magnet:|intent:|market:|superwork:)/i;\n\n  function decService() {\n    /* srcdoc documents have no /service/ path — the truth is CFG.url */\n    try {\n      if (WO && location.href.indexOf('about:') !== 0) {\n        var p = new URL(location.href);\n        if (p.pathname.indexOf(PREFIX) === 0) {\n          var d = b64d(p.pathname.slice(PREFIX.length));\n          if (/^https?:\\/\\//i.test(d)) return d;\n        }\n      }\n    } catch (e) { }\n    return CFG.url || location.href;\n  }\n  function cur() { return decService(); }\n  function setCur(u) { try { CFG.url = u; } catch (e) { } }\n  function isProxied(u) {\n    if (typeof u !== 'string') return false;\n    return u.indexOf(PREFIX) === 0 || (WO && u.indexOf(WO + PREFIX) === 0);\n  }\n  function rw(u) {\n    if (u == null) return u;\n    u = String(u);\n    if (!u || isProxied(u) || SKIP.test(u)) return u;\n    try {\n      var abs = new URL(u, cur());\n      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;\n      if (abs.pathname.indexOf(PREFIX) === 0) return u;\n      return (WO || '') + PREFIX + b64e(abs.href);\n    } catch (e) { return u; }\n  }\n  /* srcset candidate list: \"a.png 1x, b.png 2x\" — each URL\n     rewritten, descriptors preserved (v7) */\n  function rwSrcset(v) {\n    return String(v == null ? '' : v).split(/,\\s*/).map(function (p) {\n      if (!p || /^\\s*data:/i.test(p)) return p;\n      var sp = p.trim().split(/\\s+/);\n      if (!sp[0]) return p;\n      sp[0] = rw(sp[0]);\n      return sp.join(' ');\n    }).join(', ');\n  }\n  function unrwSrcset(v) {\n    return String(v == null ? '' : v).split(/,\\s*/).map(function (p) {\n      if (!p || /^\\s*data:/i.test(p)) return p;\n      var sp = p.trim().split(/\\s+/);\n      if (sp[0]) sp[0] = unrw(sp[0]);\n      return sp.join(' ');\n    }).join(', ');\n  }\n  /* inline-CSS url()/…-image-set() rewriter used for style attrs,\n     runtime-inserted rules and <style> text (v7) */\n  function rwCssLite(css) {\n    return String(css)\n      .replace(/url\\(\\s*(['\"]?)([^'\")]+)\\1\\s*\\)/gi, function (m, q, u) {\n        if (/^(data:|blob:|#)/i.test(u)) return m;\n        var r = rw(u);\n        return r === u ? m : 'url(' + q + r + q + ')';\n      })\n      .replace(/(?:-webkit-)?image-set\\(\\s*([^)]*)\\)/gi, function (m, inner) {\n        var r = inner.replace(/(['\"]?)([^'\"\\s,]+)\\1(\\s+[\\d.]+[wx])/g, function (mm, q2, u, d) {\n          var rr = rw(u);\n          return rr === u ? mm : q2 + rr + q2 + d;\n        });\n        return r === inner ? m : m.replace(inner, r);\n      });\n  }\n  function unrw(u) {\n    if (typeof u !== 'string') return u;\n    try {\n      var p = new URL(u, cur());\n      if (p.pathname.indexOf(PREFIX) === 0) {\n        var d = b64d(p.pathname.slice(PREFIX.length));\n        if (/^https?:\\/\\//i.test(d)) return d;\n      }\n    } catch (e) { }\n    return u;\n  }\n  /* resolve any value to an absolute REAL (unproxied) http(s) URL */\n  function realUrlOf(v) {\n    try {\n      var s = unrw(String(v));\n      if (!s || SKIP.test(s)) return null;\n      var abs = new URL(s, cur());\n      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;\n      return abs.href;\n    } catch (e) { return null; }\n  }\n\n  /* ---------- messaging ---------- */\n  var REAL_PARENT = null;\n  try { REAL_PARENT = window.parent; } catch (e) { }\n  var IS_TOP = true;\n  try { IS_TOP = (window.top === window.self); } catch (e) { IS_TOP = true; }\n\n  function tellParent(msg) {\n    try {\n      msg.__sw = 1;\n      (REAL_PARENT || parent).postMessage(msg, '*');\n    } catch (e) { }\n  }\n  /* v8.1: postMessage with a TRANSFER list — moves ArrayBuffers between\n     contexts at zero copy (blob payloads for bridged workers; a 31MB wasm\n     as base64 text wedges the renderer, a transfer does not) */\n  function tellParentT(msg, transfer) {\n    try {\n      msg.__sw = 1;\n      (REAL_PARENT || parent).postMessage(msg, '*', transfer || []);\n    } catch (e) {\n      try { (REAL_PARENT || parent).postMessage(msg, '*'); } catch (e2) { }\n    }\n  }\n  function vState() {\n    try { return { back: VH.idx > 0, fwd: VH.idx < VH.stack.length - 1 }; } catch (e) { return {}; }\n  }\n  function tellNav(extra) {\n    try {\n      var st = vState();\n      var m = { type: 'nav', url: cur(), title: document.title, canBack: !!st.back, canFwd: !!st.fwd };\n      if (extra) for (var k in extra) m[k] = extra[k];\n      tellParent(m);\n    } catch (e) { }\n  }\n\n  /* ============================================================\n     Virtual history — srcdoc documents cannot pushState foreign\n     URLs (opaque origin throws), and the frame must never\n     navigate. History is emulated in JS; crossing a page-load\n     boundary defers to the app's per-tab stack via histBack /\n     histFwd messages.\n     ============================================================ */\n  var VH = { stack: [cur()], states: [null], idx: 0 };\n  function vSetCurrent(u) {\n    setCur(u);\n    try { VH.stack[VH.idx] = u; } catch (e) { }\n  }\n  function firePop() {\n    try { dispatchEvent(new PopStateEvent('popstate', { state: VH.states[VH.idx] })); }\n    catch (e) { try { dispatchEvent(new Event('popstate')); } catch (e2) { } }\n    setTimeout(tellNav, 0);\n  }\n  function fireHash(oldU, newU) {\n    try { dispatchEvent(new HashChangeEvent('hashchange', { oldURL: oldU, newURL: newU })); }\n    catch (e) { try { dispatchEvent(new Event('hashchange')); } catch (e2) { } }\n  }\n  function vPush(st, u) {\n    try {\n      VH.stack = VH.stack.slice(0, VH.idx + 1);\n      VH.states = VH.states.slice(0, VH.idx + 1);\n      VH.stack.push(u); VH.states.push(st === undefined ? null : st);\n      VH.idx = VH.stack.length - 1;\n      setCur(u);\n    } catch (e) { }\n  }\n  function vReplace(st, u) {\n    try {\n      VH.stack[VH.idx] = u;\n      VH.states[VH.idx] = st === undefined ? null : st;\n      setCur(u);\n    } catch (e) { }\n  }\n  function vGo(d) {\n    try {\n      if (!d) return;\n      var ni = VH.idx + d;\n      if (ni < 0) { tellParent({ type: 'histBack' }); return; }\n      if (ni >= VH.stack.length) { tellParent({ type: 'histFwd' }); return; }\n      var oldHash = '', newHash = '';\n      try { oldHash = new URL(cur()).hash; newHash = new URL(VH.stack[ni]).hash; } catch (e) { }\n      VH.idx = ni;\n      setCur(VH.stack[VH.idx]);\n      firePop();\n      if (oldHash !== newHash) fireHash(VH.stack[ni], cur());\n    } catch (e) { }\n  }\n\n  /* ============================================================\n     Navigation relay — every load goes through the app's\n     fetch + srcdoc pipeline.\n     ============================================================ */\n  function navParent(url, replace) {\n    tellParent({ type: 'navigate', url: url, replace: !!replace });\n  }\n\n  /* ============================================================\n     __swloc — full location shim backed by the VIRTUAL url\n     ============================================================ */\n  var __swloc = (function () {\n    function U() { return new URL(cur()); }\n    function go(v, replace) {\n      var u = realUrlOf(v);\n      if (u) { navParent(u, replace); return; }\n      /* unresolvable (mailto:, javascript:, …) — let the browser try */\n      try { if (replace) location.replace(v); else location.href = v; } catch (e) { }\n    }\n    var loc = {\n      toString: function () { return cur(); },\n      valueOf: function () { return cur(); },\n      assign: function (v) { go(v, false); },\n      replace: function (v) { go(v, true); },\n      reload: function () { tellParent({ type: 'reloadRequest' }); }\n    };\n    function def(name, setHook) {\n      try {\n        Object.defineProperty(loc, name, {\n          get: function () { try { return U()[name]; } catch (e) { return ''; } },\n          set: function (v) {\n            try {\n              if (name === 'hash') { setHash(v); return; }\n              if (name === 'href') {\n                /* href accepts RELATIVE values — the URL.href setter\n                   does not (it throws), so resolve via the\n                   constructor with the page URL as base */\n                var abs = new URL(String(v), cur());\n                go(abs.href, false);\n                if (setHook) setHook(v);\n                return;\n              }\n              var u = U();\n              try { u[name] = v; } catch (e2) { u = new URL(String(v), cur()); }\n              go(u.href, false);\n              if (setHook) setHook(v);\n            } catch (e) { }\n          },\n          configurable: true\n        });\n      } catch (e) { }\n    }\n    ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search'].forEach(function (n) { def(n); });\n    try {\n      Object.defineProperty(loc, 'hash', {\n        get: function () { try { return U().hash; } catch (e) { return ''; } },\n        set: function (v) { setHash(v); },\n        configurable: true\n      });\n      Object.defineProperty(loc, 'origin', {\n        get: function () { try { return U().origin; } catch (e) { return ''; } },\n        configurable: true\n      });\n      Object.defineProperty(loc, 'ancestorOrigins', {\n        get: function () { return []; },\n        configurable: true\n      });\n    } catch (e) { }\n    return loc;\n  })();\n\n  function setHash(v) {\n    try {\n      var s = String(v);\n      if (s.charAt(0) !== '#') s = '#' + s;\n      var u = new URL(cur());\n      var old = u.href;\n      u.hash = s;\n      vSetCurrent(u.href);\n      try {\n        var id = decodeURIComponent(s.slice(1));\n        var el = document.getElementById(id) || document.getElementsByName(id)[0];\n        if (el) el.scrollIntoView();\n      } catch (e) { }\n      if (old !== u.href) fireHash(old, u.href);\n      setTimeout(tellNav, 0);\n    } catch (e) { }\n  }\n\n  /* ---------- __swdoc ---------- */\n  var __swdoc = {};\n  try {\n    Object.defineProperty(__swdoc, 'domain', {\n      get: function () { try { return new URL(cur()).hostname; } catch (e) { return ''; } },\n      set: function () { /* no-op — document.domain is obsolete */ },\n      configurable: true\n    });\n  } catch (e) { }\n\n  /* expose globals early (inline handlers + rewritten code rely on them) */\n  try { window.__swloc = __swloc; window.__swdoc = __swdoc; } catch (e) { }\n\n  /* v7: __swDest — destructuring like `const {top: o, self: t} = window`\n     reads the REAL (cross-origin) window.top — no text rewriter or\n     property shim can catch a destructured binding (window.top is\n     unforgeable). rewriteJs rewrites `…} = window` into `…} = __swDest()`\n     when the pattern names top/parent; this object shadows them with\n     self while every other key still resolves through the real window. */\n  try {\n    window.__swDest = function () {\n      var w = Object.create(window);\n      /* defineProperty, NOT assignment: window.top/parent/self/window/\n         frames/location are unforgeable accessors on the prototype —\n         a plain `w.top = …` silently no-ops (no setter, strict mode)\n         and a later read falls through to the unforgeable getter with\n         the wrong receiver → \"Illegal invocation\". Shadow ALL of the\n         identity props, not just top/parent. */\n      ['top', 'parent', 'self', 'window', 'frames'].forEach(function (k) {\n        try { Object.defineProperty(w, k, { value: window.self, writable: true, configurable: true }); } catch (e) { }\n      });\n      try { Object.defineProperty(w, 'location', { value: __swloc, writable: true, configurable: true }); } catch (e) { }\n      return w;\n    };\n  } catch (e) { }\n\n  /* v8: __swlocParts — `const {pathname, href} = location` (or\n     window.location) destructures the REAL about:srcdoc location\n     because no dot-suffix rewriter can catch a binding. The values\n     then leak into routers (Next.js pushed '/srcdoc' as the URL and\n     wedged its whole client tree in a Loading state). rewriteJs\n     rewrites such destructuring to __swlocParts(), which yields a\n     plain object carrying the REAL page URL parts. */\n  try {\n    window.__swlocParts = function () {\n      var u = null;\n      try { u = new URL(cur()); } catch (e) { }\n      var parts = {\n        href: u ? u.href : cur(), protocol: u ? u.protocol : '',\n        host: u ? u.host : '', hostname: u ? u.hostname : '', port: u ? u.port : '',\n        pathname: u ? u.pathname : '', search: u ? u.search : '', hash: u ? u.hash : '',\n        origin: u ? u.origin : '', ancestorOrigins: []\n      };\n      parts.toString = function () { return parts.href; };\n      parts.assign = function (v) { __swloc.assign(v); };\n      parts.replace = function (v) { __swloc.replace(v); };\n      parts.reload = function () { __swloc.reload(); };\n      return parts;\n    };\n  } catch (e) { }\n\n  /* ---------- document.location / window.location shims ---------- */\n  try {\n    Object.defineProperty(document, 'location', {\n      get: function () { return __swloc; },\n      set: function (v) { __swloc.href = v; },\n      configurable: true\n    });\n  } catch (e) { }\n\n  /* ---------- document URL surfaces ---------- */\n  try {\n    Object.defineProperty(document, 'URL', { get: function () { return cur(); }, configurable: true });\n  } catch (e) { }\n  try {\n    Object.defineProperty(document, 'baseURI', { get: function () { return cur(); }, configurable: true });\n  } catch (e) { }\n  try {\n    Object.defineProperty(document, 'referrer', { get: function () { return CFG.referrer || ''; }, configurable: true });\n  } catch (e) { }\n\n  /* ============================================================\n     Frame identity protection — inside the app UI the page must\n     believe (and be) its own top frame; popups keep real refs.\n     ============================================================ */\n  if (!IS_TOP) {\n    try { Object.defineProperty(window, 'top', { get: function () { return window.self; }, configurable: true }); } catch (e) { }\n    try { Object.defineProperty(window, 'parent', { get: function () { return window.self; }, configurable: true }); } catch (e) { }\n  }\n\n  /* ============================================================\n     fetch\n     ============================================================ */\n  try {\n    var __fetch = window.fetch;\n    function wrapFetch(input, init) {\n      try {\n        init = init || {};\n        var url;\n        if (typeof input === 'string') {\n          url = rw(input);\n        } else if (input && typeof input.url === 'string') {\n          if (isProxied(input.url)) { url = input; }\n          else {\n            var ni = { method: input.method, headers: input.headers, body: input.body, mode: input.mode,\n              credentials: input.credentials, cache: input.cache, redirect: input.redirect,\n              referrer: input.referrer, integrity: input.integrity, keepalive: input.keepalive,\n              signal: input.signal };\n            if (input.method === 'GET' || input.method === 'HEAD') delete ni.body;\n            try { input = new Request(rw(input.url), ni); } catch (e2) { /* fall through */ }\n            url = input;\n          }\n        } else if (input && typeof input.href === 'string') {\n          /* URL OBJECT input — Next.js 15+ router prefetch passes\n             new URL(href, location) with RSC headers; unhandled it\n             went DIRECT to the site (cross-origin preflight from the\n             sandbox → blocked). Rewrite via href like a string. */\n          url = rw(input.href);\n        }\n        try { delete init.referrerPolicy; } catch (e) { }\n        return __fetch.call(window, url === undefined ? input : url, init);\n      } catch (e) {\n        return __fetch.apply(window, arguments);\n      }\n    }\n    window.fetch = wrapFetch;\n  } catch (e) { }\n\n  /* ============================================================\n     Request constructor — `new Request('/relative')` resolves\n     against the REAL base (about:srcdoc's inherited file:// base)\n     and produces a broken URL before fetch ever sees it. Rewrite\n     at construction time so request-building code (Apple, React\n     data loaders, …) gets proxied URLs from the start. (v7)\n     ============================================================ */\n  try {\n    var __Request = window.Request;\n    if (__Request) {\n      window.Request = function (input, init) {\n        try {\n          if (typeof input === 'string') {\n            var r = rw(input);\n            if (r !== input) return new __Request(r, init);\n          } else if (input && typeof input.href === 'string' && !input.url) {\n            /* URL-object input (no .url → not a Request) — same gap\n               as fetch(): rewrite via href */\n            var r2 = rw(input.href);\n            if (r2 !== input.href) return new __Request(r2, init);\n          }\n        } catch (e) { }\n        return new __Request(input, init);\n      };\n      window.Request.prototype = __Request.prototype;\n      try { Object.defineProperty(window.Request, 'name', { value: 'Request' }); } catch (e3) { }\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     XMLHttpRequest\n     ============================================================ */\n  try {\n    var __open = XMLHttpRequest.prototype.open;\n    XMLHttpRequest.prototype.open = function (method, url) {\n      try {\n        arguments[1] = rw(String(url));\n      } catch (e) { }\n      return __open.apply(this, arguments);\n    };\n    var __ru = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseURL');\n    if (__ru && __ru.get) {\n      try {\n        Object.defineProperty(XMLHttpRequest.prototype, 'responseURL', {\n          get: function () { return unrw(__ru.get.call(this)); },\n          configurable: true\n        });\n      } catch (e) { }\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     WebSocket / EventSource\n     ============================================================ */\n  try {\n    var __WS = window.WebSocket;\n    function wsBase() {\n      if (WO) return WO.replace(/^http/i, 'ws');\n      try {\n        return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;\n      } catch (e) { return 'wss://'; }\n    }\n    function wsUrl(u) {\n      try {\n        var abs = new URL(String(u), cur());\n        if (abs.protocol !== 'ws:' && abs.protocol !== 'wss:') return u;\n        var target = (abs.protocol === 'ws:' ? 'http://' : 'https://') + abs.host + abs.pathname + abs.search;\n        return wsBase() + '/ws/' + b64e(target);\n      } catch (e) { return u; }\n    }\n    window.WebSocket = function (u, protocols) {\n      return protocols === undefined ? new __WS(wsUrl(u)) : new __WS(wsUrl(u), protocols);\n    };\n    window.WebSocket.prototype = __WS.prototype;\n    try {\n      Object.defineProperty(window.WebSocket, 'CONNECTING', { get: function () { return __WS.CONNECTING; } });\n      Object.defineProperty(window.WebSocket, 'OPEN', { get: function () { return __WS.OPEN; } });\n      Object.defineProperty(window.WebSocket, 'CLOSING', { get: function () { return __WS.CLOSING; } });\n      Object.defineProperty(window.WebSocket, 'CLOSED', { get: function () { return __WS.CLOSED; } });\n    } catch (e) { }\n    var __wsUrl = Object.getOwnPropertyDescriptor(__WS.prototype, 'url');\n    if (__wsUrl && __wsUrl.get) {\n      try {\n        Object.defineProperty(__WS.prototype, 'url', {\n          get: function () {\n            var v = __wsUrl.get.call(this);\n            try {\n              var p = new URL(v);\n              if (p.pathname.indexOf('/ws/') === 0) return b64d(p.pathname.slice(4));\n            } catch (e) { }\n            return v;\n          },\n          configurable: true\n        });\n      } catch (e) { }\n    }\n  } catch (e) { }\n\n  try {\n    var __ES = window.EventSource;\n    if (__ES) {\n      window.EventSource = function (u, cfg) {\n        return cfg === undefined ? new __ES(rw(u)) : new __ES(rw(u), cfg);\n      };\n      window.EventSource.prototype = __ES.prototype;\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     Dedicated Workers + SharedWorkers — v8 APP-RELAYED workers.\n     A sandboxed srcdoc frame has an OPAQUE origin: EVERY direct\n     `new Worker(url)` throws (\"cannot be accessed from origin\n     'null'\") no matter what URL is passed. Sites that spawn workers\n     (Comlink/ffmpeg wrappers, zip packagers, analytics offloads)\n     die at that line. Instead: return a fully evented FAKE worker\n     and ask the app to construct a REAL data:-URL worker in its own\n     context (see app makeWorker — data: workers work from file://\n     for both classic and module types). Messages, errors and\n     terminate are bridged both ways; the fake passes\n     `instanceof Worker` and supports onmessage / addEventListener /\n     postMessage / terminate / onerror / onmessageerror.\n     ============================================================ */\n  var WORKERS = {};\n  var WSEQ = 0;\n  function swEvt(t, d) {\n    try {\n      if (t === 'error') return new ErrorEvent('error', {\n        message: (d && d.message) || 'Worker error',\n        filename: (d && d.filename) || '', lineno: (d && d.lineno) || 0\n      });\n      return new MessageEvent(t, { data: d });\n    } catch (e) {\n      try { return new Event(t); } catch (e2) { return { type: t }; }\n    }\n  }\n  try {\n    var __Worker = window.Worker;\n    if (__Worker) {\n      function SWWorker(id) {\n        this._id = id;\n        this._lsn = {};\n        /* own data properties SHADOW the prototype's IDL accessors —\n           Worker.prototype.onmessage/onerror/onmessageerror are native\n           accessors with brand checks, and assigning through them on a\n           non-Worker `this` throws \"Illegal invocation\" */\n        Object.defineProperty(this, 'onmessage', { value: null, writable: true, configurable: true });\n        Object.defineProperty(this, 'onerror', { value: null, writable: true, configurable: true });\n        Object.defineProperty(this, 'onmessageerror', { value: null, writable: true, configurable: true });\n      }\n      SWWorker.prototype = Object.create(__Worker.prototype);\n      SWWorker.prototype.constructor = SWWorker;\n      SWWorker.prototype.postMessage = function (d) {\n        /* v8.1: blob: URLs in the payload are swapped for data: URLs\n           (held until converted) — the bridged worker cannot fetch\n           this frame's blob URLs */\n        try { swTellParentBlobSafe({ type: 'workerMsg', id: this._id, data: d }); } catch (e) { }\n      };\n      SWWorker.prototype.terminate = function () {\n        try { tellParent({ type: 'workerTerminate', id: this._id }); } catch (e) { }\n      };\n      SWWorker.prototype.addEventListener = function (t, fn) {\n        if (typeof fn === 'function') { (this._lsn[t] = this._lsn[t] || []).push(fn); }\n      };\n      SWWorker.prototype.removeEventListener = function (t, fn) {\n        var a = this._lsn[t] || [];\n        this._lsn[t] = a.filter(function (f) { return f !== fn; });\n      };\n      SWWorker.prototype.dispatchEvent = function (ev) {\n        var got = false, h = this['on' + ev.type];\n        if (typeof h === 'function') { try { h(ev); got = true; } catch (e) { } }\n        var a = this._lsn[ev.type] || [];\n        for (var i = 0; i < a.length; i++) { try { a[i](ev); got = true; } catch (e) { } }\n        return got;\n      };\n      SWWorker.prototype._swfire = function (kind, data) {\n        try { this.dispatchEvent(swEvt(kind, data)); } catch (e) { }\n      };\n      window.Worker = function (u, opts) {\n        var id = 'w' + (++WSEQ);\n        var fu = '';\n        try {\n          var s = (u == null) ? '' : String((u && u.href) || u);\n          fu = rw(s);\n        } catch (e) { }\n        var fw = new SWWorker(id);\n        WORKERS[id] = fw;\n        tellParent({\n          type: 'makeWorker', id: id, url: fu,\n          module: !!(opts && String(opts.type || '').toLowerCase() === 'module'),\n          name: (opts && opts.name) || ''\n        });\n        return fw;\n      };\n      try { Object.defineProperty(window.Worker, 'name', { value: 'Worker' }); } catch (e4) { }\n    }\n  } catch (e) { }\n\n  /* SharedWorker — same bridge, MessagePort-shaped surface (single\n     port; cross-tab sharing is not possible from the sandbox) */\n  try {\n    var __SW = window.SharedWorker;\n    if (__SW) {\n      function SWPort(id) {\n        this._id = id;\n        this._lsn = {};\n        Object.defineProperty(this, 'onmessage', { value: null, writable: true, configurable: true });\n      }\n      SWPort.prototype.postMessage = function (d) {\n        try { swTellParentBlobSafe({ type: 'workerMsg', id: this._id, data: d }); } catch (e) { }\n      };\n      SWPort.prototype.start = function () { };\n      SWPort.prototype.close = function () {\n        try { tellParent({ type: 'workerTerminate', id: this._id }); } catch (e) { }\n      };\n      SWPort.prototype.addEventListener = function (t, fn) {\n        if (typeof fn === 'function') { (this._lsn[t] = this._lsn[t] || []).push(fn); }\n      };\n      SWPort.prototype.removeEventListener = function (t, fn) {\n        var a = this._lsn[t] || [];\n        this._lsn[t] = a.filter(function (f) { return f !== fn; });\n      };\n      SWPort.prototype.dispatchEvent = function (ev) {\n        var got = false, h = this['on' + ev.type];\n        if (typeof h === 'function') { try { h(ev); got = true; } catch (e) { } }\n        var a = this._lsn[ev.type] || [];\n        for (var i = 0; i < a.length; i++) { try { a[i](ev); got = true; } catch (e) { } }\n        return got;\n      };\n      window.SharedWorker = function (u, opts) {\n        var id = 'w' + (++WSEQ);\n        var fu = '';\n        try { fu = rw(String((u && u.href) || u)); } catch (e) { }\n        var swk = this instanceof window.SharedWorker ? this : Object.create(window.SharedWorker.prototype);\n        var port = new SWPort(id);\n        /* `port` is a getter-only IDL accessor on the REAL prototype the\n           fake inherits from — a plain assignment throws \"has only a\n           getter\". An own value property shadows it cleanly. */\n        try {\n          Object.defineProperty(swk, 'port', { value: port, writable: false, configurable: true });\n        } catch (eP) { try { swk.port = port; } catch (eP2) { } }\n        Object.defineProperty(swk, 'onerror', { value: null, writable: true, configurable: true });\n        WORKERS[id] = {\n          _swfire: function (kind, data) {\n            if (kind === 'error') {\n              if (typeof swk.onerror === 'function') { try { swk.onerror(swEvt('error', data)); } catch (e) { } }\n            } else {\n              try { port.dispatchEvent(swEvt(kind, data)); } catch (e) { }\n            }\n          }\n        };\n        tellParent({ type: 'makeWorker', id: id, url: fu, module: !!(opts && String(opts.type || '').toLowerCase() === 'module'), shared: 1 });\n        return swk;\n      };\n      window.SharedWorker.prototype = Object.create(__SW.prototype);\n      window.SharedWorker.prototype.constructor = window.SharedWorker;\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     sendBeacon\n     ============================================================ */\n  try {\n    var __beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);\n    if (__beacon) {\n      navigator.sendBeacon = function (u, data) {\n        try { return __fetch.call(window, rw(u), { method: 'POST', body: data, keepalive: true, credentials: 'omit' }).then(function () { return true; }, function () { return false; }), true; }\n        catch (e) { return __beacon(rw(u), data); }\n      };\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     history — virtual pushState / replaceState + patched\n     back / forward / go (relayed to the app at page boundaries)\n     ============================================================ */\n  try {\n    history.pushState = function (st, t, u) {\n      try {\n        var abs = (u != null && u !== '') ? realUrlOf(u) : null;\n        vPush(st, abs || cur());\n      } catch (e) { }\n      setTimeout(tellNav, 0);\n    };\n    history.replaceState = function (st, t, u) {\n      try {\n        var abs = (u != null && u !== '') ? realUrlOf(u) : null;\n        vReplace(st, abs || cur());\n      } catch (e) { }\n      setTimeout(tellNav, 0);\n    };\n    try { history.back = function () { vGo(-1); }; } catch (e) { }\n    try { history.forward = function () { vGo(1); }; } catch (e) { }\n    try { history.go = function (d) { vGo(Number(d) || 0); }; } catch (e) { }\n    try {\n      Object.defineProperty(History.prototype, 'state', {\n        get: function () { return VH.states[VH.idx]; },\n        configurable: true\n      });\n    } catch (e) { }\n    try {\n      Object.defineProperty(History.prototype, 'length', {\n        get: function () { return VH.stack.length; },\n        configurable: true\n      });\n    } catch (e) { }\n  } catch (e) { }\n\n  try {\n    addEventListener('popstate', function () { setTimeout(tellNav, 0); }, true);\n    addEventListener('hashchange', function () { setTimeout(tellNav, 0); }, true);\n  } catch (e) { }\n\n  /* ============================================================\n     document.cookie — JS-visible cookie emulation\n     ============================================================ */\n  var pageCookies = new Map(); // name → full set-cookie style string\n  try {\n    var __ck = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');\n    if (__ck) {\n      Object.defineProperty(Document.prototype, 'cookie', {\n        get: function () {\n          var mine = '';\n          try {\n            var arr = [];\n            pageCookies.forEach(function (v, k) {\n              var eq = v.indexOf('=');\n              arr.push(eq < 0 ? v : v.slice(0, eq) + '=' + (v.slice(eq + 1).split(';')[0]));\n            });\n            mine = arr.join('; ');\n          } catch (e) { }\n          var base = CFG.cookieStr || '';\n          if (!mine) return base;\n          if (!base) return mine;\n          /* page-set overrides jar snapshot by name */\n          var merged = {};\n          base.split('; ').forEach(function (p) {\n            var k = p.split('=')[0]; merged[k] = p;\n          });\n          mine.split('; ').forEach(function (p) {\n            var k = p.split('=')[0]; merged[k] = p;\n          });\n          return Object.keys(merged).map(function (k) { return merged[k]; }).join('; ');\n        },\n        set: function (v) {\n          try {\n            var s = String(v);\n            var name = s.split('=')[0].trim();\n            if (name) {\n              pageCookies.set(name, s);\n              /* the app UI persists the jar and re-syncs the worker */\n              tellParent({ type: 'setCookie', url: cur(), cookie: s });\n            }\n          } catch (e) { }\n        },\n        configurable: true\n      });\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     Storage namespacing (localStorage / sessionStorage).\n     Sandboxed srcdoc frames have NO real storage (access throws),\n     so: seed from CFG.store (relayed by the app via x-sw-store),\n     keep an in-memory copy, and mirror every write to the app,\n     which persists it under the same \"sw:<tag>:<origin>:\" keys.\n     ============================================================ */\n  function b64origin() {\n    try { return b64e(new URL(cur()).origin); } catch (e) { return 'x'; }\n  }\n  function getRealStorage(name) {\n    try {\n      var s = window[name];\n      if (s && typeof s.length === 'number') return s;\n    } catch (e) { }\n    return null;\n  }\n  function makeStorage(real, tag) {\n    var pre = 'sw:' + tag + ':' + b64origin() + ':';\n    var backing = {};\n    var hasReal = !!real;\n    /* seed: real storage first, then the app-relayed snapshot */\n    try {\n      if (hasReal) {\n        for (var i = 0; i < real.length; i++) {\n          var k = real.key(i);\n          if (k && k.indexOf(pre) === 0) backing[k.slice(pre.length)] = real.getItem(k);\n        }\n      }\n    } catch (e) { }\n    try {\n      var seed = CFG.store && CFG.store[tag];\n      if (seed && typeof seed === 'object') {\n        for (var sk in seed) backing[sk] = String(seed[sk]);\n      }\n    } catch (e) { }\n    function setReal(k, v) {\n      if (hasReal) {\n        try { real.setItem(pre + k, v); return; } catch (e2) { /* quota → fall through */ }\n        try {\n          var keys = [];\n          for (var i = 0; i < real.length; i++) {\n            var rk = real.key(i);\n            if (rk && rk.indexOf(pre) === 0) keys.push(rk);\n          }\n          if (keys.length) { real.removeItem(keys[0]); real.setItem(pre + k, v); }\n        } catch (e3) { }\n      }\n      tellParent({ type: 'swStore', tag: tag, origin: b64origin(), key: k, val: v });\n    }\n    var store = {\n      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null; },\n      setItem: function (k, v) { k = String(k); v = String(v); backing[k] = v; setReal(k, v); },\n      removeItem: function (k) {\n        k = String(k); delete backing[k];\n        if (hasReal) { try { real.removeItem(pre + k); } catch (e) { } }\n        else tellParent({ type: 'swStore', tag: tag, origin: b64origin(), key: k, val: null });\n      },\n      clear: function () {\n        Object.keys(backing).forEach(function (k) { try { if (hasReal) real.removeItem(pre + k); } catch (e) { } });\n        backing = {};\n        if (!hasReal) tellParent({ type: 'swClear', tag: tag, origin: b64origin() });\n      },\n      key: function (i) { var ks = Object.keys(backing); return i < ks.length ? ks[i] : null; }\n    };\n    /* v7: the proxy target must carry NO non-configurable own keys —\n       CNN/BBC's StorageService enumerates storage and Chrome enforces\n       the ownKeys invariant (\"trap result did not include 'length'\")\n       when a target property is missing from the trap result. Real\n       Storage keeps length + methods on the PROTOTYPE, so we serve\n       them from the get/has traps and keep only data keys as own\n       properties (Object.keys(localStorage) then behaves exactly\n       like the real thing). */\n    var METHOD_KEYS = { getItem: 1, setItem: 1, removeItem: 1, clear: 1, key: 1 };\n    return new Proxy({}, {\n      get: function (t, k) {\n        if (typeof k === 'symbol') return t[k];\n        if (METHOD_KEYS[k]) return store[k];\n        if (k === 'length') return Object.keys(backing).length;\n        if (k === 'constructor') return Object;\n        return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : undefined;\n      },\n      set: function (t, k, v) {\n        if (typeof k === 'string' && k !== 'length') { store.setItem(k, v); return true; }\n        if (k === 'length') return true; /* read-only, like real Storage */\n        return true;\n      },\n      deleteProperty: function (t, k) { if (typeof k === 'string' && k !== 'length') store.removeItem(k); return true; },\n      has: function (t, k) {\n        if (typeof k === 'symbol') return k in t;\n        return !!METHOD_KEYS[k] || k === 'length' ||\n          Object.prototype.hasOwnProperty.call(backing, k);\n      },\n      ownKeys: function () { return Object.keys(backing); },\n      getOwnPropertyDescriptor: function (t, k) {\n        if (typeof k === 'string' && Object.prototype.hasOwnProperty.call(backing, k)) {\n          return { value: backing[k], writable: true, enumerable: true, configurable: true };\n        }\n        return undefined;\n      }\n    });\n  }\n  try {\n    Object.defineProperty(window, 'localStorage', { value: makeStorage(getRealStorage('localStorage'), 'ls'), configurable: true });\n    Object.defineProperty(window, 'sessionStorage', { value: makeStorage(getRealStorage('sessionStorage'), 'ss'), configurable: true });\n  } catch (e) { }\n\n  /* ============================================================\n     indexedDB + caches namespacing\n     ============================================================ */\n  try {\n    var __idb = null;\n    try { __idb = window.indexedDB; if (__idb) __idb.open('sw_probe'); } catch (e1) { __idb = null; }\n    if (__idb) {\n      var pfx = 'sw_' + b64origin() + '_';\n      var idbProxy = new Proxy(__idb, {\n        get: function (t, k) {\n          if (k === 'open') return function (name) {\n            arguments[0] = pfx + name;\n            return t.open.apply(t, arguments);\n          };\n          if (k === 'deleteDatabase') return function (name) {\n            arguments[0] = pfx + name;\n            return t.deleteDatabase.apply(t, arguments);\n          };\n          if (k === 'databases') return function () {\n            return t.databases().then(function (dbs) {\n              return (dbs || []).filter(function (d) { return d.name.indexOf(pfx) === 0; })\n                .map(function (d) { return { name: d.name.slice(pfx.length), version: d.version }; });\n            });\n          };\n          var v = t[k];\n          return typeof v === 'function' ? v.bind(t) : v;\n        }\n      });\n      Object.defineProperty(window, 'indexedDB', { value: idbProxy, configurable: true });\n    }\n  } catch (e) { }\n\n  try {\n    var __caches = window.caches;\n    if (__caches) {\n      var cpfx = 'sw-' + b64origin() + '-';\n      var cacheProxy = new Proxy(__caches, {\n        get: function (t, k) {\n          if (k === 'open') return function (name) { return t.open(cpfx + name); };\n          if (k === 'has') return function (name) { return t.has(cpfx + name); };\n          if (k === 'delete') return function (name) { return t.delete(cpfx + name); };\n          if (k === 'keys') return function () {\n            return t.keys().then(function (ks) {\n              return (ks || []).filter(function (n) { return n.indexOf(cpfx) === 0; })\n                .map(function (n) { return n.slice(cpfx.length); });\n            });\n          };\n          var v = t[k];\n          return typeof v === 'function' ? v.bind(t) : v;\n        }\n      });\n      Object.defineProperty(window, 'caches', { value: cacheProxy, configurable: true });\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     v8: opaque-origin identity patches. Sandboxed frames report\n     window.origin === 'null' and THROW on document.domain access;\n     site code that branches on either (Next.js runtimes, ad stacks,\n     SSO widgets) dies or misbehaves. Report the REAL page identity\n     through prototype-level patches so every access path — literal,\n     destructured, eval'd — sees the truth.\n     ============================================================ */\n  try {\n    Object.defineProperty(Document.prototype, 'domain', {\n      get: function () { try { return new URL(cur()).hostname; } catch (e) { return ''; } },\n      set: function () { /* obsolete, no-op */ },\n      configurable: true\n    });\n  } catch (e) { }\n  try {\n    Object.defineProperty(window, 'origin', {\n      get: function () { try { return new URL(cur()).origin; } catch (e) { return 'null'; } },\n      configurable: true\n    });\n  } catch (e) { }\n\n  /* v8: window.navigation (Navigation API) exposes the REAL frame URL\n     ('about:srcdoc') through currentEntry/entries — Next.js 16 routers\n     read it, derive garbage routes ('/srcdoc') and wedge the client\n     tree in an endless Loading state without ever fetching data. The\n     API cannot be shimmed faithfully (event sync with the browser's\n     own session history), but every Navigation-API consumer MUST keep\n     a History-API fallback for Firefox/Safari — so REMOVE the API and\n     let frameworks take that fallback, which our virtual history +\n     location shims fully support. */\n  try { delete window.navigation; } catch (e) {\n    try { Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }); } catch (e2) { }\n  }\n\n  /* v8: BroadcastChannel — some engines refuse construction in\n     opaque-origin frames; fall back to an in-memory same-document\n     channel so boot-time `new BroadcastChannel(...)` never kills a\n     bundle (cross-tab messaging is best-effort anyway in-app). */\n  try {\n    var __BC = window.BroadcastChannel;\n    if (__BC) {\n      var BC_REG = {};\n      function MemBC(name) {\n        this._name = String(name);\n        this._closed = false;\n        this._lsn = [];\n        this.onmessage = null;\n        (BC_REG[this._name] = BC_REG[this._name] || []).push(this);\n      }\n      MemBC.prototype.postMessage = function (d) {\n        if (this._closed) return;\n        var peers = BC_REG[this._name] || [];\n        for (var i = 0; i < peers.length; i++) {\n          var p = peers[i];\n          if (p === this || p._closed) continue;\n          try { p._recv(d); } catch (e) { }\n        }\n      };\n      MemBC.prototype._recv = function (d) {\n        var ev;\n        try { ev = new MessageEvent('message', { data: d }); } catch (e) { ev = { type: 'message', data: d }; }\n        if (typeof this.onmessage === 'function') { try { this.onmessage(ev); } catch (e) { } }\n        for (var i = 0; i < this._lsn.length; i++) { try { this._lsn[i](ev); } catch (e) { } }\n      };\n      MemBC.prototype.close = function () {\n        this._closed = true;\n        var a = BC_REG[this._name] || [];\n        BC_REG[this._name] = a.filter(function (c) { return c !== this; }, this);\n      };\n      MemBC.prototype.addEventListener = function (t, fn) { if (t === 'message' && typeof fn === 'function') this._lsn.push(fn); };\n      MemBC.prototype.removeEventListener = function (t, fn) { this._lsn = this._lsn.filter(function (f) { return f !== fn; }); };\n      var SWBC = function (name) {\n        try {\n          return new __BC(name);\n        } catch (e) {\n          return new MemBC(name);\n        }\n      };\n      try { Object.defineProperty(SWBC, 'name', { value: 'BroadcastChannel' }); } catch (e3) { }\n      window.BroadcastChannel = SWBC;\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     navigator.serviceWorker — never let sites register their own\n     ============================================================ */\n  try {\n    Object.defineProperty(navigator, 'serviceWorker', {\n      value: {\n        controller: null,\n        ready: new Promise(function () { }), /* never settles — avoids unhandledrejection noise */\n        register: function () { return Promise.reject(new DOMException('unsupported', 'UnsupportedError')); },\n        getRegistration: function () { return Promise.resolve(undefined); },\n        getRegistrations: function () { return Promise.resolve([]); },\n        addEventListener: function () { },\n        removeEventListener: function () { },\n        onmessage: null, oncontrollerchange: null\n      },\n      configurable: true\n    });\n  } catch (e) { }\n\n  /* ============================================================\n     Nested frames — iframes must NOT navigate to worker URLs\n     (blocked by network filters). Their documents are fetched and\n     rendered by this hook.\n     v6 history neutrality: a real child navigation (even\n     about:blank) creates a joint session-history entry, and back\n     presses would get eaten by child frames. So: cancel the\n     pending src navigation with stop(), then document.write the\n     fetched document into the child's initial about:blank\n     (same-origin by inheritance → allowed, and open()/write()\n     REPLACES the current entry instead of appending one).\n     srcdoc is only a fallback for cross-origin children (their\n     sandbox makes them opaque to us).\n     ============================================================ */\n  function frameFetch(f, u) {\n    try {\n      /* cancel any in-flight navigation without committing */\n      try { if (f.contentWindow) f.contentWindow.stop(); } catch (e) { }\n      f.setAttribute('data-sw-frame', '1');\n      /* v7: a site-supplied sandbox attr can carry allow-same-origin,\n         which keeps the child attached to the app's real window.top —\n         ad-stack code reading top.location then throws a blanking\n         SecurityError. Drop the attribute and remember it existed:\n         attached children are re-navigated via srcdoc (flags are\n         recomputed from the now-clean attrs → detached child). */\n      var hadSbx = false;\n      try { hadSbx = f.hasAttribute('sandbox'); } catch (e) { }\n      try { f.removeAttribute('sandbox'); } catch (e) { }\n      window.fetch(rw(u), { credentials: 'omit' })\n        .then(function (r) { return r.ok ? r.text() : ''; }, function () { return ''; })\n        .then(function (html) {\n          if (!html) return;\n          /* v7: adopt by RECREATION — a fresh iframe with srcdoc set\n             BEFORE insertion performs its first (and only) navigation\n             with no joint history entry, and a srcdoc child is\n             detached (top === self), unlike the old doc.write path\n             whose children stayed attached to the app's real top and\n             crashed ad stacks reading top.location (BBC/CNN). */\n          try {\n            var nf = f.cloneNode(false);\n            nf.removeAttribute('src');\n            nf.removeAttribute('srcdoc');\n            try { nf.setAttribute('srcdoc', html); } catch (e2) { }\n            if (f.parentNode) f.parentNode.replaceChild(nf, f);\n            else return;\n            tellParent({ type: 'childLoad' });\n            return;\n          } catch (e) { /* fall back to in-place srcdoc */ }\n          try { f.setAttribute('srcdoc', html); } catch (e) { }\n          try { f.removeAttribute('src'); } catch (e) { }\n          /* the srcdoc load may still create a joint history entry\n             above the app's back guard — tell the app so it re-arms\n             the guard and no back press is stolen */\n          tellParent({ type: 'childLoad' });\n        });\n    } catch (e) { }\n  }\n  function adoptFrames() {\n    try {\n      var fr = document.querySelectorAll('iframe[src]');\n      for (var i = 0; i < fr.length; i++) {\n        var f = fr[i];\n        if (f.getAttribute('data-sw-frame')) continue;\n        var raw = f.getAttribute('src') || '';\n        if (!raw || raw.indexOf('about:') === 0) continue;\n        var u = realUrlOf(raw);\n        if (u) frameFetch(f, u);\n      }\n    } catch (e) { }\n  }\n\n  /* ============================================================\n     Element URL properties (src / href / action / srcset / …)\n     Prototype-level get/set so runtime-created elements, jQuery\n     and frameworks all flow through the proxy.\n     v7: srcset/imagesrcset setters (JS-built <picture>/<img> —\n     Apple's marquee tiles), currentSrc unwrapping, input.src.\n     v8 RAW FIDELITY: when site code SETS a url property we rewrite\n     it for loading but remember the CALLER's string in RAW_URL, and\n     getAttribute() reports that string back. Bundler runtimes\n     (Turbopack's chunk loader, webpack's __webpack_require__.l)\n     key pending-chunk maps by the EXACT src they set and later read\n     it back via getAttribute — unwrapping it breaks the key match\n     and the whole boot promise stalls silently (Next.js sites:\n     SSR renders but every interactive function is dead). Raw\n     get-put round-trip is also exactly what real browsers do.\n     ============================================================ */\n  var RAW_URL = new WeakMap();\n  var PROP_HOOKS = {\n    HTMLAnchorElement: { href: 'url' },\n    HTMLAreaElement: { href: 'url' },\n    HTMLScriptElement: { src: 'url' },\n    HTMLImageElement: { src: 'url', srcset: 'srcset', imagesrcset: 'srcset' },\n    HTMLIFrameElement: { src: 'url' },\n    HTMLLinkElement: { href: 'url' },\n    HTMLFormElement: { action: 'url' },\n    HTMLEmbedElement: { src: 'url' },\n    HTMLObjectElement: { data: 'url' },\n    HTMLSourceElement: { src: 'url', srcset: 'srcset', imagesrcset: 'srcset' },\n    HTMLTrackElement: { src: 'url' },\n    HTMLMediaElement: { src: 'url', poster: 'url' },\n    HTMLInputElement: { formaction: 'url', src: 'url' },\n    HTMLButtonElement: { formaction: 'url' },\n    HTMLBaseElement: { href: 'url' }\n  };\n  Object.keys(PROP_HOOKS).forEach(function (cls) {\n    try {\n      var proto = window[cls] && window[cls].prototype;\n      if (!proto) return;\n      Object.keys(PROP_HOOKS[cls]).forEach(function (prop) {\n        var mode = PROP_HOOKS[cls][prop];\n        var d = Object.getOwnPropertyDescriptor(proto, prop);\n        if (!d || !d.get || !d.set) return;\n        Object.defineProperty(proto, prop, {\n          get: function () {\n            var v = d.get.call(this);\n            return mode === 'srcset' ? unrwSrcset(v) : unrw(v);\n          },\n          set: function (v) {\n            try {\n              if (cls === 'HTMLBaseElement') return; /* <base> is poison — swallow */\n              try { RAW_URL.set(this, String(v)); } catch (eRaw) { }\n              if (cls === 'HTMLIFrameElement') {\n                /* nested frames never navigate — fetch + srcdoc instead */\n                var fu = realUrlOf(v);\n                if (fu) { frameFetch(this, fu); return; }\n              }\n              d.set.call(this, mode === 'srcset' ? rwSrcset(v) : rw(String(v)));\n            } catch (e) { d.set.call(this, v); }\n          },\n          configurable: true\n        });\n      });\n      /* currentSrc must report the REAL url, not the worker path */\n      if (cls === 'HTMLImageElement') {\n        var cs = Object.getOwnPropertyDescriptor(proto, 'currentSrc');\n        if (cs && cs.get) {\n          try {\n            Object.defineProperty(proto, 'currentSrc', {\n              get: function () { return unrw(cs.get.call(this)) || cs.get.call(this); },\n              configurable: true\n            });\n          } catch (e) { }\n        }\n      }\n    } catch (e) { }\n  });\n\n  /* ============================================================\n     SRI hard-block (v7) — the HTML pass strips the integrity\n     ATTRIBUTES and setAttribute refuses them, but site JS can also\n     write scriptEl.integrity = '…' — and any integrity check\n     against rewritten content would fail and kill the script.\n     `crossOrigin` is allowed through now (kept intact for real\n     error surfacing + font preload matching). (v7)\n     ============================================================ */\n  try {\n    [window.HTMLScriptElement, window.HTMLLinkElement].forEach(function (P) {\n      if (!P) return;\n      try {\n        Object.defineProperty(P.prototype, 'integrity', {\n          get: function () { return ''; },\n          set: function () { /* swallowed — SRI can never pass on rewritten content */ },\n          configurable: true\n        });\n      } catch (e) { }\n    });\n  } catch (e) { }\n\n  /* v7: iframe.sandbox property setter — strip allow-same-origin\n     before the attribute ever reaches the element, so browsing\n     contexts are created detached (same rule as setAttribute). */\n  try {\n    var __sbxDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'sandbox');\n    if (__sbxDesc && __sbxDesc.set) {\n      Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {\n        get: function () { return __sbxDesc.get.call(this); },\n        set: function (v) {\n          try {\n            var kept = String(v || '').split(/\\s+/).filter(function (t) {\n              return t && t.toLowerCase() !== 'allow-same-origin';\n            });\n            return __sbxDesc.set.call(this, kept.join(' '));\n          } catch (e) { return __sbxDesc.set.call(this, v); }\n        },\n        configurable: true\n      });\n    }\n  } catch (e) { }\n\n  /* setAttribute / getAttribute for the same props */\n  try {\n    var __setattr = Element.prototype.setAttribute;\n    var __getattr = Element.prototype.getAttribute;\n    var TAG_PROPS = {\n      a: ['href'], area: ['href'], script: ['src'], img: ['src', 'srcset'], iframe: ['src'],\n      link: ['href'], form: ['action'], embed: ['src'], object: ['data'], source: ['src', 'srcset'],\n      track: ['src'], video: ['src', 'poster'], audio: ['src'], input: ['formaction'],\n      button: ['formaction'], base: []\n    };\n    function propAllowed(el, prop) {\n      var list = TAG_PROPS[(el.tagName || '').toLowerCase()];\n      return !!list && list.indexOf(prop) >= 0;\n    }\n    Element.prototype.setAttribute = function (name, value) {\n      try {\n        var ln = String(name).toLowerCase();\n        if (ln === 'integrity' || ln === 'referrerpolicy') return;\n        if (ln === 'sandbox') {\n          /* v7: never allow-same-origin on frames — see frameFetch */\n          var kept = String(value || '').split(/\\s+/).filter(function (t) {\n            return t && t.toLowerCase() !== 'allow-same-origin';\n          });\n          if (kept.length) arguments[1] = kept.join(' ');\n          else return __setattr.call(this, 'data-sw-nosbx', '1');\n          return __setattr.apply(this, arguments);\n        }\n        if (ln === 'srcdoc') {\n          arguments[1] = String(value);\n          return __setattr.apply(this, arguments);\n        }\n        if (ln === 'srcset' && propAllowed(this, 'srcset')) {\n          try { RAW_URL.set(this, String(value)); } catch (eR) { }\n          arguments[1] = rwSrcset(value);\n          return __setattr.apply(this, arguments);\n        }\n        if (ln === 'imagesrcset' && propAllowed(this, 'srcset')) {\n          try { RAW_URL.set(this, String(value)); } catch (eR) { }\n          arguments[1] = rwSrcset(value);\n          return __setattr.apply(this, arguments);\n        }\n        if (ln === 'src' && (this.tagName || '').toLowerCase() === 'iframe') {\n          try { RAW_URL.set(this, String(value)); } catch (eR) { }\n          var fu = realUrlOf(value);\n          if (fu) { frameFetch(this, fu); return; }\n        }\n        if (propAllowed(this, ln)) {\n          try { RAW_URL.set(this, String(value)); } catch (eR) { }\n          arguments[1] = rw(String(value));\n        }\n      } catch (e) { }\n      return __setattr.apply(this, arguments);\n    };\n    Element.prototype.getAttribute = function (name) {\n      var v = __getattr.call(this, name);\n      try {\n        var ln = String(name).toLowerCase();\n        if (v == null) return v;\n        if (ln === 'srcset' || ln === 'imagesrcset' || propAllowed(this, ln)) {\n          /* v8 RAW FIDELITY: a url that was SET through our patched\n             surfaces reports back the caller's exact string (what a\n             real browser's getAttribute returns). Bundler chunk\n             loaders key their pending-chunk maps by that string —\n             see the RAW_URL note above. HTML-authored attributes\n             (already absolute /service/ URLs) keep the v7 unwrap. */\n          if (RAW_URL.has(this)) {\n            var rv = RAW_URL.get(this);\n            if (rv != null) return rv;\n          }\n          if (ln === 'srcset' || ln === 'imagesrcset') return unrwSrcset(v);\n          return unrw(v);\n        }\n      } catch (e) { }\n      return v;\n    };\n  } catch (e) { }\n\n  /* ============================================================\n     HTML injection surfaces — innerHTML / outerHTML /\n     insertAdjacentHTML go through the parser, which bypasses the\n     property setters above. A single regex pass rewrites absolute\n     URLs before the parser ever sees them.\n     ============================================================ */\n  function quickHtmlStr(s) {\n    if (typeof s !== 'string' || s.indexOf('<') < 0) return s;\n    var out = s.replace(/(\\s(?:src|href|action|poster|formaction|data|data-src|data-original|data-lazy|data-lazy-src|data-bg|data-background|data-image|data-poster)\\s*=\\s*)(\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))/gi,\n      function (m, pre, q, dq, sq, uq) {\n        var val = dq !== undefined ? dq : (sq !== undefined ? sq : uq);\n        if (!val || /^(data:|blob:|javascript:|about:|#|mailto:|tel:)/i.test(val) ||\n          isProxied(val)) return m;\n        /* both absolute AND relative URLs — rw() resolves relative values\n           against the decoded page URL so the browser never has to guess. */\n        var r = rw(val);\n        if (r === val) return m;\n        if (dq !== undefined) return pre + '\"' + r.replace(/\"/g, '&quot;') + '\"';\n        if (sq !== undefined) return pre + \"'\" + r.replace(/'/g, '&#39;') + \"'\";\n        return pre + r;\n      });\n    /* v7: srcset-shaped attributes injected via innerHTML (Apple's\n       JS-built <picture> tiles) */\n    out = out.replace(/(\\s(?:srcset|imagesrcset|data-srcset|data-lazy-srcset)\\s*=\\s*)(\"([^\"]*)\"|'([^']*)')/gi,\n      function (m, pre, q, dq, sq) {\n        var val = dq !== undefined ? dq : sq;\n        if (!val) return m;\n        var r = rwSrcset(val);\n        if (r === val) return m;\n        var qq = dq !== undefined ? '\"' : \"'\";\n        return pre + qq + r.replace(/\"/g, '&quot;') + qq;\n      });\n    /* v7: inline style=\"… url(rel) …\" backgrounds */\n    out = out.replace(/(\\sstyle\\s*=\\s*)(\"([^\"]*)\"|'([^']*)')/gi,\n      function (m, pre, q, dq, sq) {\n        var val = dq !== undefined ? dq : sq;\n        if (!val || !/url\\(/i.test(val)) return m;\n        var r = rwCssLite(val);\n        if (r === val) return m;\n        var qq = dq !== undefined ? '\"' : \"'\";\n        return pre + qq + r.replace(/\"/g, '&quot;') + qq;\n      });\n    /* v7: iframe sandbox attrs injected via innerHTML — strip\n       allow-same-origin so parser-created frames are detached\n       (flags freeze at parse time; post-insertion cleanup is too\n       late). An empty remainder drops the attribute entirely\n       (sandbox=\"\" would disable scripts). */\n    out = out.replace(/(\\ssandbox\\s*=\\s*)(\"([^\"]*)\"|'([^']*)')/gi,\n      function (m, pre, q, dq, sq) {\n        var val = dq !== undefined ? dq : sq;\n        var toks = String(val || '').split(/\\s+/).filter(function (t) { return t; });\n        var kept = toks.filter(function (t) { return t.toLowerCase() !== 'allow-same-origin'; });\n        if (kept.length === toks.length) return m;\n        if (!kept.length) return '';\n        var qq = dq !== undefined ? '\"' : \"'\";\n        return pre + qq + kept.join(' ') + qq;\n      });\n    return out;\n  }\n  try {\n    ['innerHTML', 'outerHTML'].forEach(function (prop) {\n      var d = Object.getOwnPropertyDescriptor(Element.prototype, prop);\n      if (!d || !d.set) return;\n      Object.defineProperty(Element.prototype, prop, {\n        get: function () { return d.get.call(this); },\n        set: function (v) { d.set.call(this, quickHtmlStr(v)); },\n        configurable: true\n      });\n    });\n    var __iah = Element.prototype.insertAdjacentHTML;\n    Element.prototype.insertAdjacentHTML = function (pos, html) {\n      try { arguments[1] = quickHtmlStr(html); } catch (e) { }\n      return __iah.apply(this, arguments);\n    };\n  } catch (e) { }\n\n  /* ============================================================\n     document.write / writeln — quick attribute rewrite\n     ============================================================ */\n  try {\n    var __write = Document.prototype.write, __writeln = Document.prototype.writeln;\n    Document.prototype.write = function () {\n      for (var i = 0; i < arguments.length; i++) {\n        arguments[i] = quickHtmlStr(arguments[i]);\n      }\n      return __write.apply(this, arguments);\n    };\n    Document.prototype.writeln = function () {\n      for (var i = 0; i < arguments.length; i++) {\n        arguments[i] = quickHtmlStr(arguments[i]);\n      }\n      return __writeln.apply(this, arguments);\n    };\n  } catch (e) { }\n\n  /* ============================================================\n     Runtime-created CSS rules — insertRule/addRule text can carry\n     relative url()/image-set() values that would resolve against\n     the srcdoc base. (v7)\n     ============================================================ */\n  try {\n    var __insRule = CSSStyleSheet.prototype.insertRule;\n    if (__insRule) {\n      CSSStyleSheet.prototype.insertRule = function (rule, idx) {\n        try {\n          if (typeof rule === 'string' && rule.indexOf('url(') >= 0) arguments[0] = rwCssLite(rule);\n        } catch (e) { }\n        return __insRule.apply(this, arguments);\n      };\n    }\n    var __addRule = CSSStyleSheet.prototype.addRule;\n    if (__addRule) {\n      CSSStyleSheet.prototype.addRule = function (sel, body, idx) {\n        try {\n          if (typeof body === 'string' && body.indexOf('url(') >= 0) arguments[1] = rwCssLite(body);\n        } catch (e) { }\n        return __addRule.apply(this, arguments);\n      };\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     navigator.cookieEnabled — sandboxed frames report cookies as\n     unavailable; some sites refuse to run search/checkout flows\n     when it is false. We emulate cookies, so report true. (v7)\n     ============================================================ */\n  try {\n    Object.defineProperty(navigator, 'cookieEnabled', {\n      get: function () { return true; },\n      configurable: true\n    });\n  } catch (e) { }\n\n  /* ============================================================\n     Click capture — ALL link activations become app navigations.\n     Bubble phase + defaultPrevented check so SPA routers that\n     handle clicks themselves (preventDefault + pushState) are\n     untouched; only real \"would-navigate\" clicks are relayed.\n     v6: anchors with a `download` attribute are intercepted too —\n     a native iframe download would issue a NAVIGATION-class\n     request to the worker URL (blocked on API-only networks).\n     Instead the app fetches the file via API and hands it to the\n     browser's real download manager.\n     ============================================================ */\n  function relayDownload(anchor) {\n    try {\n      var raw = anchor.getAttribute('href') || '';\n      var name = anchor.getAttribute('download') || '';\n      if (/^data:/i.test(raw)) {\n        tellParent({ type: 'download', dataUrl: raw, filename: name });\n        return;\n      }\n      if (/^blob:/i.test(raw)) {\n        /* the blob lives in THIS frame — read it out and forward it */\n        fetch(raw).then(function (r) { return r.blob(); }).then(function (b) {\n          return new Promise(function (res) {\n            try {\n              var fr = new FileReader();\n              fr.onload = function () { res({ d: String(fr.result || ''), t: b.type }); };\n              fr.onerror = function () { res(null); };\n              fr.readAsDataURL(b);\n            } catch (e) { res(null); }\n          });\n        }).then(function (out) {\n          if (out && out.d) tellParent({ type: 'download', dataUrl: out.d, mime: out.t, filename: name });\n          else tellParent({ type: 'download', failed: 1, filename: name });\n        }, function () {\n          tellParent({ type: 'download', failed: 1, filename: name });\n        });\n        return;\n      }\n      var url = realUrlOf(raw);\n      if (url) tellParent({ type: 'download', url: url, filename: name });\n    } catch (e) { }\n  }\n  function handleAnchor(e, anchor, viaAux) {\n    try {\n      if (anchor.hasAttribute && anchor.hasAttribute('download')) {\n        e.preventDefault();\n        relayDownload(anchor);\n        return;\n      }\n      var raw = anchor.getAttribute('href');\n      if (raw == null || raw === '' || raw.charAt(0) === '#') return;\n      if (SKIP.test(raw)) return;\n      var url = realUrlOf(raw);\n      if (!url) return;\n      e.preventDefault();\n      var tgt = (anchor.getAttribute('target') || '').toLowerCase();\n      var wantTab = viaAux || e.ctrlKey || e.metaKey || e.shiftKey ||\n        tgt === '_blank' || (tgt && tgt !== '_self' && tgt !== '_top' && tgt !== '_parent');\n      if (wantTab) tellParent({ type: 'openTab', url: url });\n      else navParent(url);\n    } catch (err) { }\n  }\n  try {\n    document.addEventListener('click', function (e) {\n      try {\n        if (e.defaultPrevented || e.button !== 0) return;\n        var a = e.target && e.target.closest ? e.target.closest('a,area') : null;\n        if (!a) return;\n        handleAnchor(e, a, false);\n      } catch (err) { }\n    }, false);\n    document.addEventListener('auxclick', function (e) {\n      try {\n        if (e.defaultPrevented || e.button !== 1) return;\n        var a = e.target && e.target.closest ? e.target.closest('a,area') : null;\n        if (!a) return;\n        handleAnchor(e, a, true);\n      } catch (err) { }\n    }, false);\n    /* neutralize target=_top / _parent at runtime */\n    document.addEventListener('click', function (e) {\n      try {\n        var el = e.target && e.target.closest ? e.target.closest('a[target],area[target],form[target]') : null;\n        if (!el) return;\n        var t = (el.getAttribute('target') || '').toLowerCase();\n        if (t === '_top' || t === '_parent') el.setAttribute('target', '_self');\n      } catch (err) { }\n    }, true);\n  } catch (e) { }\n\n  /* ============================================================\n     Form submits — relayed to the app (GET → navigate,\n     POST → the app fetches with the body and swaps srcdoc).\n     postMessage from sandboxed frames cannot clone FormData or\n     URLSearchParams, so entries are sent as plain arrays and\n     files as data-URLs; the app rebuilds the body.\n     ============================================================ */\n  function relayForm(form, submitter) {\n    var sent = false;\n    function send(msg) { if (!sent) { sent = true; tellParent(msg); } }\n    try {\n      if (!form || (form.tagName || '').toUpperCase() !== 'FORM') return false;\n      var actionAttr = form.getAttribute('action');\n      var url = (actionAttr && realUrlOf(actionAttr)) || cur();\n      if (!/^https?:/i.test(url)) url = cur();\n      var method = ((form.getAttribute('method') || 'GET').toUpperCase() === 'POST') ? 'POST' : 'GET';\n      var enctype = (form.getAttribute('enctype') || 'application/x-www-form-urlencoded').toLowerCase();\n      var fd = null;\n      try { fd = submitter ? new FormData(form, submitter) : new FormData(form); } catch (e) { fd = null; }\n      if (!fd) return false;\n      var fields = [], files = [];\n      fd.forEach(function (v, k) {\n        if (typeof v === 'string') { fields.push([k, v]); return; }\n        if (v && typeof v === 'object' && v.name != null) files.push([k, v]);\n      });\n      if (method === 'GET') {\n        var u = new URL(url);\n        var params = new URLSearchParams();\n        fields.forEach(function (p) { params.append(p[0], p[1]); });\n        u.search = params.toString();\n        navParent(u.href);\n        return true;\n      }\n      if (files.length && enctype.indexOf('multipart') === 0) {\n        var payload = [], n = 0;\n        var flush = function () {\n          send({ type: 'submit', url: url, multipart: true, fields: fields, files: payload });\n        };\n        files.forEach(function (pair) {\n          var k = pair[0], file = pair[1];\n          try {\n            var fr = new FileReader();\n            fr.onload = function () {\n              payload.push({ k: k, name: file.name, type: file.type || 'application/octet-stream', b64: String(fr.result || '') });\n              if (++n === files.length) flush();\n            };\n            fr.onerror = function () { if (++n === files.length) flush(); };\n            fr.readAsDataURL(file);\n          } catch (e) { if (++n === files.length) flush(); }\n        });\n        return true;\n      }\n      send({ type: 'submit', url: url, fields: fields });\n      return true;\n    } catch (e) { return false; }\n  }\n  try {\n    document.addEventListener('submit', function (e) {\n      try {\n        if (e.defaultPrevented) return;\n        if (relayForm(e.target, e.submitter)) e.preventDefault();\n      } catch (err) { }\n    }, false);\n    /* JS-submitted forms bypass the submit event */\n    var __formSubmit = HTMLFormElement.prototype.submit;\n    HTMLFormElement.prototype.submit = function () {\n      try { if (relayForm(this, null)) return; } catch (e) { }\n      return __formSubmit.apply(this, arguments);\n    };\n  } catch (e) { }\n\n  /* ============================================================\n     window.open — never a real popup (it would navigate a real\n     window to the worker → blocked). Opens an in-app tab and\n     returns a lightweight fake window so callers keep working.\n     ============================================================ */\n  function fakeWin() {\n    var w = { closed: false, name: '', opener: window, length: 0, frames: [] };\n    w.close = function () { w.closed = true; };\n    w.focus = function () { };\n    w.blur = function () { };\n    w.postMessage = function () { };\n    w.alert = function () { };\n    w.confirm = function () { return false; };\n    w.prompt = function () { return null; };\n    w.print = function () { };\n    w.scrollTo = function () { };\n    w.open = function () { return w; };\n    try {\n      Object.defineProperty(w, 'location', {\n        get: function () { return __swloc; },\n        set: function (v) { __swloc.href = v; },\n        configurable: true\n      });\n    } catch (e) { }\n    w.document = {\n      write: function () { }, writeln: function () { }, open: function () { }, close: function () { },\n      title: '', body: null, readyState: 'complete',\n      createElement: function () { return { style: {}, appendChild: function () { }, setAttribute: function () { } }; },\n      createTextNode: function (t) { return { textContent: t }; },\n      appendChild: function () { }, removeChild: function () { },\n      addEventListener: function () { }, removeEventListener: function () { },\n      getElementById: function () { return null; }\n    };\n    return w;\n  }\n  try {\n    window.open = function (u, name, features) {\n      try {\n        var s = (u == null) ? '' : String(u);\n        if (!s || SKIP.test(s)) return fakeWin();\n        var url = realUrlOf(s);\n        if (url) {\n          var nm = String(name || '').toLowerCase();\n          if (nm === '_self') navParent(url);\n          else tellParent({ type: 'openTab', url: url });\n          return fakeWin();\n        }\n      } catch (e) { }\n      return fakeWin();\n    };\n  } catch (e) { }\n\n  /* window.close inside the app: notify instead of failing */\n  try {\n    var __close = window.close;\n    window.close = function () {\n      if (IS_TOP) return __close.call(window);\n      tellParent({ type: 'closeRequest' });\n    };\n  } catch (e) { }\n\n  /* ============================================================\n     Meta refresh — never let the frame navigate. The tag is\n     removed and its destination relayed after the original delay.\n     ============================================================ */\n  function killRefresh() {\n    try {\n      var metas = document.querySelectorAll('meta[http-equiv=\"refresh\" i]');\n      for (var i = 0; i < metas.length; i++) {\n        var m = metas[i];\n        var c = (m.getAttribute('content') || '').trim();\n        try { m.parentNode && m.parentNode.removeChild(m); } catch (e) { }\n        var mm = /^(\\d+)\\s*;?\\s*url\\s*=\\s*(.*)$/i.exec(c);\n        if (!mm) continue;\n        var delay = parseInt(mm[1], 10) || 0;\n        var url = realUrlOf(mm[2].trim().replace(/^['\"]|['\"]$/g, ''));\n        if (url) (function (u, d) {\n          setTimeout(function () { tellParent({ type: 'navigate', url: u }); }, Math.max(d, 0) * 1000);\n        })(url, delay);\n      }\n    } catch (e) { }\n  }\n\n  /* ============================================================\n     Meta reporting — title / favicon to the app UI\n     ============================================================ */\n  function pickIcon() {\n    try {\n      var links = document.querySelectorAll('link[rel~=\"icon\" i],link[rel=\"shortcut icon\" i],link[rel=\"apple-touch-icon\" i]');\n      for (var i = 0; i < links.length; i++) {\n        var h = links[i].getAttribute('href');\n        if (h) return unrw(h);\n      }\n    } catch (e) { }\n    return null;\n  }\n  function tellMeta() {\n    tellParent({ type: 'meta', title: document.title, favicon: pickIcon() });\n  }\n\n  /* ============================================================\n     Runtime DOM rewriter (v7) — JS-heavy sites (Apple, Amazon,\n     news SPAs) inject <img>/<picture>/<style>/background-images\n     AFTER parse via cloneNode, DOMParser, importNode or attribute\n     writes that never pass through a patchable surface. This\n     observer catches every node/attribute/style-text change and\n     rewrites raw URLs before the network layer sees them.\n     ============================================================ */\n  var FIX_ATTRS = {\n    src: 1, href: 1, action: 1, formaction: 1, poster: 1, background: 1,\n    'xlink:href': 1, 'data-src': 1, 'data-original': 1, 'data-original-src': 1,\n    'data-lazy': 1, 'data-lazy-src': 1, 'data-image': 1, 'data-img': 1,\n    'data-bg': 1, 'data-background': 1, 'data-background-image': 1,\n    'data-poster': 1, 'data-thumb': 1, 'data-ll-url': 1, 'data-lazyload': 1,\n    'data-echo': 1\n  };\n  var FIX_SRCSET_ATTRS = { srcset: 1, imagesrcset: 1, 'data-srcset': 1, 'data-lazy-srcset': 1 };\n  function looksRewritable(v) {\n    return typeof v === 'string' && v && v.length < 4096 &&\n      v.indexOf(WO + PREFIX) !== 0 && v.indexOf(PREFIX) !== 0 &&\n      !/^(data:|blob:|javascript:|about:|#|mailto:|tel:|sms:|magnet:|intent:|market:)/i.test(v);\n  }\n  function fixEl(e) {\n    try {\n      if (!e || e.nodeType !== 1) return;\n      var tag = (e.tagName || '').toLowerCase();\n      if (tag === 'iframe') {\n        /* frames: strip allow-same-origin eagerly (browsing-context\n           flags freeze at insertion — the earlier the attr is clean,\n           the better; adopted frames re-check in frameFetch) */\n        try {\n          var sb = e.getAttribute('sandbox');\n          if (sb && /allow-same-origin/i.test(sb)) {\n            var kept = sb.split(/\\s+/).filter(function (t) {\n              return t && t.toLowerCase() !== 'allow-same-origin';\n            });\n            if (kept.length) __setattr.call(e, 'sandbox', kept.join(' '));\n            else e.removeAttribute('sandbox');\n          }\n        } catch (e4) { }\n        return; /* adoptFrames owns the rest of frame handling */\n      }\n      var at = e.attributes;\n      if (!at || !at.length) return;\n      for (var i = 0; i < at.length; i++) {\n        var a = at[i];\n        var an = (a.name || '').toLowerCase();\n        var v = a.value;\n        if (!v) continue;\n        if (FIX_SRCSET_ATTRS[an]) {\n          if (!looksRewritable(v)) continue;\n          var rs = rwSrcset(v);\n          if (rs !== v) __setattr.call(e, an, rs);\n        } else if (FIX_ATTRS[an]) {\n          if (!looksRewritable(v)) continue;\n          /* only rewrite values that produce http(s) URLs — plain\n             #anchors, href=\"javascript:…\" etc. are left alone */\n          var abs = null;\n          try { abs = new URL(v, cur()); } catch (e2) { }\n          if (!abs || (abs.protocol !== 'http:' && abs.protocol !== 'https:')) continue;\n          var r = rw(v);\n          if (r !== v) __setattr.call(e, an, r);\n        } else if (an === 'style') {\n          if (!/url\\(/i.test(v)) continue;\n          var rc = rwCssLite(v);\n          if (rc !== v) __setattr.call(e, 'style', rc);\n        }\n      }\n    } catch (e3) { }\n  }\n  function fixStyleText(styleEl) {\n    try {\n      var t = styleEl.textContent;\n      if (!t || !/url\\(/i.test(t)) return;\n      var r = rwCssLite(t);\n      if (r !== t) styleEl.textContent = r;\n    } catch (e) { }\n  }\n  var __moTimer = null;\n  function moHousekeeping() {\n    /* meta/refresh/frame work is debounced — mutation bursts on\n       SPAs would otherwise postMessage in every microtask */\n    if (__moTimer) return;\n    __moTimer = setTimeout(function () {\n      __moTimer = null;\n      try { tellMeta(); killRefresh(); adoptFrames(); } catch (e) { }\n    }, 150);\n  }\n  try {\n    var mo = new MutationObserver(function (recs) {\n      try {\n        for (var i = 0; i < recs.length; i++) {\n          var r = recs[i];\n          if (r.type === 'childList') {\n            var an = r.addedNodes;\n            for (var j = 0; j < an.length; j++) {\n              var n = an[j];\n              if (n.nodeType === 3) {\n                var tp = n.parentNode;\n                if (tp && tp.tagName === 'STYLE') fixStyleText(tp);\n                continue;\n              }\n              if (n.nodeType !== 1) continue;\n              if (n.tagName === 'STYLE') fixStyleText(n);\n              fixEl(n);\n              if (n.querySelectorAll) {\n                var sub = n.querySelectorAll('[src],[href],[srcset],[poster],[style],[data-src],[data-original],[data-lazy-src],[data-bg],[data-background],[data-image],[data-poster]');\n                for (var k = 0; k < sub.length; k++) fixEl(sub[k]);\n              }\n            }\n          } else if (r.type === 'attributes') {\n            fixEl(r.target);\n          } else if (r.type === 'characterData') {\n            var pn = r.target.parentNode;\n            if (pn && pn.tagName === 'STYLE') fixStyleText(pn);\n          }\n        }\n      } catch (e) { }\n      moHousekeeping();\n    });\n    mo.observe(document.documentElement, {\n      childList: true, subtree: true, attributes: true, characterData: true,\n      attributeFilter: ['rel', 'href', 'src', 'srcset', 'imagesrcset', 'poster',\n        'style', 'action', 'data', 'data-src', 'data-srcset', 'data-original',\n        'data-lazy', 'data-lazy-src', 'data-bg', 'data-background',\n        'data-background-image', 'data-image', 'data-poster', 'xlink:href']\n    });\n  } catch (e) { }\n\n  /* load reporting */\n  try {\n    document.addEventListener('DOMContentLoaded', function () { tellNav({ phase: 'dcl' }); });\n    addEventListener('load', function () { tellNav({ phase: 'load', favicon: pickIcon(), loaded: true }); });\n    addEventListener('pageshow', function () { tellNav({ phase: 'pageshow' }); });\n    addEventListener('pagehide', function () { tellParent({ type: 'unloading' }); });\n  } catch (e) { }\n\n  /* error forwarding — lets the browser UI surface page errors.\n     v8: RESOURCE load failures (script/img/link/iframe network errors)\n     arrive as message-less Events on the element — they used to relay\n     as empty messages, hiding the single most useful diagnostic (which\n     URL failed). They now carry the tag + URL. */\n  function errCtx() {\n    try {\n      return (window.top === window.self ? 'topEqSelf' : 'topNEself') +\n        ' loc=' + String(location.href).slice(0, 50);\n    } catch (e) { return 'ctx?'; }\n  }\n  try {\n    addEventListener('error', function (e) {\n      /* resource-load failure branch */\n      if (!e.message && e.target && e.target !== window && e.target.tagName) {\n        var t = e.target;\n        var ln = (t.tagName || '').toLowerCase();\n        if (ln === 'script' || ln === 'img' || ln === 'link' || ln === 'iframe' || ln === 'source') {\n          tellParent({\n            type: 'pageError',\n            msg: 'Failed to load <' + ln + '> ' + String(t.src || t.href || t.data || '').slice(0, 240),\n            src: String(t.src || t.href || ''),\n            line: 0,\n            res: 1,\n            ctx: errCtx()\n          });\n        }\n        return;\n      }\n      tellParent({\n        type: 'pageError',\n        msg: String(e.message || ''),\n        src: String(e.filename || ''),\n        line: e.lineno || 0,\n        stack: (e.error && e.error.stack) ? String(e.error.stack).slice(0, 400) : '',\n        ctx: errCtx()\n      });\n    }, true);\n    addEventListener('unhandledrejection', function (e) {\n      var r = e.reason;\n      tellParent({\n        type: 'pageError',\n        msg: 'Unhandled rejection: ' + (r && r.message ? r.message : String(r)).slice(0, 200),\n        stack: (r && r.stack) ? String(r.stack).slice(0, 400) : '',\n        ctx: errCtx()\n      });\n    });\n  } catch (e) { }\n\n  /* v8: console.error/warn relay — hydration crashes (React/Next.js)\n     log instead of throwing; without this the app console shows\n     nothing while the page sits dead. */\n  try {\n    var __cerr = console.error, __cwarn = console.warn;\n    function argStr(a) {\n      if (typeof a === 'string') return a;\n      if (a instanceof Error) return a.message;\n      try { return JSON.stringify(a); } catch (e) { return String(a); }\n    }\n    console.error = function () {\n      try {\n        var s = Array.prototype.map.call(arguments, argStr).join(' ');\n        if (s) tellParent({ type: 'pageError', msg: '[console.error] ' + s.slice(0, 300), ctx: errCtx() });\n      } catch (e) { }\n      return __cerr.apply(console, arguments);\n    };\n    console.warn = function () {\n      try {\n        var s = Array.prototype.map.call(arguments, argStr).join(' ');\n        if (s) tellParent({ type: 'pageLog', msg: '[console.warn] ' + s.slice(0, 300) });\n      } catch (e) { }\n      return __cwarn.apply(console, arguments);\n    };\n  } catch (e) { }\n\n  /* ============================================================\n     Find in page — runs INSIDE the page document so it works even\n     when the iframe is cross-origin/sandboxed (file:// mode).\n     ============================================================ */\n  var findState = { marks: [], cur: -1 };\n  function findStyle(active) {\n    return active ? 'background:#ff9632;color:#000;border-radius:2px'\n      : 'background:#ffe58a;color:#000;border-radius:2px';\n  }\n  function findClear() {\n    findState.marks.forEach(function (m) {\n      try {\n        var p = m.parentNode;\n        if (p) p.replaceChild(document.createTextNode(m.textContent), m);\n      } catch (e) { }\n    });\n    try { if (document.body) document.body.normalize(); } catch (e) { }\n    findState = { marks: [], cur: -1 };\n  }\n  function findRun(q) {\n    findClear();\n    var ql = String(q || '').toLowerCase();\n    if (!ql) { tellParent({ type: 'findResult', total: 0, cur: -1 }); return; }\n    try {\n      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {\n        acceptNode: function (node) {\n          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;\n          var p = node.parentElement;\n          if (!p) return NodeFilter.FILTER_REJECT;\n          var t = p.tagName;\n          if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' ||\n            t === 'TEXTAREA' || t === 'INPUT') return NodeFilter.FILTER_REJECT;\n          return node.nodeValue.toLowerCase().indexOf(ql) >= 0 ?\n            NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;\n        }\n      });\n      var nodes = [];\n      while (walker.nextNode()) nodes.push(walker.currentNode);\n      nodes.forEach(function (node) {\n        var lv = node.nodeValue.toLowerCase(), i = 0;\n        while ((i = lv.indexOf(ql, i)) >= 0) {\n          var after = node.splitText(i);\n          var rest = after.splitText(ql.length);\n          var mark = document.createElement('mark');\n          mark.setAttribute('data-swfind', '1');\n          mark.style.cssText = findStyle(false);\n          after.parentNode.replaceChild(mark, after);\n          mark.appendChild(after);\n          findState.marks.push(mark);\n          node = rest;\n          lv = rest.nodeValue.toLowerCase();\n          i = 0;\n        }\n      });\n    } catch (e) { }\n    tellParent({ type: 'findResult', total: findState.marks.length, cur: findState.marks.length ? 0 : -1 });\n    if (findState.marks.length) findGo(0);\n  }\n  function findGo(idx) {\n    if (!findState.marks.length) return;\n    if (findState.cur >= 0 && findState.marks[findState.cur]) {\n      findState.marks[findState.cur].style.cssText = findStyle(false);\n    }\n    findState.cur = ((idx % findState.marks.length) + findState.marks.length) % findState.marks.length;\n    var m = findState.marks[findState.cur];\n    m.style.cssText = findStyle(true);\n    try { m.scrollIntoView({ block: 'center' }); } catch (e) { try { m.scrollIntoView(); } catch (e2) { } }\n    tellParent({ type: 'findResult', total: findState.marks.length, cur: findState.cur });\n  }\n\n  /* ============================================================\n     v8.1 blob registry — workers are bridged into the app context,\n     which CANNOT fetch blob: URLs created in this (sandboxed,\n     opaque-origin) frame: blob URLs are context/origin-scoped. Sites\n     that hand blob: URLs to workers (ffmpeg.wasm's load({coreURL,\n     wasmURL}) wraps fetched scripts in blobs) died on exactly this.\n     Two layers:\n       1. every created blob is remembered + asynchronously converted\n          to a data: URL (context-independent). The fake worker's\n          postMessage HOLDS any message containing blob: strings until\n          the conversions finish, then swaps them in — postMessage is\n          fire-and-forget, so the delay is invisible to the site. The\n          bridged worker then imports/fetches plain data: URLs.\n       2. workers that fetch blob: URLs directly still get served via\n          the __swblobget round-trip (see the shim + app bridge).\n     ============================================================ */\n  var SWBLOBS = {};\n  var SWBLOBD = {}; /* blobUrl → Promise<dataUrl|null> */\n  try {\n    var __cOU = URL.createObjectURL;\n    URL.createObjectURL = function (b) {\n      var u = __cOU.call(URL, b);\n      try {\n        SWBLOBS[u] = b;\n        SWBLOBD[u] = new Promise(function (res) {\n          try {\n            var fr = new FileReader();\n            fr.onload = function () { res(fr.result || null); };\n            fr.onerror = function () { res(null); };\n            fr.readAsDataURL(b);\n          } catch (eF) { res(null); }\n        });\n      } catch (e) { }\n      return u;\n    };\n    var __rOU = URL.revokeObjectURL;\n    URL.revokeObjectURL = function (u) {\n      try { delete SWBLOBS[u]; delete SWBLOBD[u]; } catch (e) { }\n      return __rOU.call(URL, u);\n    };\n    try { Object.defineProperty(URL.createObjectURL, 'toString', { value: __cOU.toString.bind(__cOU) }); } catch (eTN) { }\n    try { Object.defineProperty(URL.revokeObjectURL, 'toString', { value: __rOU.toString.bind(__rOU) }); } catch (eTN2) { }\n  } catch (e) { }\n\n  /* collect blob: URL strings in a message (deep, cycle-safe) */\n  function swFindBlobs(v, depth, seen, out) {\n    if (depth > 5 || v == null) return;\n    if (typeof v === 'string') {\n      if (v.indexOf('blob:') === 0 && SWBLOBD[v] && out.indexOf(v) < 0) {\n        var bb = SWBLOBS[v];\n        if (!bb || !bb.size || bb.size < 4194304) out.push(v);\n      }\n      return;\n    }\n    if (typeof v !== 'object') return;\n    if (seen.indexOf(v) >= 0) return;\n    seen.push(v);\n    if (Array.isArray(v)) {\n      for (var i = 0; i < v.length; i++) swFindBlobs(v[i], depth + 1, seen, out);\n    } else {\n      for (var k in v) { try { swFindBlobs(v[k], depth + 1, seen, out); } catch (eK) { } }\n    }\n  }\n\n  /* replace blob: strings with their resolved data: URLs */\n  function swReplaceBlobs(v, depth, seen, map) {\n    if (depth > 5 || v == null) return;\n    if (typeof v === 'string') {\n      if (v.indexOf('blob:') === 0 && map[v]) return map[v];\n      return;\n    }\n    if (typeof v !== 'object') return;\n    if (seen.indexOf(v) >= 0) return;\n    seen.push(v);\n    if (Array.isArray(v)) {\n      for (var i = 0; i < v.length; i++) {\n        var r = swReplaceBlobs(v[i], depth + 1, seen, map);\n        if (r !== undefined) v[i] = r;\n      }\n    } else {\n      for (var k in v) {\n        try {\n          var r2 = swReplaceBlobs(v[k], depth + 1, seen, map);\n          if (r2 !== undefined) v[k] = r2;\n        } catch (eK) { }\n      }\n    }\n  }\n\n  /* send a message to the app, swapping any blob: URLs for data: URLs\n     first (holding the send until conversions complete) */\n  function swTellParentBlobSafe(msg) {\n    try {\n      var out = [];\n      swFindBlobs(msg, 0, [], out);\n      if (!out.length) { tellParent(msg); return; }\n      Promise.all(out.map(function (u) { return SWBLOBD[u]; })).then(function (durls) {\n        var map = {};\n        for (var i = 0; i < out.length; i++) if (durls[i]) map[out[i]] = durls[i];\n        try { swReplaceBlobs(msg, 0, [], map); } catch (eR) { }\n        tellParent(msg);\n      }, function () { tellParent(msg); });\n    } catch (e) { try { tellParent(msg); } catch (e2) { } }\n  }\n\n  /* ============================================================\n     Message channel:\n       • parent commands (back / forward / reload / find)\n       • nested-frame hook messages bubble up to the app\n     ============================================================ */\n  addEventListener('message', function (e) {\n    var d = e.data;\n    if (!d) return;\n    /* v8.1: blob bytes request from a bridged worker (relayed by the app) */\n    if (d.__swblobget === 1 && d.req) {\n      var bl = null;\n      try { bl = SWBLOBS[d.url] || null; } catch (eB) { }\n      if (bl) {\n        try {\n          bl.arrayBuffer().then(function (buf) {\n            tellParentT({ type: '__swblob', __swblobgot: 1, req: d.req, mime: bl.type || 'application/octet-stream', buf: buf }, [buf]);\n          }, function () {\n            tellParent({ type: '__swblob', __swblobgot: 1, req: d.req, fail: 1 });\n          });\n        } catch (eR) {\n          tellParent({ type: '__swblob', __swblobgot: 1, req: d.req, fail: 1 });\n        }\n      } else {\n        tellParent({ type: '__swblob', __swblobgot: 1, req: d.req, fail: 1 });\n      }\n      return;\n    }\n    /* v8: worker bridge events from the app (real worker → fake worker) */\n    if (d.__swwork === 1) {\n      try {\n        var fw = WORKERS[d.id];\n        if (fw && typeof fw._swfire === 'function') fw._swfire(d.kind, d.data);\n      } catch (err) { }\n      return;\n    }\n    if (d.__swcmd === 1) {\n      try {\n        switch (d.cmd) {\n          case 'back': vGo(-1); break;\n          case 'fwd': vGo(1); break;\n          case 'reload': tellParent({ type: 'reloadRequest' }); break;\n          case 'find': findRun(d.q); break;\n          case 'findNext': findGo(findState.cur + 1); break;\n          case 'findPrev': findGo(findState.cur - 1); break;\n          case 'findClear': findClear(); break;\n        }\n      } catch (err) { }\n      return;\n    }\n    /* bubble nested-frame hook traffic up to the app. Only ACTION\n       messages (navigations, cookies, storage, downloads) are\n       forwarded — the app tracks the TOP page's nav/meta state\n       itself, and a child frame's 'nav start' handshake must never\n       be mistaken for an escaped frame. */\n    if (d.__sw === 1) {\n      try {\n        if (e.source && e.source !== window &&\n            (d.type === 'navigate' || d.type === 'openTab' || d.type === 'submit' ||\n             d.type === 'setCookie' || d.type === 'swStore' || d.type === 'swClear' ||\n             d.type === 'pageError' || d.type === 'download' || d.type === 'childLoad')) {\n          tellParent(d);\n        }\n      } catch (err) { }\n    }\n  });\n\n  /* ============================================================\n     Anti-tamper masking (v7) — integrity-checking runtimes\n     (YouTube-class \"[Patch failed]\") call fn.toString() on the\n     built-ins and bail when they see wrapper code. Report native\n     code for every patched surface. Detecting the mask itself\n     requires far deeper introspection than these runtimes do.\n     ============================================================ */\n  function nativize(fn, name) {\n    try {\n      Object.defineProperty(fn, 'toString', {\n        value: function () { return 'function ' + name + '() { [native code] }'; },\n        writable: true, configurable: true\n      });\n      try { Object.defineProperty(fn.toString, 'toString', { value: function () { return 'function toString() { [native code] }'; }, configurable: true }); } catch (e2) { }\n    } catch (e) { }\n  }\n  try {\n    if (window.__NO_MASK) return; [[window, 'fetch'], [window, 'Request'], [window, 'WebSocket'], [window, 'EventSource'],\n     [window, 'Worker'], [window, 'open'], [window, 'close'],\n     [XMLHttpRequest.prototype, 'open'],\n     [Element.prototype, 'setAttribute'], [Element.prototype, 'getAttribute'],\n     [Element.prototype, 'insertAdjacentHTML'],\n     [Document.prototype, 'write'], [Document.prototype, 'writeln'],\n     [history, 'pushState'], [history, 'replaceState'], [history, 'back'], [history, 'forward'], [history, 'go'],\n     [CSSStyleSheet.prototype, 'insertRule'], [CSSStyleSheet.prototype, 'addRule'],\n     [HTMLFormElement.prototype, 'submit']].forEach(function (p) {\n      try {\n        var v = p[0][p[1]];\n        if (typeof v === 'function') nativize(v, p[1]);\n      } catch (e) { }\n    });\n  } catch (e) { }\n\n  /* boot: neutralize refresh tags + adopt existing iframes */\n  killRefresh();\n  adoptFrames();\n\n  /* initial report — doubles as the \"hook is alive\" handshake */\n  tellNav({ phase: 'start' });\n})();\n";
const APP_VERSION = '8.0.0';
const PREFIX = '/service/';
const MAX_HOPS = 12;
const FIRST_BYTE_TIMEOUT = 30000; /* ms — cleared once headers arrive */
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
/* v7: MOBILE is the default identity — the client forwards its real
   UA (x-sw-ua / the browser's own header) and that wins when present,
   but the hardcoded fallback is a phone so sites like Amazon serve
   their mobile layout when the desktop-site toggle is OFF. */
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/* Headers never forwarded upstream */
const REQ_STRIP = new Set([
  'host', 'connection', 'cookie', 'referer', 'origin', 'user-agent', 'accept-encoding',
  'content-length', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'keep-alive',
  'proxy-connection', 'proxy-authenticate', 'proxy-authorization'
]);
/* Response headers never passed through (body is identity-decoded here) */
const RES_STRIP = new Set([
  'content-encoding', 'content-length', 'transfer-encoding', 'connection',
  'keep-alive', 'strict-transport-security', 'content-security-policy',
  'content-security-policy-report-only', 'x-frame-options', 'report-to',
  'nel', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'permissions-policy', 'feature-policy',
  'set-cookie', 'vary', 'server', 'x-powered-by', 'cf-ray', 'cf-cache-status',
  'alt-svc', 'link', 'expect-ct', 'timing-allow-origin'
]);

/* ---------------- runtime settings (pushed by the client) ---------------- */
const settings = { blockAds: true, uaHosts: new Set(), desktopDefault: false };

/* ---------------- ad / tracker blocklist ---------------- */
const BLOCKLIST = new Set((
  'google-analytics.com,googletagmanager.com,googlesyndication.com,googletagservices.com,' +
  'googleadservices.com,adservice.google.com,pagead2.googlesyndication.com,doubleclick.net,' +
  '2mdn.net,admob.com,adnxs.com,adnxs-simple.com,ads.yahoo.com,advertising.com,' +
  'amazon-adsystem.com,adcolony.com,adsafeprotected.com,adsrvr.org,adform.net,adition.com,' +
  'adnologies.com,adroll.com,adscale.de,adtechus.com,adtech.de,advertising.yieldmo.com,' +
  'an.yandex.ru,appsflyer.com,atdmt.com,analytics.tiktok.com,ads-twitter.com,branch.io,' +
  'casalemedia.com,chartbeat.com,chartbeat.net,clarity.ms,clicktale.net,criteo.com,criteo.net,' +
  'crwdcntrl.net,bluekai.com,exelator.com,tapad.com,everesttech.net,flashtalking.com,' +
  'frog.google.com,hotjar.com,hotjar.io,hs-analytics.net,infinityid.it,insightexpressai.com,' +
  'iponweb.com,krxd.net,ligatus.com,mathtag.com,media.net,mediaplex.com,met.vgwort.de,' +
  'mixpanel.com,moatads.com,mopub.com,nedstatbasic.com,nr-data.net,newrelic.com,' +
  'omtrdc.net,openx.net,optimizely.com,outbrain.com,parsely.com,pubmatic.com,quantserve.com,' +
  'reson8.com,rlcdn.com,rubiconproject.com,scorecardresearch.com,segment.io,segment.com,' +
  'serving-sys.com,sharethrough.com,smaato.net,smartadserver.com,sonobi.com,spotxchange.com,' +
  'stickyadstv.com,supplyframe.com,taboola.com,tremorhub.com,turn.com,undertone.com,' +
  'unrulymedia.com,upscore.com,yieldlab.net,yieldmo.com,zedo.com,zedo.co,' +
  'bat.bing.com,px.ads.linkedin.com,snap.licdn.com,analytics.google.com,ssl.google-analytics.com,' +
  'stats.g.doubleclick.net,ad.doubleclick.net,googleads.g.doubleclick.net,' +
  'cdn.onesignal.com,onesignal.com,pushwoosh.com,parse.com,amplitude.com,amplitudejs.com,' +
  'heapanalytics.com,kissmetrics.com,kissmetrics.io,mouseflow.com,luckyorange.com,' +
  'fullstory.com,inspectlet.com,crazyegg.com,clicdata.com,clicky.com,statcounter.com,' +
  'histats.com,quantcount.com,comscore.com,scorecardresearch.net,visualwebsiteoptimizer.com,' +
  'vwo.com,contentsquare.net,contentsquare.com,abtasty.com,kameleoon.com,omniture.com,' +
  'webtrends.com,webtrekk.net,etracker.de,piwik.pro,matomo.cloud,stats.wp.com,' +
  'pixel.facebook.com,an.facebook.com,connect.facebook.net,graph.facebook.com,' +
  'ads.facebook.com,analytics.facebook.com,ads-twitter.net,static.ads-twitter.com,' +
  'analytics.snapchat.com,sc-static.net,snap.licdn.com,px.linkedin.com,' +
  'tags.tiqcdn.com,assets.adobedtm.com,cdn.tt.omtrdc.net,dpm.demdex.net,' +
  'cm.everesttech.net,sm.demdex.net,eid.rubiconproject.com,match.adsrvr.org,' +
  'rtb-csync.smartadserver.com,sync.adaptv.advertising.com,x.bidswitch.net,' +
  'sb.scorecardresearch.com,b.scorecardresearch.com,ade.googlesyndication.com,' +
  'tpc.googlesyndication.com,pagead2.googleadservices.com,www.googleadservices.com,' +
  'app-measurement.com,firebaseinstallations.googleapis.com,app-analytics-services.com,' +
  'doubleverify.com,doubleverify.net,moat.com,moatpixel.com,adsymptotic.com,' +
  'ads.yieldlab.net,spot.im,taboola.map.fastly.net'
).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

function hostBlocked(hostname) {
  if (!settings.blockAds) return false;
  const h = hostname.toLowerCase();
  if (BLOCKLIST.has(h)) return true;
  const parts = h.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (BLOCKLIST.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

/* ============================================================
   Cookie jar — server-side style cookie emulation keyed by the
   REAL upstream origin. Lives in isolate memory; the standalone
   client re-seeds it from localStorage via POST /jar.
   ============================================================ */
class CookieJar {
  constructor() { this.store = new Map(); this.lines = new Map(); }

  static domainMatch(host, domain) {
    return host === domain || host.endsWith('.' + domain);
  }
  static defaultPath(pathname) {
    const i = pathname.lastIndexOf('/');
    return i <= 0 ? '/' : pathname.slice(0, i);
  }
  static pathMatch(reqPath, cPath) {
    if (reqPath === cPath) return true;
    return reqPath.indexOf(cPath) === 0 &&
      (cPath.endsWith('/') || reqPath.charAt(cPath.length) === '/');
  }

  setFromHeader(urlStr, rawLine, fromScript) {
    try {
      const u = new URL(urlStr);
      const parts = rawLine.split(';');
      const nv = parts[0];
      const eq = nv.indexOf('=');
      if (eq < 0) return;
      const name = nv.slice(0, eq).trim();
      let value = nv.slice(eq + 1).trim();
      if (!name) return;
      const c = {
        name, value,
        domain: u.hostname.toLowerCase(),
        hostOnly: true,
        path: CookieJar.defaultPath(u.pathname),
        expires: 0, secure: false, httpOnly: false
      };
      for (let i = 1; i < parts.length; i++) {
        const p = parts[i].trim();
        const peq = p.indexOf('=');
        const key = (peq < 0 ? p : p.slice(0, peq)).trim().toLowerCase();
        const val = peq < 0 ? '' : p.slice(peq + 1).trim();
        if (key === 'domain' && val) {
          let d = val.toLowerCase().replace(/^\./, '');
          if (!CookieJar.domainMatch(u.hostname.toLowerCase(), d)) return; /* invalid */
          c.domain = d; c.hostOnly = false;
        } else if (key === 'path' && val) {
          c.path = val.charAt(0) === '/' ? val : c.path;
        } else if (key === 'expires') {
          const t = Date.parse(val);
          if (!isNaN(t)) c.expires = t;
        } else if (key === 'max-age') {
          const n = parseInt(val, 10);
          if (!isNaN(n)) c.expires = Date.now() + n * 1000;
        } else if (key === 'secure') {
          c.secure = true;
        } else if (key === 'httponly') {
          c.httpOnly = true;
        }
      }
      if (fromScript) c.httpOnly = false;
      if (c.secure && u.protocol !== 'https:') return;
      const key = this.key(c);
      if (c.expires && c.expires <= Date.now()) {
        this.store.delete(key); this.lines.delete(key); return;
      }
      this.store.set(key, c);
      this.lines.set(key, { u: urlStr, c: rawLine });
    } catch (e) { /* malformed cookie — ignore */ }
  }

  key(c) { return c.name + '|' + c.domain + '|' + c.path; }

  headerFor(urlStr, includeHttpOnly) {
    try {
      const u = new URL(urlStr);
      const host = u.hostname.toLowerCase();
      const path = u.pathname || '/';
      const now = Date.now();
      const out = [];
      for (const c of this.store.values()) {
        if (c.expires && c.expires <= now) continue;
        if (c.httpOnly && !includeHttpOnly) continue;
        if (c.hostOnly ? (host !== c.domain) : !CookieJar.domainMatch(host, c.domain)) continue;
        if (!CookieJar.pathMatch(path, c.path)) continue;
        if (c.secure && u.protocol !== 'https:') continue;
        out.push(c);
      }
      out.sort((a, b) => b.path.length - a.path.length);
      return out.map(c => c.name + '=' + c.value).join('; ');
    } catch (e) { return ''; }
  }

  toLines() {
    const out = [];
    for (const { u, c } of this.lines.values()) out.push({ u, c });
    return out;
  }

  clear() { this.store.clear(); this.lines.clear(); }
}
const jar = new CookieJar();

/* ---------------- base64url codec ---------------- */
function b64e(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64d(str) {
  try {
    let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch (e) { return ''; }
}

/* ---------------- URL helpers ---------------- */
const SKIP_SCHEME = /^(data:|blob:|javascript:|about:|mailto:|tel:|sms:|magnet:|intent:|market:|itms-apps?:|ftp:|chrome:|chrome-extension:|moz-extension:|file:|superwork:)/i;

function resolveUrl(u, base) {
  try { return new URL(u, base); } catch (e) { return null; }
}

/* Rewrite a URL found in markup into the /service/ namespace.
   v5: ALWAYS absolute (worker origin prefixed) — the client
   renders pages via srcdoc, so relative /service/ paths would
   resolve against the wrong base. Returns the ORIGINAL string
   when rewriting is not applicable. */
function rwUrl(u, base, origin) {
  if (typeof u !== 'string') return u;
  const s = u.trim();
  if (!s || s.charCodeAt(0) === 35 && s.length <= 1) return u;
  if (s.indexOf(PREFIX) === 0) return u;
  if (SKIP_SCHEME.test(s)) return u;
  const abs = resolveUrl(s, base);
  if (!abs) return u;
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;
  if (abs.pathname.indexOf(PREFIX) === 0) return u; /* already proxied */
  return (origin || '') + PREFIX + b64e(abs.href);
}

/* Decode an attr value that may contain entities before resolving. */
function entDecode(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#0*38;|&amp;/g, '&');
}
function entEncode(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ============================================================
   CSS rewriter
   ============================================================ */
function rewriteCss(css, base, origin) {
  if (!css) return css;
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      const r = rwUrl(entDecode(u), base, origin);
      return r === u ? m : 'url(' + q + entEncode(r) + q + ')';
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
      const r = rwUrl(entDecode(u), base, origin);
      return r === u ? m : '@import ' + q + entEncode(r) + q;
    })
    .replace(/(?:-webkit-)?image-set\(\s*([^)]*)\)/gi, (m, inner) => {
      const r = inner.replace(/(['"]?)([^'"\s,]+)\1(\s+[\d.]+[wx])/g, (mm, q2, u, d) => {
        const rr = rwUrl(entDecode(u), base, origin);
        return rr === u ? mm : q2 + entEncode(rr) + q2 + d;
      });
      return r === inner ? m : m.replace(inner, r);
    });
}

/* ============================================================
   JS rewriter — Pass B only (location/top/parent/document shims).
   String-literal rewriting was deliberately removed (corrupts
   regexes and constants); runtime hooks cover real URL flows.
   ============================================================ */
const JS_MIME = /^(|application\/(x-)?javascript|text\/(javascript|jscript|ecmascript)|module)$/i;

/* v8.1: split JS into CODE and STRING segments (', ", ``, with escapes;
   template ${…} interiors and comments count as code). Every semantic
   rewrite below runs on CODE segments only — string payloads must
   survive byte-identical. This is what Next.js needs: the App Router
   streams React flight data through inline script STRINGS, and any
   string mutation (a rewritten location.reload(), an import URL…)
   corrupts the payload → hydration mismatch (#418) → the client
   regenerates from broken data → "Loading…" forever.
   v8.1 SCANNER FIX: the v8 scanner only knew quotes — a quote inside a
   REGEX literal (`/"[/]/g`) or a COMMENT (`// don't`) opened a phantom
   string that swallowed tens of KB of code (Apple's localeswitcher:
   56% of the file), silently skipping EVERY location rewrite — the
   page then assigned the REAL window.location, escaped the proxy and
   died (apple.com's dead region/menu buttons). The scanner now
   tokenizes regex literals (division-vs-regex disambiguation by
   previous significant token + keyword set) and consumes comments
   whole. Byte-exactness is guaranteed on every path (verified:
   roundtrip EXACT + segment-identical vs a reference scanner on
   Apple/Next.js/popwatch/React bundles); a scan that hits an exotic
   construct still degrades gracefully — bytes are never altered, at
   worst a region is marked string and its rewrites are skipped
   (runtime hooks still cover the real URL flows). */
function jsCodeSegments(src) {
  const segs = [];
  let buf = '';
  let i = 0;
  const n = src.length;
  const flushCode = () => { if (buf) { segs.push([buf, 1]); buf = ''; } };

  /* division-vs-regex context: last significant char + trailing word */
  let lastSig = '';
  let lastWord = '';
  const KW_RE = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new',
    'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
  function regexAllowed() {
    if (lastSig === '') return true;
    if (lastSig === ')' || lastSig === ']') return false;
    if (/[A-Za-z0-9_$]/.test(lastSig)) return KW_RE.has(lastWord);
    return true;
  }
  function noteTail(s) {
    for (let k = s.length - 1; k >= 0 && k >= s.length - 16; k--) {
      const c = s[k];
      if (/\s/.test(c)) continue;
      lastSig = c;
      if (/[A-Za-z0-9_$]/.test(c)) {
        let w = '';
        for (let m = k; m >= 0 && /[A-Za-z0-9_$]/.test(s[m]) && w.length < 12; m--) w = s[m] + w;
        lastWord = w;
      } else lastWord = '';
      return;
    }
  }

  /* bulk-scan to the next structurally significant char (worker CPU) */
  const SPECIAL = /[`'"\\/]/g;

  while (i < n) {
    SPECIAL.lastIndex = i;
    const hit = SPECIAL.exec(src);
    if (!hit) { buf += src.slice(i); i = n; break; }
    const at = hit.index;
    if (at > i) {
      const bulk = src.slice(i, at);
      buf += bulk;
      noteTail(bulk);
      i = at;
    }
    const c = src[i];

    /* comments — consumed whole; a quote inside must never open a string */
    if (c === '/' && src[i + 1] === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      buf += src.slice(i, j); i = j; lastSig = ';'; lastWord = ''; continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      let j = src.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      buf += src.slice(i, j); i = j; lastSig = ';'; lastWord = ''; continue;
    }

    /* strings (raw newline terminates — same as real JS for ' and ") */
    if (c === "'" || c === '"') {
      flushCode();
      let j = i + 1, s = c;
      while (j < n) {
        if (src[j] === '\\') { s += src[j] + (src[j + 1] || ''); j += 2; continue; }
        s += src[j];
        if (src[j] === c || src[j] === '\n') { j++; break; }
        j++;
      }
      segs.push([s, 0]);
      i = j;
      lastSig = '"'; lastWord = '';
      continue;
    }

    /* template literals — text is string, ${…} interiors are code */
    if (c === '`') {
      flushCode();
      buf = '`'; i++;
      while (i < n) {
        if (src[i] === '\\') { buf += src[i] + (src[i + 1] || ''); i += 2; continue; }
        if (src[i] === '`') { buf += '`'; i++; break; }
        if (src[i] === '$' && src[i + 1] === '{') {
          i += 2;
          let depth = 1, inner = '';
          while (i < n && depth > 0) {
            const cc = src[i];
            if (cc === '\\') { inner += src[i] + (src[i + 1] || ''); i += 2; continue; }
            if (cc === '{') depth++;
            else if (cc === '}') { depth--; if (depth === 0) { i++; break; } }
            inner += cc; i++;
          }
          if (buf) { segs.push([buf, 0]); buf = ''; }
          segs.push(['${' + inner + '}', 1]);
          continue;
        }
        buf += src[i]; i++;
      }
      if (buf) { segs.push([buf, 0]); buf = ''; }
      lastSig = '"'; lastWord = '';
      continue;
    }

    /* regex literal (when context allows) — quotes inside stay inert */
    if (c === '/' && regexAllowed()) {
      let j = i + 1, inClass = false, re = '/', closed = false;
      while (j < n) {
        const rc = src[j];
        if (rc === '\\') { re += src[j] + (src[j + 1] || ''); j += 2; continue; }
        if (rc === '\n') break;
        if (rc === '[') inClass = true;
        else if (rc === ']') inClass = false;
        else if (rc === '/' && !inClass) { re += '/'; j++; closed = true; break; }
        re += rc; j++;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(src[j])) { re += src[j]; j++; }
        buf += re; i = j;
        lastSig = '0'; lastWord = '';
        continue;
      }
      buf += '/'; i++;
      lastSig = '/'; lastWord = '';
      continue;
    }

    /* plain division slash */
    buf += '/'; i++;
    lastSig = '/'; lastWord = '';
  }
  flushCode();
  return segs;
}

function mapCodeSegments(src, fn) {
  if (!src) return src;
  const segs = jsCodeSegments(src);
  let out = '';
  let prevCode = null;
  for (const [s, isCode] of segs) {
    if (isCode) { prevCode = fn(s); out += prevCode; }
    else { out += s; prevCode = null; }
  }
  return out;
}

function rewriteJs(src, base, origin) {
  if (!src) return src;
  try {
    /* v8: rewrites are applied per CODE segment — never inside string
       or template-literal payloads (see jsCodeSegments). Some patterns
       span a code/string boundary (e.g. `location["x"]` stays intact),
       which is the price of payload safety; the runtime hook covers
       everything the text pass misses. */
    src = mapCodeSegments(src, (code) => code
      .replace(/\bwindow\s*\.\s*top\s*\.\s*location\s*\./g, '__swloc.')
      .replace(/\bwindow\s*\.\s*top\s*\.\s*location\s*\[/g, '__swloc[')
      .replace(/\bwindow\s*\.\s*top\s*\.\s*location\s*=(?!=)/g, '__swloc.href =')
      .replace(/\bwindow\s*\.\s*parent\s*\.\s*location\s*\./g, '__swloc.')
      .replace(/\bwindow\s*\.\s*parent\s*\.\s*location\s*\[/g, '__swloc[')
      .replace(/\bwindow\s*\.\s*parent\s*\.\s*location\s*=(?!=)/g, '__swloc.href =')
      .replace(/(?<![.\w$])top\s*\.\s*location\s*\./g, '__swloc.')
      .replace(/(?<![.\w$])top\s*\.\s*location\s*\[/g, '__swloc[')
      .replace(/(?<![.\w$])top\s*\.\s*location\s*=(?!=)/g, '__swloc.href =')
      .replace(/(?<![.\w$])parent\s*\.\s*location\s*\./g, '__swloc.')
      .replace(/(?<![.\w$])parent\s*\.\s*location\s*\[/g, '__swloc[')
      .replace(/(?<![.\w$])parent\s*\.\s*location\s*=(?!=)/g, '__swloc.href =')
      .replace(/(?<![.\w$])(?:window|document|self|globalThis)\s*\.\s*location\s*\./g, '__swloc.')
      .replace(/(?<![.\w$])(?:window|document|self|globalThis)\s*\.\s*location\s*\[/g, '__swloc[')
      .replace(/(?<![.\w$])(?:window|document|self|globalThis)\s*\.\s*location\s*=(?!=)/g, '__swloc.href =')
      .replace(/(?<![.\w$])location\s*\./g, '__swloc.')
      .replace(/(?<![.\w$])location\s*\[/g, '__swloc[')
      .replace(/(?<![.\w$])location\s*=(?!=)/g, '__swloc.href =')
      .replace(/\bwindow\s*\.\s*top\b/g, 'window.self')
      .replace(/\bwindow\s*\.\s*parent\b/g, 'window.self')
      /* optional-chained member access (runs before the value rule) */
      .replace(/\b(?:window|self|globalThis)\s*\.\s*location\s*\?\./g, '__swloc?.')
      /* v8: VALUE-position location — `location: window.location` in a
         call (Next.js createInitialRouterState), `let l = window.location`
         (MPA navigation), equality checks. window.location is unforgeable
         and cannot be property-shimmed, and its REAL value here is
         about:srcdoc — routers read .pathname from it ('srcdoc') and wedge
         the whole client tree. Earlier patterns above already consumed
         member/call/assignment positions; what remains is value position,
         which the shim object serves perfectly (all URL part getters +
         assign/replace/reload + toString). */
      .replace(/\b(?:window|self|globalThis)\s*\.\s*location\b(?!\s*[.=(?:[])/g, '__swloc')
      .replace(/\bdocument\s*\.\s*URL\b/g, '__swloc.href')
      .replace(/\bdocument\s*\.\s*baseURI\b/g, '__swloc.href')
      .replace(/\bdocument\s*\.\s*domain\b/g, '__swdoc.domain'));
    /* v7: destructuring-from-window that binds top/parent — the ONE
       access pattern no literal rewriter covers. `{top:o,self:t}=window`
       becomes `{top:o,self:t}=__swDest()` (a hook-provided object whose
       top/parent are self). Key-position check ({ or , before the name,
       : or , or } after) avoids rewriting value-position identifiers. */
    src = src.replace(/(\{[^{}]*\})\s*=\s*window\b/g, (m, lhs) => {
      if (!/[{,]\s*(?:top|parent)\s*[:,}]/.test(lhs)) return m;
      return lhs + ' = __swDest()';
    });
    src = src.replace(/(\(\s*\{[^{}]*\}\s*\))\s*=\s*window\b/g, (m, lhs) => {
      if (!/[{,]\s*(?:top|parent)\s*[:,}]/.test(lhs)) return m;
      return lhs + ' = __swDest()';
    });
    /* v8: destructuring location — `const {pathname} = location` /
     `let {href, search} = window.location` reads the REAL
     about:srcdoc URL (pathname 'srcdoc') because no dot-suffix
     pattern can catch a binding. Next.js routers push that garbage
     into history and wedge the client tree. Both bare and
     window/self/globalThis-qualified forms are rewritten to the
     hook's __swlocParts() which carries the REAL page URL parts. */
    src = src.replace(/(\{[^{}]*\})\s*=\s*(?:window\s*\.\s*|self\s*\.\s*|globalThis\s*\.\s*)?location\b/g, (m, lhs) => {
      if (!/[{,]\s*(?:href|protocol|host|hostname|port|pathname|search|hash|origin|assign|replace|reload)\s*[:,}]/.test(lhs)) return m;
      return lhs + ' = __swlocParts()';
    });
    /* module import specifiers (relative + absolute http(s) only).
       v8: `\bimport\s+` missed MINIFIED bare side-effect imports
       (import"./x.js" — no space). Apple's homepage bundles, webpack
       and Rollup all emit them; one missed specifier kills the whole
       module graph (blank tiles, dead SPAs). `\bimport\s*` covers
       import"…", import "…", import(…) and from"…" uniformly.
       The specifier STRING is rewritten on purpose — this is the one
       place strings must change (the module loader fetches them
       verbatim); surrounding serialized code inside OTHER strings is
       untouched because the pattern requires from/import syntax in
       code position... note this pass runs on the FULL source (the
       from/import keywords live in code; the quoted specifier is
       consumed by the same match). */
    src = src
      .replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)(['"])(\.\/[^'"]+|\.\/|\/[^'"]+|https?:\/\/[^'"]+)\2/g,
        (m, pre, q, spec) => {
          const abs = resolveUrl(spec, base);
          if (!abs || (abs.protocol !== 'http:' && abs.protocol !== 'https:')) return m;
          return pre + q + (origin || '') + PREFIX + b64e(abs.href) + q;
        });
    /* v8: import.meta.url — module code resolves runtime asset paths
       against it (new URL('/assets/worker.js', import.meta.url),
       webpack/turbopack chunk bases). Under the proxy it is the
       /service/ URL of the worker ORIGIN, so root-relative specifiers
       land on the proxy host (workers then 400 on self-loop, chunk
       URLs break). Replace with the REAL module URL as a string
       literal — every later resolution then produces a real URL that
       the runtime rewriting surfaces (src setters, fetch, MO) proxy
       correctly. Only the exact `import.meta.url` sequence in CODE
       position is touched (string payloads keep it verbatim). */
    try {
      if (src.indexOf('import.meta.url') >= 0) {
        src = mapCodeSegments(src, (code) =>
          code.replace(/import\.meta\.url/g, () => JSON.stringify(base)));
      }
    } catch (e2) { /* keep */ }
  } catch (e) { /* keep partial result */ }
  return src;
}

/* ============================================================
   HTML rewriter — quote-aware tag scanner (server-side).
   Rewrites URL-bearing attributes, strips CSP/base/integrity,
   injects the runtime hook with per-site config.
   ============================================================ */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background',
  'cite', 'longdesc', 'manifest', 'archive', 'codebase', 'classid', 'profile', 'ping', 'icon',
  'xlink:href', 'data-href', 'data-url', 'data-background-url']);
const DROP_ATTRS = new Set(['integrity', 'nonce', 'referrerpolicy', 'charset']);
/* v7: `crossorigin` is deliberately KEPT — scripts/links loaded in
   CORS mode surface their real error messages to window.onerror
   (instead of the opaque "Script error."), and font preloads only
   match their later CORS fetches when the attribute is intact.
   Every proxied response carries ACAO:* so CORS mode always
   succeeds. `integrity` stays stripped: SRI can never pass on
   rewritten content. */
/* v7: lazy-loading data-* families (data-src on lazy images is the
   most common reason "graphics don't pop up" on JS-heavy sites).
   Rewritten exactly like src so lazyloaders that copy data-src → src
   get an already-proxied absolute URL. */
const DATA_URL_ATTRS = new Set([
  'data-src', 'data-srcset', 'data-original', 'data-original-src', 'data-lazy',
  'data-lazy-src', 'data-lazy-srcset', 'data-echo', 'data-image', 'data-img',
  'data-thumb', 'data-thumbnail', 'data-poster', 'data-bg', 'data-background',
  'data-background-image', 'data-original-background', 'data-ll-url', 'data-lazyload'
]);

function safeJsonInline(v) {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/* find end of a tag honoring quoted attribute values */
function tagEnd(html, from) {
  let q = null;
  for (let i = from; i < html.length; i++) {
    const ch = html[i];
    if (q) { if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '>') return i;
  }
  return -1;
}

function rewriteHtml(html, baseUrl, cfg, origin) {
  let inject = '<script>__SWCFG=' + safeJsonInline(cfg) + ';</script>\n<script>' +
    HOOK_JS.replace(/<\/script/gi, '<\\/script') + '</script>\n';

  /* v8: Next.js (Turbopack) support — the chunk loader builds chunk
     URLs as BASE + name, defaulting BASE to '/_next/', and keys its
     pending-chunk map by that EXACT string; registerChunk later
     resolves the same key using the raw src attribute of the chunk
     script. Under the proxy the HTML script srcs are absolute
     /service/ URLs, so a root-relative base can never match and the
     boot promise stalls forever — SSR markup renders, but every
     interactive function on the page is silently dead (search,
     menus, navigation). Point the base at the site's REAL absolute
     /_next/ path: loader keys, the raw-src keys and our runtime
     src-rewriting then agree end to end. Derived from the page's own
     _next references (respects custom basePaths); injected before
     any site script; a site-provided definition still wins later. */
  try {
    if (html.indexOf('_next') >= 0) {
      const bm = /(?:https?:\/\/[^"'\s]+)?(\/[^"'\s]*)?\/_next\/static\//.exec(html);
      const basePath = bm ? (bm[1] || '') + '/_next' : '/_next';
      const abs = new URL(basePath + '/', baseUrl).href;
      inject += '<script>if(typeof self.TURBOPACK_CHUNK_BASE_PATH==="undefined")' +
        'self.TURBOPACK_CHUNK_BASE_PATH=' + JSON.stringify(abs) + ';</script>\n';
    }
  } catch (e) { /* non-_next page — nothing to do */ }

  /* v8.1: whole-document hydration. React 19 + the Next.js App Router
     hydrate the ENTIRE document (hydrateRoot(document) — <html> is part of
     the client tree). ANY node we inject into <head> is a structural
     hydration mismatch → React error #418 → the tree is regenerated on the
     client → the regeneration stalls → the page sits as a dead SSR shell
     (popwatch.to class of bugs). Detect this app class and inject at the
     END of <body> instead — trailing body nodes are the classic
     third-party-script position and React tolerates them.
     async site scripts are rewritten to defer: defer scripts execute
     strictly AFTER parse in document order, so they can never win the race
     against our (parse-time) hook — async scripts could. */
  const docHydrate = /__next_f|\$RC\(/.test(html);
  const injectAtBodyEnd = docHydrate;

  let out = '';
  let i = 0;
  const n = html.length;
  let injected = false;

  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { out += html.slice(i); break; }
    out += html.slice(i, lt);

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      const stop = end < 0 ? n : end + 3;
      out += html.slice(lt, stop);
      i = stop;
      continue;
    }

    const gt = tagEnd(html, lt + 1);
    if (gt < 0) { out += html.slice(lt); break; }
    let tagText = html.slice(lt, gt + 1);
    const after = gt + 1;
    i = after;

    const m = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagText);
    if (!m) { out += tagText; continue; }
    const closing = m[1] === '/';
    let tag = m[2].toLowerCase();

    /* inject hook right after <head> (or before <body>/<script> fallback) */
    if (!injected) {
      if (!closing && !injectAtBodyEnd && (tag === 'head' || tag === 'body' || tag === 'script')) {
        out += tagText + inject;
        injected = true;
        continue;
      }
    }
    /* v8.1 doc-hydrate pages: inject before </body> (trailing-body position) */
    if (!injected && injectAtBodyEnd && closing && tag === 'body') {
      out += inject + tagText;
      injected = true;
      continue;
    }

    /* <base> interferes with service-path resolution — drop it */
    if (tag === 'base' && !closing) { out += ''; continue; }

    if (tag === 'meta' && !closing) {
      const attrs = parseAttrs(tagText);
      const heq = (attrs.get('http-equiv') || '').toLowerCase();
      if (heq === 'content-security-policy' || heq === 'content-security-policy-report-only') continue;
      /* meta refresh: left UNREWRITTEN on purpose — the runtime hook
         neutralizes it and relays the navigation through the app's
         fetch pipeline (an iframe navigation would be blocked by
         network filters that only allow API requests). */
      if (heq === 'referrer') continue; /* keep full referrers flowing */
      const nm = (attrs.get('name') || '').toLowerCase();
      if (nm === 'referrer') continue;
      if ((attrs.get('charset') || '').toLowerCase().replace(/-/g, '') !== 'utf8' &&
          attrs.has('charset')) {
        out += '<meta charset="utf-8">';
        continue;
      }
      out += tagText;
      continue;
    }

    if (closing) { out += tagText; continue; }

    /* raw-text elements: capture body until the closing tag */
    if (tag === 'script' || tag === 'style') {
      const closeRe = new RegExp('</\\s*' + tag + '\\s*>', 'i');
      const rest = html.slice(after);
      const cm = closeRe.exec(rest);
      let rawEnd = cm ? after + cm.index : n;
      let raw = html.slice(after, rawEnd);
      const attrs = parseAttrs(tagText);
      /* v8.1 doc-hydrate: async site scripts can execute DURING parse —
         before our body-end hook installs its patches. defer scripts run
         strictly after parse in document order, so the hook (inline, at
         body end) is always first. An async→defer attribute change is not
         a structural mismatch — React 19 hydration recovers attribute
         diffs without #418. */
      if (docHydrate && tag === 'script' && attrs.has('async')) {
        attrs.delete('async');
        attrs.set('defer', null); /* bare boolean attr */
      }
      const newTag = rewriteTag(tag, attrs, baseUrl, tagText, origin);
      out += newTag;
      if (tag === 'style') {
        out += rewriteCss(raw, baseUrl, origin);
      } else {
        const type = (attrs.get('type') || '').toLowerCase();
        const isJs = !type || JS_MIME.test(type);
        out += isJs ? rewriteJs(raw, baseUrl, origin) : raw;
      }
      out += html.slice(rawEnd, cm ? rawEnd + cm[0].length : n);
      i = cm ? rawEnd + cm[0].length : n;
      continue;
    }

    /* regular tag */
    const attrs = parseAttrs(tagText);
    out += rewriteTag(tag, attrs, baseUrl, tagText, origin);
  }

  if (!injected) {
    /* doc-hydrate fragment without </body>: appending at the very end is
       the closest hydration-safe equivalent of the trailing-body position */
    out += inject;
  }
  return out;
}

/* parse attributes of a tag text into a Map (decoded values) */
function parseAttrs(tagText) {
  const map = new Map();
  const re = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*)))?/g;
  let m;
  const body = tagText.replace(/^<\s*\/?\s*[a-zA-Z][a-zA-Z0-9-]*/, '').replace(/>$/, '');
  while ((m = re.exec(body))) {
    const name = m[1].toLowerCase();
    const val = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : (m[4] !== undefined ? m[4] : null));
    map.set(name, val);
  }
  return map;
}

/* rebuild a tag with rewritten attributes.
   v8 ENTITY RULE: parseAttrs captures attribute values in their SOURCE
   form — still entity-encoded ({&quot;…&quot;} stays {&quot;…&quot;}). Any value we
   do NOT touch must be re-emitted VERBATIM; running it through
   entEncode double-escapes (&quot; → &amp;quot;) and corrupts every
   data-* JSON payload on the page (Apple's globalnav data-strings
   crashed JSON.parse → dead menu; any site with JSON in attributes
   breaks the same way). Only values we actually REWRITE go through
   decode → transform → fresh entEncode. */
function rewriteTag(tag, attrs, baseUrl, origTagText, origin) {
  const parts = [];
  const srcsetAttrs = new Set(['srcset', 'imagesrcset']);

  for (const [name, rawVal] of attrs) {
    if (DROP_ATTRS.has(name)) continue;

    /* event handlers → JS rewrite (decode first — the value is
       entity-encoded source text) */
    if (name.startsWith('on') && rawVal) {
      parts.push(name + '="' + entEncode(rewriteJs(entDecode(rawVal), baseUrl, origin)) + '"');
      continue;
    }
    if (name === 'style' && rawVal) {
      parts.push('style="' + entEncode(rewriteCss(entDecode(rawVal), baseUrl, origin)) + '"');
      continue;
    }
    if (srcsetAttrs.has(name) && rawVal) {
      const rewritten = entDecode(rawVal).split(/,\s+/).map(part => {
        if (/^\s*data:/i.test(part)) return part;
        const sp = part.trim().split(/\s+/);
        sp[0] = rwUrl(sp[0], baseUrl, origin);
        return sp.join(' ');
      }).join(', ');
      parts.push(name + '="' + entEncode(rewritten) + '"');
      continue;
    }
    if (DATA_URL_ATTRS.has(name) && rawVal) {
      /* srcset-shaped variants get candidate-list rewriting */
      if (/srcset/i.test(name)) {
        const rewritten = entDecode(rawVal).split(/,\s+/).map(part => {
          if (/^\s*data:/i.test(part)) return part;
          const sp = part.trim().split(/\s+/);
          sp[0] = rwUrl(sp[0], baseUrl, origin);
          return sp.join(' ');
        }).join(', ');
        parts.push(name + '="' + entEncode(rewritten) + '"');
        continue;
      }
      /* css url() values (data-bg etc.) get the CSS pass */
      if (/url\(/i.test(rawVal)) {
        parts.push(name + '="' + entEncode(rewriteCss(entDecode(rawVal), baseUrl, origin)) + '"');
        continue;
      }
      const r = rwUrl(entDecode(rawVal), baseUrl, origin);
      parts.push(name + '="' + entEncode(r) + '"');
      continue;
    }
    if (name === 'target') {
      const t = String(rawVal || '').toLowerCase();
      if (t === '_top' || t === '_parent') { parts.push('target="_self"'); continue; }
      parts.push(emitVerbatim(name, rawVal));
      continue;
    }
    if (name === 'sandbox') {
      /* v7: `allow-same-origin` on a child of our OPAQUE parent keeps
         the child attached to the app's real window.top — site code
         reading top.location (BBC/CNN dotcom, ad stacks) then hits a
         cross-origin SecurityError that blanks the whole page.
         Removing the token leaves the child inheriting the parent's
         sandbox: opaque AND detached (top === self), exactly like
         the main frame. An empty remainder drops the attribute
         entirely (a bare sandbox="" would disable scripts). */
      if (tag === 'iframe' && rawVal) {
        const kept = String(rawVal).split(/\s+/).filter(t => t && t.toLowerCase() !== 'allow-same-origin');
        if (kept.length) parts.push('sandbox="' + entEncode(kept.join(' ')) + '"');
        continue;
      }
      parts.push(emitVerbatim('sandbox', rawVal || ''));
      continue;
    }
    if (URL_ATTRS.has(name) && rawVal) {
      if (tag === 'object' && name === 'data' && !/^\s*data:/i.test(rawVal)) {
        const r = rwUrl(entDecode(rawVal), baseUrl, origin);
        parts.push('data="' + entEncode(r) + '"');
        continue;
      }
      /* v8: preconnect/dns-prefetch links are KEPT (v7 dropped them) —
         React 19 hydrates <link> hoistables; a missing node is a
         hydration mismatch (#418). Their rewritten href just points
         at the proxy origin, which is where every connection goes
         anyway. */
      const r = rwUrl(entDecode(rawVal), baseUrl, origin);
      parts.push(name + '="' + entEncode(r) + '"');
      /* v8: the v7 crossorigin="anonymous" addition is REMOVED —
         React 19 (Next.js App Router) hydrates the SSR <script> tags
         as part of the tree, and an extra attribute the server never
         rendered is a hydration mismatch (#418) that kills the whole
         client tree. Script errors still surface: the hook's error
         relay reads e.target, and our /service/ responses carry
         ACAO:* for the sites that set crossorigin themselves. */
      continue;
    }
    /* untouched value: emit VERBATIM (see the v8 ENTITY RULE above).
       Quote style follows the value: a value captured from a
       single-quoted attribute may contain a literal double quote —
       re-wrapping in " would truncate the tag, so pick the safe
       quote character instead of entity-escaping. */
    if (rawVal === null || rawVal === undefined) { parts.push(name); continue; }
    parts.push(emitVerbatim(name, rawVal));
  }

  return '<' + tag + (parts.length ? ' ' + parts.join(' ') : '') + '>';
}

/* verbatim attribute emission — no entity round-trip */
function emitVerbatim(name, rawVal) {
  const v = String(rawVal);
  const q = v.indexOf('"') >= 0 ? "'" : '"';
  return name + '=' + q + v + q;
}

/* rewrite srcdoc content (recursive, sync-safe quick rewrite) */
function rewriteSrcdoc(html, baseUrl, origin) {
  let out = '';
  const re = /\s(?:src|href|action|srcset|data-src)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let last = 0, m;
  while ((m = re.exec(html))) {
    out += html.slice(last, m.index);
    const q = m[2] !== undefined ? '"' : "'";
    const val = m[2] !== undefined ? m[2] : m[3];
    const dec = entDecode(val);
    let r;
    if (/^srcset$/i.test(m[1])) {
      r = dec.split(/,\s+/).map(function (part) {
        if (/^\s*data:/i.test(part)) return part;
        const sp = part.trim().split(/\s+/);
        const rr = rwUrl(sp[0], baseUrl, origin);
        if (rr !== sp[0]) sp[0] = rr;
        return sp.join(' ');
      }).join(', ');
    } else {
      r = rwUrl(dec, baseUrl, origin);
    }
    out += ' ' + m[1] + '=' + q + (r !== dec ? entEncode(r) : val) + q;
    last = re.lastIndex;
  }
  out += html.slice(last);
  return out;
}

/* ============================================================
   Chrome-style error pages
   ============================================================ */
function errPage(code, host, detail, targetUrl) {
  const h = entEncode(host || '');
  const t = entEncode(targetUrl || '');
  const d = entEncode(detail || '');
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>' + code + '</title><style>' +
    'body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#202124;background:#fff;display:flex;min-height:100vh;align-items:center;justify-content:center}' +
    '@media(prefers-color-scheme:dark){body{background:#202124;color:#e8eaed}}' +
    '.wrap{max-width:560px;padding:32px;text-align:-webkit-center}' +
    '.face{font-size:56px;line-height:1;margin-bottom:24px}' +
    'h1{font-size:22px;font-weight:400;margin:0 0 16px}' +
    'p{font-size:15px;line-height:1.55;color:#5f6368;margin:0 0 8px;text-align:left}' +
    '@media(prefers-color-scheme:dark){p{color:#9aa0a6}}' +
    '.code{font-size:13px;color:#80868b;margin:16px 0 24px;text-align:left;font-family:ui-monospace,Menlo,monospace}' +
    '.btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap}' +
    'button,a.btn{appearance:none;border:1px solid #dadce0;background:#1a73e8;color:#fff;border-radius:4px;padding:8px 22px;font-size:14px;cursor:pointer;text-decoration:none;display:inline-block}' +
    'a.btn.alt,button.alt{background:transparent;color:#1a73e8;border-color:#dadce0}' +
    '@media(prefers-color-scheme:dark){a.btn.alt,button.alt{color:#8ab4f8;border-color:#5f6368}button{background:#8ab4f8;color:#202124}}' +
    '</style></head><body><div class="wrap">' +
    '<div class="face">:(</div>' +
    '<h1>This site can&rsquo;t be reached</h1>' +
    '<p><b>' + h + '</b> unexpectedly refused the connection or could not be loaded through Superwork.</p>' +
    (d ? '<p>' + d + '</p>' : '') +
    '<p>Try:</p><p>&bull; Checking the connection<br>&bull; Checking the proxy and firewall<br>&bull; Retrying in a moment</p>' +
    '<div class="code">' + entEncode(code) + '</div>' +
    '<div class="btns">' +
    '<button onclick="try{location.reload()}catch(e){};try{parent.postMessage({__sw:1,type:&quot;reloadRequest&quot;},&quot;*&quot;)}catch(e){}">Reload</button>' +
    (t ? '<a class="btn alt" href="' + t + '" target="_blank" rel="noreferrer">Open directly</a>' : '') +
    '</div></div>' +
    '</body></html>';
}

function mapErrCode(msg) {
  const m = String(msg).toLowerCase();
  if (m.indexOf('dns') >= 0 || m.indexOf('resolve') >= 0 || m.indexOf('name_not') >= 0) return 'ERR_NAME_NOT_RESOLVED';
  if (m.indexOf('timeout') >= 0 || m.indexOf('timed out') >= 0) return 'ERR_CONNECTION_TIMED_OUT';
  if (m.indexOf('refused') >= 0) return 'ERR_CONNECTION_REFUSED';
  if (m.indexOf('reset') >= 0) return 'ERR_CONNECTION_RESET';
  if (m.indexOf('redirect') >= 0) return 'ERR_TOO_MANY_REDIRECTS';
  if (m.indexOf('tls') >= 0 || m.indexOf('ssl') >= 0 || m.indexOf('certificate') >= 0) return 'ERR_SSL_PROTOCOL_ERROR';
  if (m.indexOf('blocked') >= 0) return 'ERR_BLOCKED_BY_CLIENT';
  return 'ERR_FAILED';
}

/* minimal shim prepended to worker scripts so they can live in the proxy too.
   v8: the client relays Worker construction into the app context and runs
   the script from a data: URL (opaque origin — importScripts and sync XHR
   to our /service/ endpoints are blocked there). The shim therefore:
     • rewrites fetch() URLs into /service/ absolute form (unchanged);
     • patches XMLHttpRequest.open the same way;
     • patches importScripts: PRELOADED scripts (the app pre-fetches every
       literal importScripts(...) URL found in the source and registers the
       text in self.__SWPRE) eval synchronously — perfect fidelity for the
       standard top-of-worker pattern; anything else tries native once and
       then throws, so site-level fallbacks (ffmpeg's `catch { await
       import(esm) }`, which DOES work from data: workers) still fire.
   v8.1 REWRITE-TARGET GLOBALS: rewriteJs rewrites location/document
   patterns into __swloc / __swlocParts() / __swdoc.domain / __swDest() —
   globals the PAGE hook normally provides. Workers get the SAME rewritten
   script but never had those globals → "ReferenceError: __swloc is not
   defined" the moment an Emscripten glue (ffmpeg-core) touches location
   (tidal-dl's download died inside its worker exactly here). The shim now
   defines every rewrite target, backed by the REAL script URL from
   __SWCFG: a location-like __swloc, __swlocParts(), a __swdoc stub and
   __swDest()→self. */
function workerShim(finalUrl, origin) {
  return 'var __SWCFG=' + safeJsonInline({ url: finalUrl, worker: origin || '' }) + ';\n' +
    '(function(){' +
    /* --- rewrite-target globals (see v8.1 note above) --- */
    'var __U=null;try{__U=new URL(__SWCFG.url)}catch(e){};' +
    'var __p={href:__U?__U.href:__SWCFG.url,protocol:__U?__U.protocol:"",host:__U?__U.host:"",' +
    'hostname:__U?__U.hostname:"",port:__U?__U.port:"",pathname:__U?__U.pathname:"/",' +
    'search:__U?__U.search:"",hash:__U?__U.hash:"",origin:__U?__U.origin:""};' +
    '__p.toString=function(){return __p.href};' +
    '__p.assign=function(){};__p.replace=function(){};__p.reload=function(){};' +
    'self.__swloc=__p;' +
    'self.__swlocParts=function(){var q={};for(var k in __p)q[k]=__p[k];' +
    'q.toString=function(){return __p.href};q.assign=function(){};q.replace=function(){};q.reload=function(){};' +
    'q.ancestorOrigins=[];return q;};' +
    'self.__swdoc={domain:__p.hostname,URL:__p.href,baseURI:__p.href,' +
    'referrer:__SWCFG.referrer||"",cookie:"",' +
    'addEventListener:function(){},removeEventListener:function(){},' +
    'createElement:function(){return {setAttribute:function(){},appendChild:function(){},style:{}}},' +
    'getElementsByTagName:function(){return[]},querySelector:function(){return null},querySelectorAll:function(){return[]}};' +
    'self.__swDest=function(){return self};' +
    /* --- v8.1 blob: round-trip: blob URLs created in the PAGE context are
       unfetchable here; ask the spawner (the app bridge relays to the page's
       hook registry) for the bytes and serve them as a Response --- */
    'var SWQ={},SWS=0;' +
    'self.addEventListener("message",function(ev){var d=ev.data;' +
    'if(d&&d.__swblobgot===1&&d.req&&SWQ[d.req]){var p=SWQ[d.req];delete SWQ[d.req];' +
    'if(d.fail){p.rej(new Error("blob unavailable"));}' +
    'else if(d.buf&&d.buf instanceof ArrayBuffer){' +
    'try{p.res(new Response(d.buf,{headers:{"content-type":d.mime||"application/octet-stream"}}));}' +
    'catch(e){p.rej(e);}}' +
    'else if(d.b64){try{var bin=atob(d.b64),arr=new Uint8Array(bin.length);' +
    'for(var i=0;i<bin.length;i++)arr[i]=bin.charCodeAt(i);' +
    'p.res(new Response(arr,{headers:{"content-type":d.mime||"application/octet-stream"}}));}' +
    'catch(e){p.rej(e);}}' +
    'else{p.rej(new Error("blob payload missing"));}}});' +
    'function BLOBFETCH(u){return new Promise(function(res,rej){' +
    'var req=u+"#"+(++SWS);SWQ[req]={res:res,rej:rej};' +
    'try{self.postMessage({__swblobget:1,url:u,req:req});}catch(e){delete SWQ[req];rej(e);return;}' +
    'setTimeout(function(){if(SWQ[req]){delete SWQ[req];rej(new Error("blob fetch timeout"));}},30000);});}' +
    /* --- fetch / XHR / importScripts patches --- */
    'var E=function(u){try{if(__SWCFG.worker&&u.indexOf(__SWCFG.worker+"/service/")===0)return u;' +
    'var a=new URL(u,__SWCFG.url);if(a.protocol!=="http:"&&a.protocol!=="https:")return u;' +
    'var b=new TextEncoder().encode(a.href),s="";for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);' +
    'return (__SWCFG.worker||"")+"/service/"+btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}catch(e){return u}};' +
    'var of=self.fetch;self.fetch=function(i,n){try{n=n||{};' +
    'if(typeof i==="string"&&i.indexOf("blob:")===0){return BLOBFETCH(i);}' +
    'if(typeof i==="string"){i=E(i)}' +
    'else if(i&&i.url){i=new Request(E(i.url),i)}return of.call(self,i,n)}catch(e){return of.apply(self,arguments)}};' +
    'try{var oo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){' +
    'try{arguments[1]=E(String(u))}catch(e){}return oo.apply(this,arguments)}}catch(e){};' +
    'try{var ois=self.importScripts;self.importScripts=function(){' +
    'var args=[].slice.call(arguments);' +
    'for(var i=0;i<args.length;i++){var k=E(args[i]);' +
    'if(self.__SWPRE&&Object.prototype.hasOwnProperty.call(self.__SWPRE,k)){' +
    '(0,eval)(self.__SWPRE[k]);continue;}' +
    'try{ois.call(self,args[i]);}catch(err){throw err;}}};}catch(e){};})();\n';
}

/* headers helpers */
function respHeaders(obj, contentLength) {
  const h = new Headers();
  for (const k of Object.keys(obj || {})) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') h.set(k, obj[k]);
  }
  if (typeof contentLength === 'number' && isFinite(contentLength) && contentLength >= 0) {
    h.set('content-length', String(contentLength));
  }
  return h;
}
function thinHeaders(up) {
  const h = new Headers();
  ['cache-control', 'etag', 'last-modified'].forEach(k => { if (up[k]) h.set(k, up[k]); });
  return h;
}
function safeHost(u) {
  try { return new URL(u).hostname; } catch (e) { return String(u || '').slice(0, 100); }
}

/* ============================================================
   Core proxy — redirect chain with per-hop cookies.
   Used by /service/ (server-side rewriting engine).
   v7 UA policy: opts.ua (desktop override) > opts.clientUA (the
   real browser identity forwarded by the client) > MOBILE_UA.
   Matching low-entropy client hints are attached so UA-CH-aware
   sites (Amazon etc.) agree with the UA string they see.
   ============================================================ */
function uaIsMobile(ua) {
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua || '');
}
function applyUa(h, ua) {
  h.set('user-agent', ua);
  try {
    if (uaIsMobile(ua)) {
      h.set('sec-ch-ua-mobile', '?1');
      if (/Android/i.test(ua)) h.set('sec-ch-ua-platform', '"Android"');
      else if (/iPhone|iPad|iPod/i.test(ua)) h.set('sec-ch-ua-platform', '"iOS"');
    } else {
      h.set('sec-ch-ua-mobile', '?0');
      h.set('sec-ch-ua-platform', '"Windows"');
    }
  } catch (e) { /* headers immutable upstream — ignore */ }
}
async function coreFetch(opts) {
  /* opts: { method, target, headers(Headers, sanitized), body,
             ua, clientUA, cookie, referrer, origin, selfHost } */
  let targetUrl;
  try { targetUrl = new URL(opts.target); } catch (e) {
    return { ok: false, status: 400, code: 'invalid_url', error: 'Malformed upstream URL' };
  }
  if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
    return { ok: false, status: 400, code: 'bad_scheme', error: 'Only http/https targets are supported' };
  }
  if (targetUrl.host === opts.selfHost) {
    return { ok: false, status: 400, code: 'self_loop', error: 'Refusing to proxy this worker through itself' };
  }
  if (targetUrl.href.length > 8192) {
    return { ok: false, status: 400, code: 'url_too_long', error: 'Upstream URL exceeds 8KB' };
  }

  /* base upstream headers */
  const h = new Headers();
  for (const [k, v] of opts.headers.entries()) {
    const lk = k.toLowerCase();
    if (REQ_STRIP.has(lk) || lk.startsWith('x-sw-') || lk.startsWith('sec-') ||
      lk.startsWith('cf-') || lk.startsWith('cdn-')) continue;
    h.set(k, v);
  }
  h.set('accept-encoding', 'gzip, deflate, br');
  applyUa(h, opts.ua || opts.clientUA || MOBILE_UA);
  if (opts.cookie) h.set('cookie', opts.cookie);
  if (opts.referrer && /^https?:\/\//i.test(opts.referrer)) h.set('referer', opts.referrer);
  if (opts.origin) h.set('origin', opts.origin);
  const auth = opts.headers.get('authorization');
  if (auth) h.set('authorization', auth);

  let current = targetUrl.href;
  let hops = 0;
  let res = null;
  const setCookies = [];
  const hopJar = new Map();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FIRST_BYTE_TIMEOUT);

  try {
    while (true) {
      const cu = new URL(current);
      const hh = new Headers(h);
      const hc = hopCookieHeader(hopJar, cu.hostname, cu.pathname);
      if (hc) hh.set('cookie', hc);

      res = await fetch(current, {
        method: (hops === 0 ? opts.method : hopMethod(opts.method, res)),
        headers: hh,
        body: (hops === 0 ? opts.body : hopBody(hops, opts.method, res, opts.body)),
        redirect: 'manual',
        signal: ctrl.signal
      });

      absorbSetCookies(res, setCookies, hopJar, cu);

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) break;
        hops++;
        if (hops > MAX_HOPS) {
          clearTimeout(timer);
          return { ok: false, status: 508, code: 'too_many_redirects', error: 'More than ' + MAX_HOPS + ' redirects' };
        }
        current = new URL(loc, current).href;
        continue;
      }
      break;
    }
  } catch (err) {
    clearTimeout(timer);
    const cause = (err && err.cause) ? String(err.cause) : '';
    const m = (String(err && err.message || err) + ' ' + cause).slice(0, 400);
    if (/abort/i.test(m)) return { ok: false, status: 504, code: 'timeout', error: 'Upstream timed out after ' + (FIRST_BYTE_TIMEOUT / 1000) + 's' };
    if (/resolve|dns|getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(m)) return { ok: false, status: 502, code: 'dns', error: 'Could not resolve ' + safeHost(current) };
    if (/certificate|tls|ssl|CERT/i.test(m)) return { ok: false, status: 502, code: 'tls', error: 'TLS/certificate error talking to ' + safeHost(current) };
    if (/refused|ECONNREFUSED/i.test(m)) return { ok: false, status: 502, code: 'refused', error: safeHost(current) + ' refused the connection' };
    if (/reset|ECONNRESET/i.test(m)) return { ok: false, status: 502, code: 'reset', error: 'Connection to ' + safeHost(current) + ' was reset' };
    return { ok: false, status: 502, code: 'fetch_failed', error: m.slice(0, 300) };
  }
  clearTimeout(timer);
  return { ok: true, status: res.status, res, finalUrl: current, setCookies };
}

function hopMethod(original, res) {
  const s = res.status;
  if (s === 301 || s === 302 || s === 303) return 'GET';
  return original;
}
function hopBody(hop, original, res, body) {
  if (hop === 0) return body;
  const s = res.status;
  if (s === 301 || s === 302 || s === 303) return null;
  return body;
}

function absorbSetCookies(res, sink, hopJar, cu) {
  try {
    let lines = [];
    if (typeof res.headers.getSetCookie === 'function') {
      lines = res.headers.getSetCookie() || [];
    } else {
      const raw = res.headers.get('set-cookie');
      if (raw) lines = raw.split('\n');
    }
    for (const line of lines) {
      if (!line) continue;
      sink.push({ u: cu.href, c: line });
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const name = line.slice(0, eq).split(';')[0].trim();
      const value = line.slice(eq + 1).split(';')[0].trim();
      let domain = cu.hostname.toLowerCase();
      const dm = /;\s*domain\s*=\s*([^;]+)/i.exec(line);
      if (dm) domain = dm[1].trim().toLowerCase().replace(/^\./, '');
      if (!hopJar.has(domain)) hopJar.set(domain, new Map());
      const isDelete = /;\s*(max-age\s*=\s*0|expires\s*=\s*thu,\s*01\s*jan\s*1970)/i.test(line);
      if (isDelete) hopJar.get(domain).delete(name);
      else hopJar.get(domain).set(name, value);
    }
  } catch (e) { /* ignore */ }
}

function hopCookieHeader(hopJar, hostname, pathname) {
  const host = hostname.toLowerCase();
  const parts = [];
  for (const [domain, cookies] of hopJar.entries()) {
    if (host === domain || host.endsWith('.' + domain)) {
      cookies.forEach((v, k) => parts.push(k + '=' + v));
    }
  }
  return parts.length ? parts.join('; ') : null;
}

/* ============================================================
   JSON error helper
   ============================================================ */
function jsonError(status, code, error) {
  return new Response(JSON.stringify({ error, code }), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
}

/* ============================================================
   GET / — status JSON. Lets the standalone client verify it is
   talking to a Superwork worker (and nothing else).
   ============================================================ */
function rootStatus(request) {
  const colo = request.cf && request.cf.colo ? request.cf.colo : null;
  return new Response(JSON.stringify({
    ok: true,
    service: 'superwork',
    version: APP_VERSION,
    colo,
    time: new Date().toISOString()
  }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  });
}

/* ============================================================
   POST /jar — cookie-jar + settings sync (standalone client)
   Body (text/plain JSON to avoid CORS preflight):
     { cookies: [{u,c}], ua: [hosts], dflt: bool, ads: bool, clear: bool }
   Response: { ok, jar: [{u,c}] }
   ============================================================ */
async function jarEndpoint(request) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST required' }), {
      status: 405,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
    });
  }
  let data = {};
  try { data = JSON.parse(await request.text() || '{}'); } catch (e) { data = {}; }

  if (data.clear) {
    jar.clear();
  } else if (Array.isArray(data.cookies)) {
    for (const it of data.cookies) {
      if (it && it.u && it.c) jar.setFromHeader(it.u, String(it.c), true);
    }
  }
  if (Array.isArray(data.ua)) {
    settings.uaHosts = new Set(data.ua.map(s => String(s).toLowerCase()).filter(Boolean));
  }
  if (typeof data.dflt === 'boolean') settings.desktopDefault = data.dflt;
  if (typeof data.ads === 'boolean') settings.blockAds = data.ads;

  return new Response(JSON.stringify({ ok: true, jar: jar.toLines() }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
  });
}

/* ============================================================
   /service/<base64url(target)> — server-side proxy engine.
   Rewrites HTML/CSS/JS so pages render inside a sandboxed iframe
   in the standalone client, with no service worker at all.
   ============================================================ */
function isNavigation(request) {
  if (request.method !== 'GET') return false;
  const sfd = (request.headers.get('sec-fetch-dest') || '').toLowerCase();
  if (sfd === 'document' || sfd === 'iframe') return true;
  if (request.mode === 'navigate' || request.destination === 'document') return true;
  const accept = request.headers.get('accept') || '';
  return accept.indexOf('text/html') >= 0 && !request.destination;
}

/* decode a service path, with referrer-based recovery for relative
   URLs that escaped rewriting */
function decServicePathFull(pathname) {
  const seg = pathname.slice(PREFIX.length);
  const decoded = b64d(seg);
  if (decoded && /^https?:\/\//i.test(decoded)) return { target: decoded, rest: '' };
  /* maybe shape <b64dir>/<rest> */
  const slash = seg.indexOf('/');
  if (slash > 0) {
    const d2 = b64d(seg.slice(0, slash));
    if (d2 && /^https?:\/\//i.test(d2)) {
      return { target: d2, rest: seg.slice(slash + 1) };
    }
  }
  return null;
}

async function serviceFetch(request, url) {
  const isNav = isNavigation(request);
  const origin = url.origin; /* absolute prefixes for every rewritten URL */

  /* decode target */
  let info = decServicePathFull(url.pathname);
  let target = null;
  if (info && info.target && !info.rest) {
    target = info.target;
  } else {
    /* recovery: resolve the raw suffix against the referring doc */
    let refDoc = null;
    const ref = request.headers.get('referer');
    if (ref) {
      try {
        const ru = new URL(ref);
        if (ru.host === url.host && ru.pathname.indexOf(PREFIX) === 0) {
          const rd = b64d(ru.pathname.slice(PREFIX.length));
          if (rd && /^https?:\/\//i.test(rd)) refDoc = rd;
        }
      } catch (e) { }
    }
    const suffix = url.pathname.slice(PREFIX.length);
    const guess = refDoc && resolveUrl('/' + suffix, refDoc);
    if (guess && (guess.protocol === 'http:' || guess.protocol === 'https:')) {
      target = guess.href;
    } else if (info && info.target && info.rest) {
      const base = new URL(info.target);
      const abs = resolveUrl(info.rest, base.href.endsWith('/') ? base.href : base.href);
      if (abs && (abs.protocol === 'http:' || abs.protocol === 'https:')) target = abs.href;
    }
  }

  if (!target) {
    if (isNav) return new Response(errPage('ERR_INVALID_URL', '', 'Invalid proxied URL.', ''), {
      status: 200,
      headers: respHeaders({
        'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'access-control-allow-origin': '*', 'x-sw-error': 'ERR_INVALID_URL',
        'access-control-expose-headers': 'x-sw-error, x-sw-final-url'
      })
    });
    return jsonError(400, 'invalid_service_url', 'Invalid proxied URL');
  }

  /* merge query params appended by the browser (form GET) */
  try {
    if (url.search) {
      const t = new URL(target);
      for (const [k, v] of url.searchParams.entries()) t.searchParams.set(k, v);
      target = t.href;
    }
  } catch (e) { /* keep */ }

  /* blocklist */
  try {
    if (hostBlocked(new URL(target).hostname)) {
      return new Response('', { status: 204, headers: respHeaders({ 'x-superwork': 'blocked', 'access-control-allow-origin': '*' }) });
    }
  } catch (e) { }

  /* referrer for upstream: (1) x-sw-ref page URL sent by the hook's
     fetch/XHR patches, (2) the browser Referer header when the client
     runs on http(s), (3) v8 SYNTHESIZED same-site referer. The phone
     client is a file:// document — sandboxed srcdoc subresources send
     NO Referer at all, and hotlink-protected CDNs (Akamai/Imgix class)
     then 403 images that would load fine. A same-origin referer passes
     every hotlink check and matches what a real same-site navigation
     would send. */
  let refUrl = '';
  const swRef = request.headers.get('x-sw-ref');
  if (swRef) {
    const dr = b64d(swRef);
    if (dr && /^https?:\/\//i.test(dr)) refUrl = dr;
  }
  if (!refUrl) {
    const ref = request.headers.get('referer');
    if (ref) {
      try {
        const ru = new URL(ref);
        if (ru.host === url.host && ru.pathname.indexOf(PREFIX) === 0) {
          const rd = b64d(ru.pathname.slice(PREFIX.length));
          if (rd && /^https?:\/\//i.test(rd)) refUrl = rd;
        }
      } catch (e) { }
    }
  }
  if (!refUrl) {
    try {
      const tu = new URL(target);
      refUrl = tu.origin + '/';
    } catch (e) { }
  }

  /* sanitize passthrough headers */
  const headers = new Headers();
  for (const [k, v] of request.headers.entries()) {
    const lk = k.toLowerCase();
    if (REQ_STRIP.has(lk) || lk.startsWith('x-sw-') || lk.startsWith('sec-') ||
      lk.startsWith('cf-') || lk.startsWith('cdn-')) continue;
    headers.set(k, v);
  }

  let body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.arrayBuffer();
  }

  /* v7: the client forwards its real browser UA (x-sw-ua) so pages
     get the right identity by default — a phone gets mobile sites,
     a desktop gets desktop sites. The "desktop site" toggle still
     force-overrides with DESKTOP_UA per host. */
  let ua = null;
  try {
    const host = new URL(target).hostname;
    if (settings.desktopDefault || settings.uaHosts.has(host)) ua = DESKTOP_UA;
  } catch (e) { }
  let clientUA = '';
  try {
    const cu = request.headers.get('x-sw-ua') || request.headers.get('user-agent') || '';
    if (/^Mozilla\/.*\S/.test(cu) && cu.length < 300) clientUA = cu;
  } catch (e) { }

  const cookie = jar.headerFor(target, true);

  const r = await coreFetch({
    method: request.method, target, headers, body, ua, clientUA, cookie,
    referrer: refUrl,
    origin: (refUrl && request.method !== 'GET') ? new URL(refUrl).origin : null,
    selfHost: url.host
  });

  if (!r.ok) {
    if (isNav) {
      return new Response(errPage(mapErrCode(r.error), safeHost(target), r.error, target), {
        status: 200,
        headers: respHeaders({
          'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'access-control-allow-origin': '*', 'x-sw-error': mapErrCode(r.error),
          'access-control-expose-headers': 'x-sw-error, x-sw-final-url'
        })
      });
    }
    return jsonError(r.status, r.code, r.error);
  }

  /* absorb set-cookies into the persistent-ish jar */
  for (const sc of r.setCookies) jar.setFromHeader(sc.u, sc.c, false);

  const res = r.res;
  const finalUrl = r.finalUrl;
  const status = r.status;
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  let upHeaders = {};
  try { upHeaders = JSON.parse(JSON.stringify(Object.fromEntries(res.headers.entries()))); } catch (e) { }

  if (status === 304 || status === 204) {
    const h = thinHeaders(upHeaders);
    h.set('access-control-allow-origin', '*');
    return new Response(null, { status, headers: h });
  }

  const isHtml = ctype.indexOf('text/html') === 0 || ctype.indexOf('application/xhtml+xml') === 0 ||
    (ctype === '' && isNav && request.method === 'GET');
  const isCss = ctype.indexOf('text/css') === 0;
  const isJs = ctype.indexOf('javascript') >= 0 || ctype.indexOf('ecmascript') >= 0 ||
    ctype.indexOf('application/x-javascript') >= 0;
  /* v8: x-sw-worker marks script fetches made by the client's Worker
     relay (it fetches the script text through the API and constructs a
     data: worker in the app context — those fetches have no browser
     "destination: worker" marker, so the header carries the intent).
     Such responses get the workerShim prepended + import.meta.url
     rewrite so the script is self-contained inside the data: worker. */
  const isWorker = request.destination === 'worker' || request.destination === 'sharedworker' ||
    request.headers.get('x-sw-worker') === '1';

  if (isWorker) {
    const src = await res.text();
    const bytes = new TextEncoder().encode(workerShim(finalUrl, origin) + rewriteJs(src, finalUrl, origin));
    return new Response(bytes, {
      status,
      headers: respHeaders({
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store', 'access-control-allow-origin': '*'
      }, bytes.length)
    });
  }

  if (isHtml) {
    /* decode using the declared charset, always re-emit as UTF-8 */
    let text;
    const cs = /charset=([\w-]+)/i.exec(ctype);
    if (cs && !/utf-?8/i.test(cs[1])) {
      const buf = await res.arrayBuffer();
      try { text = new TextDecoder(cs[1].toLowerCase()).decode(buf); }
      catch (e) { text = new TextDecoder().decode(buf); }
    } else {
      text = await res.text();
    }
    /* per-origin storage snapshot relayed by the client (localStorage
       emulation across srcdoc page loads — sandboxed frames have no
       real storage, so the app persists it and sends it back here) */
    let store = null;
    try {
      const sh = request.headers.get('x-sw-store');
      if (sh && sh.length < 32768) {
        store = JSON.parse(b64d(sh));
        if (!store || typeof store !== 'object') store = null;
      }
    } catch (e) { store = null; }
    const cfg = {
      url: finalUrl,
      worker: origin,
      cookieStr: jar.headerFor(finalUrl, false),
      referrer: refUrl,
      store: store || undefined,
      v: APP_VERSION
    };
    let out = rewriteHtml(text, finalUrl, cfg, origin);
    /* second pass: srcdoc attributes get a quick rewrite + (v7) the
       runtime hook injected, so site-authored srcdoc frames
       (consent widgets, ad iframes) run with full URL interception
       instead of a bare static rewrite */
    out = out.replace(/srcdoc\s*=\s*"([^"]*)"/gi, (m, val) => {
      const dec = entDecode(val);
      let rr = rewriteSrcdoc(dec, finalUrl, origin);
      try {
        if (dec.length < 2097152 && /^\s*</.test(dec) &&
            /<\s*(html|body|div|script|head|iframe|img|a\b)/i.test(dec) && rr.indexOf('__SW_HOOKED') < 0) {
          const scfg = { url: finalUrl, worker: origin, cookieStr: cfg.cookieStr, referrer: refUrl, v: APP_VERSION };
          const inject = '<script>__SWCFG=' + safeJsonInline(scfg) + ';</script>\n<script>' +
            HOOK_JS.replace(/<\/script/gi, '<\\/script') + '</script>\n';
          if (/<\s*head[^>]*>/i.test(rr)) rr = rr.replace(/<\s*head[^>]*>/i, (hm) => hm + inject);
          else if (/<\s*body[^>]*>/i.test(rr)) rr = rr.replace(/<\s*body[^>]*>/i, (bm) => bm + inject);
          else rr = inject + rr;
        }
      } catch (e) { /* srcdoc stays URL-rewritten only */ }
      return 'srcdoc="' + entEncode(rr) + '"';
    });
    const bytes = new TextEncoder().encode(out);
    return new Response(bytes, {
      status,
      headers: respHeaders({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
        'access-control-allow-origin': '*',
        'x-sw-final-url': finalUrl,
        'access-control-expose-headers': 'x-sw-error, x-sw-final-url'
      }, bytes.length)
    });
  }

  if (isCss) {
    const text = await res.text();
    const out = rewriteCss(text, finalUrl, origin);
    const bytes = new TextEncoder().encode(out);
    return new Response(bytes, {
      status,
      headers: respHeaders({
        'content-type': 'text/css; charset=utf-8',
        'cache-control': 'no-store', 'access-control-allow-origin': '*'
      }, bytes.length)
    });
  }

  if (isJs) {
    const text = await res.text();
    const out = rewriteJs(text, finalUrl, origin);
    const bytes = new TextEncoder().encode(out);
    return new Response(bytes, {
      status,
      headers: respHeaders({
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store', 'access-control-allow-origin': '*'
      }, bytes.length)
    });
  }

  /* stream everything else untouched (images, video, fonts, JSON, …).
     v6: content-disposition + sizes are exposed so the client can
     classify downloads (attachment / PDF / archive) and show
     progress without a second request. */
  const h = respHeaders({
    'content-type': res.headers.get('content-type') || 'application/octet-stream',
    'cache-control': upHeaders['cache-control'],
    'etag': upHeaders['etag'],
    'last-modified': upHeaders['last-modified'],
    'accept-ranges': upHeaders['accept-ranges'],
    'content-range': upHeaders['content-range'],
    'content-disposition': upHeaders['content-disposition'],
    'content-language': upHeaders['content-language'],
    'x-robots-tag': 'noindex',
    'access-control-allow-origin': '*',
    'x-sw-final-url': finalUrl,
    'x-sw-len': upHeaders['content-length'],
    'access-control-expose-headers': 'x-sw-error, x-sw-final-url, x-sw-len, content-disposition, content-length, content-type'
  });
  return new Response(res.body, { status, headers: h });
}

/* ============================================================
   /ws/<base64url(target)> — WebSocket tunnel
   ============================================================ */
async function wsTunnel(request, url) {
  if (request.headers.get('upgrade') !== 'websocket') {
    return jsonError(426, 'expected_websocket', 'This endpoint only speaks WebSocket');
  }
  const b64 = url.pathname.slice('/ws/'.length).split('?')[0];
  const target = b64d(b64);
  let tu;
  try { tu = new URL(target); } catch (e) {
    return jsonError(400, 'bad_ws_url', 'Malformed WebSocket target');
  }
  if (tu.protocol !== 'ws:' && tu.protocol !== 'wss:') {
    return jsonError(400, 'bad_ws_scheme', 'Target must be ws:// or wss://');
  }
  if (tu.host === url.host) {
    return jsonError(400, 'self_loop', 'Refusing to loop through this worker');
  }

  const upstream = new Request(tu.href, {
    headers: {
      'Connection': 'Upgrade',
      'Upgrade': 'websocket',
      'Sec-WebSocket-Key': request.headers.get('sec-websocket-key') || btoa(crypto.randomUUID()),
      'Sec-WebSocket-Version': request.headers.get('sec-websocket-version') || '13',
      'User-Agent': request.headers.get('user-agent') || 'Mozilla/5.0'
    }
  });

  let upRes;
  try {
    upRes = await fetch(upstream);
  } catch (err) {
    return jsonError(502, 'ws_failed', String(err && err.message || err).slice(0, 200));
  }
  if (upRes.status !== 101 || !upRes.webSocket) {
    return jsonError(502, 'ws_rejected', 'Upstream refused the WebSocket upgrade (' + upRes.status + ')');
  }

  const pair = new WebSocketPair();
  const client = pair[0], server = pair[1];
  server.accept();
  const upstreamWs = upRes.webSocket;
  upstreamWs.accept();

  server.addEventListener('message', (e) => { try { upstreamWs.send(e.data); } catch (x) { } });
  upstreamWs.addEventListener('message', (e) => { try { server.send(e.data); } catch (x) { } });
  const closeBoth = () => { try { server.close(); } catch (x) { } try { upstreamWs.close(); } catch (x) { } };
  server.addEventListener('close', closeBoth);
  upstreamWs.addEventListener('close', closeBoth);
  server.addEventListener('error', closeBoth);
  upstreamWs.addEventListener('error', closeBoth);

  return new Response(null, { status: 101, webSocket: client });
}

/* ============================================================
   Router — pure API, nothing else
   ============================================================ */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    /* CORS preflight for every route (standalone file client) */
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': '*',
          'access-control-max-age': '86400'
        }
      });
    }

    try {
      if (url.pathname === '/') {
        return rootStatus(request);
      }
      if (url.pathname === '/jar') {
        return jarEndpoint(request);
      }
      if (url.pathname.startsWith('/ws/')) {
        return wsTunnel(request, url);
      }
      if (url.pathname.indexOf('/service/') === 0) {
        return serviceFetch(request, url);
      }
    } catch (err) {
      return jsonError(500, 'worker_error', String(err && err.message || err));
    }

    return new Response(JSON.stringify({ error: 'Not found', code: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
    });
  }
};
