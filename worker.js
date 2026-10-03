/* ============================================================
   Superwork 4.0 — Cloudflare Worker (pure API proxy, no build deps)
   ------------------------------------------------------------
   Deploy:  npx wrangler deploy     (or paste into the dashboard)

   This worker serves NO pages of its own. It is a pure JSON/API
   backend for the standalone single-file client (index.html kept
   on your phone / computer, opened from file:// or anywhere).

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
const HOOK_JS = "/* ============================================================\n   Superwork 4.0 — Runtime Hook (injected into every proxied\n   page BEFORE any site script runs).\n   ------------------------------------------------------------\n   Patches the browser APIs that cannot be rewritten at the\n   source level: location, fetch, XHR, WebSocket, history,\n   storage, cookies, element URL properties, window.open …\n   Every patch is individually defensive: a failure must never\n   break the page.\n   ============================================================ */\n(function () {\n  'use strict';\n  if (window.__SW_HOOKED) return;\n  try { window.__SW_HOOKED = 1; } catch (e) { return; }\n\n  var CFG = {};\n  try { CFG = window.__SWCFG || {}; } catch (e) { }\n  var PREFIX = '/service/';\n\n  /* ---------- codec ---------- */\n  function b64e(str) {\n    try {\n      var bytes = new TextEncoder().encode(str), bin = '';\n      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);\n      return btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');\n    } catch (e) { return ''; }\n  }\n  function b64d(str) {\n    try {\n      var s = String(str).replace(/-/g, '+').replace(/_/g, '/');\n      while (s.length % 4) s += '=';\n      var bin = atob(s), bytes = new Uint8Array(bin.length);\n      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);\n      return new TextDecoder().decode(bytes);\n    } catch (e) { return ''; }\n  }\n  var SKIP = /^(data:|blob:|javascript:|about:|mailto:|tel:|sms:|magnet:|intent:|market:|superwork:)/i;\n\n  function decService() {\n    try {\n      var p = new URL(location.href);\n      if (p.pathname.indexOf(PREFIX) === 0) {\n        var d = b64d(p.pathname.slice(PREFIX.length));\n        if (/^https?:\\/\\//i.test(d)) return d;\n      }\n    } catch (e) { }\n    return CFG.url || location.href;\n  }\n  function cur() { return decService(); }\n  function isProxied(u) { return typeof u === 'string' && u.indexOf(PREFIX) === 0; }\n  function rw(u) {\n    if (u == null) return u;\n    u = String(u);\n    if (!u || isProxied(u) || SKIP.test(u)) return u;\n    try {\n      var abs = new URL(u, cur());\n      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;\n      if (abs.pathname.indexOf(PREFIX) === 0) return u;\n      return PREFIX + b64e(abs.href);\n    } catch (e) { return u; }\n  }\n  function unrw(u) {\n    if (typeof u !== 'string') return u;\n    try {\n      var p = new URL(u, location.href);\n      if (p.pathname.indexOf(PREFIX) === 0) {\n        var d = b64d(p.pathname.slice(PREFIX.length));\n        if (/^https?:\\/\\//i.test(d)) return d;\n      }\n    } catch (e) { }\n    return u;\n  }\n\n  /* ---------- messaging ---------- */\n  var REAL_PARENT = null;\n  try { REAL_PARENT = window.parent; } catch (e) { }\n  var IS_TOP = true;\n  try { IS_TOP = (window.top === window.self); } catch (e) { IS_TOP = true; }\n\n  function tellParent(msg) {\n    try {\n      msg.__sw = 1;\n      (REAL_PARENT || parent).postMessage(msg, '*');\n    } catch (e) { }\n  }\n  function tellNav(extra) {\n    try {\n      var m = { type: 'nav', url: cur(), title: document.title };\n      if (extra) for (var k in extra) m[k] = extra[k];\n      tellParent(m);\n    } catch (e) { }\n  }\n\n  /* ============================================================\n     __swloc — full location shim reading the REAL decoded URL\n     ============================================================ */\n  var __swloc = (function () {\n    function U() { return new URL(cur()); }\n    function go(v, replace) {\n      var e = rw(v);\n      if (e === v && !/^https?:/i.test(v) && v.charAt(0) !== '/') {\n        /* unresolvable — let the browser try */\n        if (replace) location.replace(v); else location.href = v;\n        return;\n      }\n      if (replace) location.replace(e); else location.href = e;\n    }\n    var loc = {\n      toString: function () { return cur(); },\n      valueOf: function () { return cur(); },\n      assign: function (v) { go(v, false); },\n      replace: function (v) { go(v, true); },\n      reload: function (f) { try { location.reload(f); } catch (e) { location.reload(); } }\n    };\n    function def(name, setHook) {\n      try {\n        Object.defineProperty(loc, name, {\n          get: function () { try { return U()[name]; } catch (e) { return ''; } },\n          set: function (v) {\n            try {\n              if (name === 'hash') { location.hash = v; return; }\n              var u = U();\n              u[name] = v;\n              go(u.href, false);\n              if (setHook) setHook(v);\n            } catch (e) { }\n          },\n          configurable: true\n        });\n      } catch (e) { }\n    }\n    ['href', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search'].forEach(function (n) { def(n); });\n    try {\n      Object.defineProperty(loc, 'hash', {\n        get: function () { try { return U().hash; } catch (e) { return ''; } },\n        set: function (v) { try { location.hash = v; } catch (e) { } },\n        configurable: true\n      });\n      Object.defineProperty(loc, 'origin', {\n        get: function () { try { return U().origin; } catch (e) { return ''; } },\n        configurable: true\n      });\n      Object.defineProperty(loc, 'ancestorOrigins', {\n        get: function () { return []; },\n        configurable: true\n      });\n    } catch (e) { }\n    return loc;\n  })();\n\n  /* ---------- __swdoc ---------- */\n  var __swdoc = {};\n  try {\n    Object.defineProperty(__swdoc, 'domain', {\n      get: function () { try { return new URL(cur()).hostname; } catch (e) { return ''; } },\n      set: function () { /* no-op — document.domain is obsolete */ },\n      configurable: true\n    });\n  } catch (e) { }\n\n  /* expose globals early (inline handlers + rewritten code rely on them) */\n  try { window.__swloc = __swloc; window.__swdoc = __swdoc; } catch (e) { }\n\n  /* ---------- document.location / window.location shims ---------- */\n  try {\n    Object.defineProperty(document, 'location', {\n      get: function () { return __swloc; },\n      set: function (v) { __swloc.href = v; },\n      configurable: true\n    });\n  } catch (e) { }\n\n  /* ---------- document URL surfaces ---------- */\n  try {\n    Object.defineProperty(document, 'URL', { get: function () { return cur(); }, configurable: true });\n  } catch (e) { }\n  try {\n    Object.defineProperty(document, 'baseURI', { get: function () { return cur(); }, configurable: true });\n  } catch (e) { }\n  try {\n    Object.defineProperty(document, 'referrer', { get: function () { return CFG.referrer || ''; }, configurable: true });\n  } catch (e) { }\n\n  /* ============================================================\n     Frame identity protection — inside the app UI the page must\n     believe (and be) its own top frame; popups keep real refs.\n     ============================================================ */\n  if (!IS_TOP) {\n    try { Object.defineProperty(window, 'top', { get: function () { return window.self; }, configurable: true }); } catch (e) { }\n    try { Object.defineProperty(window, 'parent', { get: function () { return window.self; }, configurable: true }); } catch (e) { }\n  }\n\n  /* ============================================================\n     fetch\n     ============================================================ */\n  try {\n    var __fetch = window.fetch;\n    var nativeToStr = Function.prototype.toString;\n    function wrapFetch(input, init) {\n      try {\n        init = init || {};\n        var url;\n        if (typeof input === 'string') {\n          url = rw(input);\n        } else if (input && typeof input.url === 'string') {\n          if (isProxied(input.url)) { url = input; }\n          else {\n            var ni = { method: input.method, headers: input.headers, body: input.body, mode: input.mode,\n              credentials: input.credentials, cache: input.cache, redirect: input.redirect,\n              referrer: input.referrer, integrity: input.integrity, keepalive: input.keepalive,\n              signal: input.signal };\n            if (input.method === 'GET' || input.method === 'HEAD') delete ni.body;\n            try { input = new Request(rw(input.url), ni); } catch (e2) { /* fall through */ }\n            url = input;\n          }\n        }\n        try { init.referrer = location.href; } catch (e) { }\n        try { delete init.referrerPolicy; } catch (e) { }\n        return __fetch.call(window, url === undefined ? input : url, init);\n      } catch (e) {\n        return __fetch.apply(window, arguments);\n      }\n    }\n    window.fetch = wrapFetch;\n  } catch (e) { }\n\n  /* ============================================================\n     XMLHttpRequest\n     ============================================================ */\n  try {\n    var __open = XMLHttpRequest.prototype.open;\n    XMLHttpRequest.prototype.open = function (method, url) {\n      try {\n        arguments[1] = rw(String(url));\n      } catch (e) { }\n      return __open.apply(this, arguments);\n    };\n    var __ru = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'responseURL');\n    if (__ru && __ru.get) {\n      try {\n        Object.defineProperty(XMLHttpRequest.prototype, 'responseURL', {\n          get: function () { return unrw(__ru.get.call(this)); },\n          configurable: true\n        });\n      } catch (e) { }\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     WebSocket / EventSource\n     ============================================================ */\n  try {\n    var __WS = window.WebSocket;\n    function wsUrl(u) {\n      try {\n        var abs = new URL(String(u), cur());\n        if (abs.protocol !== 'ws:' && abs.protocol !== 'wss:') return u;\n        var target = (abs.protocol === 'ws:' ? 'http://' : 'https://') + abs.host + abs.pathname + abs.search;\n        return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/' + b64e(target);\n      } catch (e) { return u; }\n    }\n    window.WebSocket = function (u, protocols) {\n      return protocols === undefined ? new __WS(wsUrl(u)) : new __WS(wsUrl(u), protocols);\n    };\n    window.WebSocket.prototype = __WS.prototype;\n    try {\n      Object.defineProperty(window.WebSocket, 'CONNECTING', { get: function () { return __WS.CONNECTING; } });\n      Object.defineProperty(window.WebSocket, 'OPEN', { get: function () { return __WS.OPEN; } });\n      Object.defineProperty(window.WebSocket, 'CLOSING', { get: function () { return __WS.CLOSING; } });\n      Object.defineProperty(window.WebSocket, 'CLOSED', { get: function () { return __WS.CLOSED; } });\n    } catch (e) { }\n    var __wsUrl = Object.getOwnPropertyDescriptor(__WS.prototype, 'url');\n    if (__wsUrl && __wsUrl.get) {\n      try {\n        Object.defineProperty(__WS.prototype, 'url', {\n          get: function () {\n            var v = __wsUrl.get.call(this);\n            try {\n              var p = new URL(v);\n              if (p.pathname.indexOf('/ws/') === 0) return b64d(p.pathname.slice(4));\n            } catch (e) { }\n            return v;\n          },\n          configurable: true\n        });\n      } catch (e) { }\n    }\n  } catch (e) { }\n\n  try {\n    var __ES = window.EventSource;\n    if (__ES) {\n      window.EventSource = function (u, cfg) {\n        return cfg === undefined ? new __ES(rw(u)) : new __ES(rw(u), cfg);\n      };\n      window.EventSource.prototype = __ES.prototype;\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     sendBeacon\n     ============================================================ */\n  try {\n    var __beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);\n    if (__beacon) {\n      navigator.sendBeacon = function (u, data) {\n        try { return __fetch.call(window, rw(u), { method: 'POST', body: data, keepalive: true, credentials: 'omit' }).then(function () { return true; }, function () { return false; }), true; }\n        catch (e) { return __beacon(rw(u), data); }\n      };\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     history — pushState / replaceState with URL rewriting\n     ============================================================ */\n  try {\n    var __push = history.pushState, __replace = history.replaceState;\n    history.pushState = function (st, t, u) {\n      if (u != null && u !== '') { try { arguments[2] = rw(String(u)); } catch (e) { } }\n      var r = __push.apply(this, arguments);\n      setTimeout(tellNav, 0);\n      return r;\n    };\n    history.replaceState = function (st, t, u) {\n      if (u != null && u !== '') { try { arguments[2] = rw(String(u)); } catch (e) { } }\n      var r = __replace.apply(this, arguments);\n      setTimeout(tellNav, 0);\n      return r;\n    };\n  } catch (e) { }\n\n  try {\n    addEventListener('popstate', function () { setTimeout(tellNav, 0); }, true);\n    addEventListener('hashchange', function () { setTimeout(tellNav, 0); }, true);\n  } catch (e) { }\n\n  /* ============================================================\n     document.cookie — JS-visible cookie emulation\n     ============================================================ */\n  var pageCookies = new Map(); // name → full set-cookie style string\n  try {\n    var __ck = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');\n    if (__ck) {\n      Object.defineProperty(Document.prototype, 'cookie', {\n        get: function () {\n          var mine = '';\n          try {\n            var arr = [];\n            pageCookies.forEach(function (v, k) {\n              var eq = v.indexOf('=');\n              arr.push(eq < 0 ? v : v.slice(0, eq) + '=' + (v.slice(eq + 1).split(';')[0]));\n            });\n            mine = arr.join('; ');\n          } catch (e) { }\n          var base = CFG.cookieStr || '';\n          if (!mine) return base;\n          if (!base) return mine;\n          /* page-set overrides jar snapshot by name */\n          var merged = {};\n          base.split('; ').forEach(function (p) {\n            var k = p.split('=')[0]; merged[k] = p;\n          });\n          mine.split('; ').forEach(function (p) {\n            var k = p.split('=')[0]; merged[k] = p;\n          });\n          return Object.keys(merged).map(function (k) { return merged[k]; }).join('; ');\n        },\n        set: function (v) {\n          try {\n            var s = String(v);\n            var name = s.split('=')[0].trim();\n            if (name) {\n              pageCookies.set(name, s);\n              /* the app UI persists the jar and re-syncs the worker */\n              tellParent({ type: 'setCookie', url: cur(), cookie: s });\n            }\n          } catch (e) { }\n        },\n        configurable: true\n      });\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     Storage namespacing (localStorage / sessionStorage)\n     ============================================================ */\n  function b64origin() {\n    try { return b64e(new URL(cur()).origin); } catch (e) { return 'x'; }\n  }\n  function makeStorage(real, tag) {\n    var pre = 'sw:' + tag + ':' + b64origin() + ':';\n    var backing = {};\n    var memOnly = null;\n    try {\n      for (var i = 0; i < real.length; i++) {\n        var k = real.key(i);\n        if (k && k.indexOf(pre) === 0) backing[k.slice(pre.length)] = real.getItem(k);\n      }\n    } catch (e) { memOnly = {}; }\n    function setReal(k, v) {\n      try { real.setItem(pre + k, v); } catch (e2) {\n        /* quota — drop the site's oldest entries */\n        try {\n          var keys = [];\n          for (var i = 0; i < real.length; i++) {\n            var rk = real.key(i);\n            if (rk && rk.indexOf(pre) === 0) keys.push(rk);\n          }\n          if (keys.length) { real.removeItem(keys[0]); real.setItem(pre + k, v); }\n        } catch (e3) { }\n      }\n    }\n    var store = {\n      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : null; },\n      setItem: function (k, v) { k = String(k); v = String(v); backing[k] = v; setReal(k, v); },\n      removeItem: function (k) { k = String(k); delete backing[k]; try { real.removeItem(pre + k); } catch (e) { } },\n      clear: function () {\n        Object.keys(backing).forEach(function (k) { try { real.removeItem(pre + k); } catch (e) { } });\n        backing = {};\n      },\n      key: function (i) { var ks = Object.keys(backing); return i < ks.length ? ks[i] : null; }\n    };\n    Object.defineProperty(store, 'length', { get: function () { return Object.keys(backing).length; } });\n    return new Proxy(store, {\n      get: function (t, k) {\n        if (k in t) return t[k];\n        if (typeof k === 'string') return Object.prototype.hasOwnProperty.call(backing, k) ? backing[k] : undefined;\n        return undefined;\n      },\n      set: function (t, k, v) { if (typeof k === 'string') { t.setItem(k, v); return true; } return false; },\n      deleteProperty: function (t, k) { if (typeof k === 'string') t.removeItem(k); return true; },\n      has: function (t, k) { return (k in t) || (typeof k === 'string' && Object.prototype.hasOwnProperty.call(backing, k)); },\n      ownKeys: function () { return Object.keys(backing); },\n      getOwnPropertyDescriptor: function (t, k) {\n        if (typeof k === 'string' && Object.prototype.hasOwnProperty.call(backing, k)) {\n          return { value: backing[k], writable: true, enumerable: true, configurable: true };\n        }\n        return undefined;\n      }\n    });\n  }\n  try {\n    Object.defineProperty(window, 'localStorage', { value: makeStorage(localStorage, 'ls'), configurable: true });\n    Object.defineProperty(window, 'sessionStorage', { value: makeStorage(sessionStorage, 'ss'), configurable: true });\n  } catch (e) { }\n\n  /* ============================================================\n     indexedDB + caches namespacing\n     ============================================================ */\n  try {\n    var __idb = indexedDB;\n    if (__idb) {\n      var pfx = 'sw_' + b64origin() + '_';\n      var idbProxy = new Proxy(__idb, {\n        get: function (t, k) {\n          if (k === 'open') return function (name) {\n            arguments[0] = pfx + name;\n            return t.open.apply(t, arguments);\n          };\n          if (k === 'deleteDatabase') return function (name) {\n            arguments[0] = pfx + name;\n            return t.deleteDatabase.apply(t, arguments);\n          };\n          if (k === 'databases') return function () {\n            return t.databases().then(function (dbs) {\n              return (dbs || []).filter(function (d) { return d.name.indexOf(pfx) === 0; })\n                .map(function (d) { return { name: d.name.slice(pfx.length), version: d.version }; });\n            });\n          };\n          var v = t[k];\n          return typeof v === 'function' ? v.bind(t) : v;\n        }\n      });\n      Object.defineProperty(window, 'indexedDB', { value: idbProxy, configurable: true });\n    }\n  } catch (e) { }\n\n  try {\n    var __caches = window.caches;\n    if (__caches) {\n      var cpfx = 'sw-' + b64origin() + '-';\n      var cacheProxy = new Proxy(__caches, {\n        get: function (t, k) {\n          if (k === 'open') return function (name) { return t.open(cpfx + name); };\n          if (k === 'has') return function (name) { return t.has(cpfx + name); };\n          if (k === 'delete') return function (name) { return t.delete(cpfx + name); };\n          if (k === 'keys') return function () {\n            return t.keys().then(function (ks) {\n              return (ks || []).filter(function (n) { return n.indexOf(cpfx) === 0; })\n                .map(function (n) { return n.slice(cpfx.length); });\n            });\n          };\n          var v = t[k];\n          return typeof v === 'function' ? v.bind(t) : v;\n        }\n      });\n      Object.defineProperty(window, 'caches', { value: cacheProxy, configurable: true });\n    }\n  } catch (e) { }\n\n  /* ============================================================\n     navigator.serviceWorker — never let sites register their own\n     ============================================================ */\n  try {\n    Object.defineProperty(navigator, 'serviceWorker', {\n      value: {\n        controller: null,\n        ready: Promise.reject(new DOMException('unsupported', 'UnsupportedError')),\n        register: function () { return Promise.reject(new DOMException('unsupported', 'UnsupportedError')); },\n        getRegistration: function () { return Promise.resolve(undefined); },\n        getRegistrations: function () { return Promise.resolve([]); },\n        addEventListener: function () { },\n        removeEventListener: function () { },\n        onmessage: null, oncontrollerchange: null\n      },\n      configurable: true\n    });\n  } catch (e) { }\n\n  /* ============================================================\n     Element URL properties (src / href / action / …)\n     Prototype-level get/set so runtime-created elements, jQuery\n     and frameworks all flow through the proxy.\n     ============================================================ */\n  var PROP_HOOKS = {\n    HTMLAnchorElement: { href: 1 },\n    HTMLAreaElement: { href: 1 },\n    HTMLScriptElement: { src: 1 },\n    HTMLImageElement: { src: 1 },\n    HTMLIFrameElement: { src: 1 },\n    HTMLLinkElement: { href: 1 },\n    HTMLFormElement: { action: 1 },\n    HTMLEmbedElement: { src: 1 },\n    HTMLObjectElement: { data: 1 },\n    HTMLSourceElement: { src: 1 },\n    HTMLTrackElement: { src: 1 },\n    HTMLMediaElement: { src: 1, poster: 1 },\n    HTMLInputElement: { formaction: 1 },\n    HTMLButtonElement: { formaction: 1 },\n    HTMLBaseElement: { href: 1 }\n  };\n  Object.keys(PROP_HOOKS).forEach(function (cls) {\n    try {\n      var proto = window[cls] && window[cls].prototype;\n      if (!proto) return;\n      Object.keys(PROP_HOOKS[cls]).forEach(function (prop) {\n        var d = Object.getOwnPropertyDescriptor(proto, prop);\n        if (!d || !d.get || !d.set) return;\n        Object.defineProperty(proto, prop, {\n          get: function () { return unrw(d.get.call(this)); },\n          set: function (v) {\n            try {\n              if (cls === 'HTMLBaseElement') return; /* <base> is poison — swallow */\n              d.set.call(this, rw(String(v)));\n            } catch (e) { d.set.call(this, v); }\n          },\n          configurable: true\n        });\n      });\n    } catch (e) { }\n  });\n\n  /* setAttribute / getAttribute for the same props */\n  try {\n    var __setattr = Element.prototype.setAttribute;\n    var __getattr = Element.prototype.getAttribute;\n    var TAG_PROPS = {\n      a: ['href'], area: ['href'], script: ['src'], img: ['src', 'srcset'], iframe: ['src'],\n      link: ['href'], form: ['action'], embed: ['src'], object: ['data'], source: ['src', 'srcset'],\n      track: ['src'], video: ['src', 'poster'], audio: ['src'], input: ['formaction'],\n      button: ['formaction'], base: []\n    };\n    function propAllowed(el, prop) {\n      var list = TAG_PROPS[(el.tagName || '').toLowerCase()];\n      return !!list && list.indexOf(prop) >= 0;\n    }\n    Element.prototype.setAttribute = function (name, value) {\n      try {\n        var ln = String(name).toLowerCase();\n        if (ln === 'integrity' || ln === 'referrerpolicy' || ln === 'crossorigin') return;\n        if (ln === 'srcdoc') {\n          arguments[1] = String(value);\n          return __setattr.apply(this, arguments);\n        }\n        if (ln === 'srcset' && propAllowed(this, 'srcset')) {\n          arguments[1] = String(value).split(/,\\s+/).map(function (p) {\n            var sp = p.trim().split(/\\s+/);\n            sp[0] = rw(sp[0]);\n            return sp.join(' ');\n          }).join(', ');\n          return __setattr.apply(this, arguments);\n        }\n        if (propAllowed(this, ln)) {\n          arguments[1] = rw(String(value));\n        }\n      } catch (e) { }\n      return __setattr.apply(this, arguments);\n    };\n    Element.prototype.getAttribute = function (name) {\n      var v = __getattr.call(this, name);\n      try {\n        var ln = String(name).toLowerCase();\n        if (v && propAllowed(this, ln)) return unrw(v);\n      } catch (e) { }\n      return v;\n    };\n  } catch (e) { }\n\n  /* ============================================================\n     HTML injection surfaces — innerHTML / outerHTML /\n     insertAdjacentHTML go through the parser, which bypasses the\n     property setters above. A single regex pass rewrites absolute\n     URLs before the parser ever sees them.\n     ============================================================ */\n  function quickHtmlStr(s) {\n    if (typeof s !== 'string' || s.indexOf('<') < 0) return s;\n    return s.replace(/(\\s(?:src|href|action|poster|formaction|data)\\s*=\\s*)(\"([^\"]*)\"|'([^']*)'|([^\\s\"'>]+))/gi,\n      function (m, pre, q, dq, sq, uq) {\n        var val = dq !== undefined ? dq : (sq !== undefined ? sq : uq);\n        if (!val || /^(data:|blob:|javascript:|about:|#|mailto:|tel:)/i.test(val) ||\n          val.indexOf(PREFIX) === 0) return m;\n        /* both absolute AND relative URLs — rw() resolves relative values\n           against the decoded page URL so the browser never has to guess\n           (critical when the document URL is a /service/ path). */\n        var r = rw(val);\n        if (r === val) return m;\n        if (dq !== undefined) return pre + '\"' + r.replace(/\"/g, '&quot;') + '\"';\n        if (sq !== undefined) return pre + \"'\" + r.replace(/'/g, '&#39;') + \"'\";\n        return pre + r;\n      });\n  }\n  try {\n    ['innerHTML', 'outerHTML'].forEach(function (prop) {\n      var d = Object.getOwnPropertyDescriptor(Element.prototype, prop);\n      if (!d || !d.set) return;\n      Object.defineProperty(Element.prototype, prop, {\n        get: function () { return d.get.call(this); },\n        set: function (v) { d.set.call(this, quickHtmlStr(v)); },\n        configurable: true\n      });\n    });\n    var __iah = Element.prototype.insertAdjacentHTML;\n    Element.prototype.insertAdjacentHTML = function (pos, html) {\n      try { arguments[1] = quickHtmlStr(html); } catch (e) { }\n      return __iah.apply(this, arguments);\n    };\n  } catch (e) { }\n\n  /* ============================================================\n     document.write / writeln — quick attribute rewrite\n     ============================================================ */\n  try {\n    var __write = Document.prototype.write, __writeln = Document.prototype.writeln;\n    Document.prototype.write = function () {\n      for (var i = 0; i < arguments.length; i++) {\n        arguments[i] = quickHtmlStr(arguments[i]);\n      }\n      return __write.apply(this, arguments);\n    };\n    Document.prototype.writeln = function () {\n      for (var i = 0; i < arguments.length; i++) {\n        arguments[i] = quickHtmlStr(arguments[i]);\n      }\n      return __writeln.apply(this, arguments);\n    };\n  } catch (e) { }\n\n  /* ============================================================\n     window.open — real popups through the proxy, blocked ones\n     become in-app tabs\n     ============================================================ */\n  try {\n    var __open = window.open;\n    window.open = function (u, name, features) {\n      var eu = (u == null || u === '') ? u : rw(String(u));\n      var w = null;\n      try { w = __open.call(window, eu, name, features); } catch (e) { }\n      if (!w && u) {\n        tellParent({ type: 'openTab', url: unrw(typeof eu === 'string' ? eu : String(u)) || String(u) });\n      }\n      return w;\n    };\n  } catch (e) { }\n\n  /* window.close inside the app: notify instead of failing */\n  try {\n    var __close = window.close;\n    window.close = function () {\n      if (IS_TOP) return __close.call(window);\n      tellParent({ type: 'closeRequest' });\n    };\n  } catch (e) { }\n\n  /* ============================================================\n     Click capture — neutralize target=_top / _parent at runtime\n     ============================================================ */\n  try {\n    document.addEventListener('click', function (e) {\n      try {\n        var el = e.target && e.target.closest ? e.target.closest('a[target],area[target],form[target]') : null;\n        if (!el) return;\n        var t = (el.getAttribute('target') || '').toLowerCase();\n        if (t === '_top' || t === '_parent') el.setAttribute('target', '_self');\n      } catch (err) { }\n    }, true);\n  } catch (e) { }\n\n  /* ============================================================\n     Meta reporting — title / favicon to the app UI\n     ============================================================ */\n  function pickIcon() {\n    try {\n      var links = document.querySelectorAll('link[rel~=\"icon\" i],link[rel=\"shortcut icon\" i],link[rel=\"apple-touch-icon\" i]');\n      for (var i = 0; i < links.length; i++) {\n        var h = links[i].getAttribute('href');\n        if (h) return unrw(h);\n      }\n    } catch (e) { }\n    return null;\n  }\n  function tellMeta() {\n    tellParent({ type: 'meta', title: document.title, favicon: pickIcon() });\n  }\n  try {\n    var mo = new MutationObserver(function () { tellMeta(); });\n    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['rel', 'href', 'src'] });\n  } catch (e) { }\n\n  /* load reporting */\n  try {\n    document.addEventListener('DOMContentLoaded', function () { tellNav({ phase: 'dcl' }); });\n    addEventListener('load', function () { tellNav({ phase: 'load', favicon: pickIcon(), loaded: true }); });\n    addEventListener('pageshow', function () { tellNav({ phase: 'pageshow' }); });\n    addEventListener('pagehide', function () { tellParent({ type: 'unloading' }); });\n  } catch (e) { }\n\n  /* error forwarding — lets the browser UI surface page errors */\n  try {\n    addEventListener('error', function (e) {\n      tellParent({\n        type: 'pageError',\n        msg: String(e.message || ''),\n        src: String(e.filename || ''),\n        line: e.lineno || 0\n      });\n    }, true);\n    addEventListener('unhandledrejection', function (e) {\n      var r = e.reason;\n      tellParent({\n        type: 'pageError',\n        msg: 'Unhandled rejection: ' + (r && r.message ? r.message : String(r)).slice(0, 200)\n      });\n    });\n  } catch (e) { }\n\n  /* ============================================================\n     Find in page — runs INSIDE the page document so it works even\n     when the iframe is cross-origin/sandboxed (file:// mode).\n     ============================================================ */\n  var findState = { marks: [], cur: -1 };\n  function findStyle(active) {\n    return active ? 'background:#ff9632;color:#000;border-radius:2px'\n      : 'background:#ffe58a;color:#000;border-radius:2px';\n  }\n  function findClear() {\n    findState.marks.forEach(function (m) {\n      try {\n        var p = m.parentNode;\n        if (p) p.replaceChild(document.createTextNode(m.textContent), m);\n      } catch (e) { }\n    });\n    try { if (document.body) document.body.normalize(); } catch (e) { }\n    findState = { marks: [], cur: -1 };\n  }\n  function findRun(q) {\n    findClear();\n    var ql = String(q || '').toLowerCase();\n    if (!ql) { tellParent({ type: 'findResult', total: 0, cur: -1 }); return; }\n    try {\n      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {\n        acceptNode: function (node) {\n          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;\n          var p = node.parentElement;\n          if (!p) return NodeFilter.FILTER_REJECT;\n          var t = p.tagName;\n          if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' ||\n            t === 'TEXTAREA' || t === 'INPUT') return NodeFilter.FILTER_REJECT;\n          return node.nodeValue.toLowerCase().indexOf(ql) >= 0 ?\n            NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;\n        }\n      });\n      var nodes = [];\n      while (walker.nextNode()) nodes.push(walker.currentNode);\n      nodes.forEach(function (node) {\n        var lv = node.nodeValue.toLowerCase(), i = 0;\n        while ((i = lv.indexOf(ql, i)) >= 0) {\n          var after = node.splitText(i);\n          var rest = after.splitText(ql.length);\n          var mark = document.createElement('mark');\n          mark.setAttribute('data-swfind', '1');\n          mark.style.cssText = findStyle(false);\n          after.parentNode.replaceChild(mark, after);\n          mark.appendChild(after);\n          findState.marks.push(mark);\n          node = rest;\n          lv = rest.nodeValue.toLowerCase();\n          i = 0;\n        }\n      });\n    } catch (e) { }\n    tellParent({ type: 'findResult', total: findState.marks.length, cur: findState.marks.length ? 0 : -1 });\n    if (findState.marks.length) findGo(0);\n  }\n  function findGo(idx) {\n    if (!findState.marks.length) return;\n    if (findState.cur >= 0 && findState.marks[findState.cur]) {\n      findState.marks[findState.cur].style.cssText = findStyle(false);\n    }\n    findState.cur = ((idx % findState.marks.length) + findState.marks.length) % findState.marks.length;\n    var m = findState.marks[findState.cur];\n    m.style.cssText = findStyle(true);\n    try { m.scrollIntoView({ block: 'center' }); } catch (e) { try { m.scrollIntoView(); } catch (e2) { } }\n    tellParent({ type: 'findResult', total: findState.marks.length, cur: findState.cur });\n  }\n\n  /* ============================================================\n     Parent commands — back / forward / reload / find. The app UI\n     cannot touch a cross-origin iframe's history or DOM directly,\n     so it drives them through this channel instead.\n     ============================================================ */\n  addEventListener('message', function (e) {\n    var d = e.data;\n    if (!d || d.__swcmd !== 1) return;\n    try {\n      switch (d.cmd) {\n        case 'back': history.back(); break;\n        case 'fwd': history.forward(); break;\n        case 'reload': location.reload(); break;\n        case 'find': findRun(d.q); break;\n        case 'findNext': findGo(findState.cur + 1); break;\n        case 'findPrev': findGo(findState.cur - 1); break;\n        case 'findClear': findClear(); break;\n      }\n    } catch (err) { }\n  });\n\n  /* initial report */\n  tellNav({ phase: 'start' });\n})();\n";
const APP_VERSION = '4.0.0';
const PREFIX = '/service/';
const MAX_HOPS = 12;
const FIRST_BYTE_TIMEOUT = 30000; /* ms — cleared once headers arrive */
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

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
   Returns the ORIGINAL string when rewriting is not applicable. */
function rwUrl(u, base) {
  if (typeof u !== 'string') return u;
  const s = u.trim();
  if (!s || s.charCodeAt(0) === 35 && s.length <= 1) return u;
  if (s.indexOf(PREFIX) === 0) return u;
  if (SKIP_SCHEME.test(s)) return u;
  const abs = resolveUrl(s, base);
  if (!abs) return u;
  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return u;
  if (abs.pathname.indexOf(PREFIX) === 0) return u; /* already proxied */
  return PREFIX + b64e(abs.href);
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
function rewriteCss(css, base) {
  if (!css) return css;
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      const r = rwUrl(entDecode(u), base);
      return r === u ? m : 'url(' + q + entEncode(r) + q + ')';
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => {
      const r = rwUrl(entDecode(u), base);
      return r === u ? m : '@import ' + q + entEncode(r) + q;
    })
    .replace(/image-set\(\s*([^)]*)\)/gi, (m, inner) => {
      const r = inner.replace(/(['"]?)([^'"\s,]+)\1(\s+[\d.]+[wx])/g, (mm, q2, u, d) => {
        const rr = rwUrl(entDecode(u), base);
        return rr === u ? mm : q2 + entEncode(rr) + q2 + d;
      });
      return r === inner ? m : 'image-set(' + r + ')';
    });
}

/* ============================================================
   JS rewriter — Pass B only (location/top/parent/document shims).
   String-literal rewriting was deliberately removed (corrupts
   regexes and constants); runtime hooks cover real URL flows.
   ============================================================ */
const JS_MIME = /^(|application\/(x-)?javascript|text\/(javascript|jscript|ecmascript)|module)$/i;

function rewriteJs(src, base) {
  if (!src) return src;
  try {
    src = src
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
      .replace(/\bdocument\s*\.\s*URL\b/g, '__swloc.href')
      .replace(/\bdocument\s*\.\s*baseURI\b/g, '__swloc.href')
      .replace(/\bdocument\s*\.\s*domain\b/g, '__swdoc.domain');
    /* module import specifiers (relative + absolute http(s) only) */
    src = src
      .replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.\/[^'"]+|\.\/|\/[^'"]+|https?:\/\/[^'"]+)\2/g,
        (m, pre, q, spec) => {
          const abs = resolveUrl(spec, base);
          if (!abs || (abs.protocol !== 'http:' && abs.protocol !== 'https:')) return m;
          return pre + q + PREFIX + b64e(abs.href) + q;
        });
  } catch (e) { /* keep partial result */ }
  return src;
}

/* ============================================================
   HTML rewriter — quote-aware tag scanner (server-side).
   Rewrites URL-bearing attributes, strips CSP/base/integrity,
   injects the runtime hook with per-site config.
   ============================================================ */
const URL_ATTRS = new Set(['href', 'src', 'action', 'formaction', 'poster', 'background',
  'cite', 'longdesc', 'manifest', 'archive', 'codebase', 'classid', 'profile', 'ping', 'icon']);
const DROP_ATTRS = new Set(['integrity', 'crossorigin', 'nonce', 'referrerpolicy', 'charset']);

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

function rewriteHtml(html, baseUrl, cfg) {
  const inject = '<script>__SWCFG=' + safeJsonInline(cfg) + ';</script>\n<script>' +
    HOOK_JS.replace(/<\/script/gi, '<\\/script') + '</script>\n';

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
      if (!closing && (tag === 'head' || tag === 'body' || tag === 'script')) {
        out += tagText + inject;
        injected = true;
        continue;
      }
    }

    /* <base> interferes with service-path resolution — drop it */
    if (tag === 'base' && !closing) { out += ''; continue; }

    if (tag === 'meta' && !closing) {
      const attrs = parseAttrs(tagText);
      const heq = (attrs.get('http-equiv') || '').toLowerCase();
      if (heq === 'content-security-policy' || heq === 'content-security-policy-report-only') continue;
      if (heq === 'refresh') {
        const c = attrs.get('content') || '';
        const rm = /^(\s*\d+\s*;?\s*url\s*=\s*)(.*)$/i.exec(c);
        if (rm) {
          let u = rm[2].trim().replace(/^['"]|['"]$/g, '');
          const r = rwUrl(entDecode(u), baseUrl);
          if (r !== u) {
            out += '<meta http-equiv="refresh" content="' + entEncode(rm[1] + r) + '">';
            continue;
          }
        }
      }
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
      const newTag = rewriteTag(tag, attrs, baseUrl, tagText);
      out += newTag;
      if (tag === 'style') {
        out += rewriteCss(raw, baseUrl);
      } else {
        const type = (attrs.get('type') || '').toLowerCase();
        const isJs = !type || JS_MIME.test(type);
        out += isJs ? rewriteJs(raw, baseUrl) : raw;
      }
      out += html.slice(rawEnd, cm ? rawEnd + cm[0].length : n);
      i = cm ? rawEnd + cm[0].length : n;
      continue;
    }

    /* regular tag */
    const attrs = parseAttrs(tagText);
    out += rewriteTag(tag, attrs, baseUrl, tagText);
  }

  if (!injected) out = inject + out;
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

/* rebuild a tag with rewritten attributes */
function rewriteTag(tag, attrs, baseUrl, origTagText) {
  const parts = [];
  const srcsetAttrs = new Set(['srcset', 'imagesrcset']);

  for (const [name, rawVal] of attrs) {
    if (DROP_ATTRS.has(name)) continue;

    /* event handlers → JS rewrite */
    if (name.startsWith('on') && rawVal) {
      parts.push(name + '="' + entEncode(rewriteJs(rawVal, baseUrl)) + '"');
      continue;
    }
    if (name === 'style' && rawVal) {
      parts.push('style="' + entEncode(rewriteCss(rawVal, baseUrl)) + '"');
      continue;
    }
    if (srcsetAttrs.has(name) && rawVal) {
      const rewritten = rawVal.split(/,\s+/).map(part => {
        if (/^\s*data:/i.test(part)) return part;
        const sp = part.trim().split(/\s+/);
        const r = rwUrl(entDecode(sp[0]), baseUrl);
        if (r !== sp[0]) sp[0] = entEncode(r);
        return sp.join(' ');
      }).join(', ');
      parts.push(name + '="' + entEncode(rewritten) + '"');
      continue;
    }
    if (name === 'target') {
      const t = String(rawVal || '').toLowerCase();
      if (t === '_top' || t === '_parent') { parts.push('target="_self"'); continue; }
      parts.push('target="' + entEncode(rawVal) + '"');
      continue;
    }
    if (name === 'sandbox') {
      parts.push('sandbox="' + entEncode(rawVal) + '"');
      continue;
    }
    if (URL_ATTRS.has(name) && rawVal) {
      if (tag === 'object' && name === 'data' && !/^\s*data:/i.test(rawVal)) {
        const r = rwUrl(entDecode(rawVal), baseUrl);
        parts.push('data="' + entEncode(r) + '"');
        continue;
      }
      if (tag === 'link') {
        const rel = (attrs.get('rel') || '').toLowerCase();
        if (rel && (rel.indexOf('preconnect') >= 0 || rel.indexOf('dns-prefetch') >= 0)) continue;
      }
      const r = rwUrl(entDecode(rawVal), baseUrl);
      parts.push(name + '="' + entEncode(r) + '"');
      continue;
    }
    if (rawVal === null || rawVal === undefined) { parts.push(name); continue; }
    parts.push(name + '="' + entEncode(rawVal) + '"');
  }

  return '<' + tag + (parts.length ? ' ' + parts.join(' ') : '') + '>';
}

/* rewrite srcdoc content (recursive, sync-safe quick rewrite) */
function rewriteSrcdoc(html, baseUrl) {
  let out = '';
  const re = /\s(?:src|href|action)\s*=\s*("([^"]*)"|'([^']*)')/gi;
  let last = 0, m;
  while ((m = re.exec(html))) {
    out += html.slice(last, m.index);
    const q = m[2] !== undefined ? '"' : "'";
    const val = m[2] !== undefined ? m[2] : m[3];
    const dec = entDecode(val);
    const r = rwUrl(dec, baseUrl);
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
    '<button onclick="location.reload()">Reload</button>' +
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

/* minimal shim prepended to worker scripts so they can live in the proxy too */
function workerShim(finalUrl) {
  return 'var __SWCFG=' + safeJsonInline({ url: finalUrl }) + ';\n' +
    '(function(){var E=function(u){try{var a=new URL(u,__SWCFG.url);if(a.protocol!=="http:"&&a.protocol!=="https:")return u;' +
    'var b=new TextEncoder().encode(a.href),s="";for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);' +
    'return "/service/"+btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")}catch(e){return u}};' +
    'var of=self.fetch;self.fetch=function(i,n){try{n=n||{};if(typeof i==="string"){i=E(i)}' +
    'else if(i&&i.url){i=new Request(E(i.url),i)}return of.call(self,i,n)}catch(e){return of.apply(self,arguments)}};})();\n';
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
   ============================================================ */
async function coreFetch(opts) {
  /* opts: { method, target, headers(Headers, sanitized), body,
             ua, cookie, referrer, origin, selfHost } */
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
  h.set('user-agent', opts.ua ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');
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
  if (sfd === 'document') return true;
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
      headers: respHeaders({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
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

  /* referrer for upstream (from the service path, or Referer header) */
  let refUrl = '';
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

  /* desktop-site UA override */
  let ua = null;
  try {
    const host = new URL(target).hostname;
    if (settings.desktopDefault || settings.uaHosts.has(host)) ua = DESKTOP_UA;
  } catch (e) { }

  const cookie = jar.headerFor(target, true);

  const r = await coreFetch({
    method: request.method, target, headers, body, ua, cookie,
    referrer: refUrl,
    origin: (refUrl && request.method !== 'GET') ? new URL(refUrl).origin : null,
    selfHost: url.host
  });

  if (!r.ok) {
    if (isNav) {
      return new Response(errPage(mapErrCode(r.error), safeHost(target), r.error, target), {
        status: 200,
        headers: respHeaders({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' })
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
  const isWorker = request.destination === 'worker' || request.destination === 'sharedworker';

  if (isWorker) {
    const src = await res.text();
    const bytes = new TextEncoder().encode(workerShim(finalUrl) + rewriteJs(src, finalUrl));
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
    const cfg = {
      url: finalUrl,
      cookieStr: jar.headerFor(finalUrl, false),
      referrer: refUrl,
      v: APP_VERSION
    };
    let out = rewriteHtml(text, finalUrl, cfg);
    /* second pass: srcdoc attributes get a quick rewrite */
    out = out.replace(/srcdoc\s*=\s*"([^"]*)"/gi, (m, val) => {
      const dec = entDecode(val);
      const rr = rewriteSrcdoc(dec, finalUrl);
      return 'srcdoc="' + entEncode(rr) + '"';
    });
    const bytes = new TextEncoder().encode(out);
    return new Response(bytes, {
      status,
      headers: respHeaders({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
        'access-control-allow-origin': '*'
      }, bytes.length)
    });
  }

  if (isCss) {
    const text = await res.text();
    const out = rewriteCss(text, finalUrl);
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
    const out = rewriteJs(text, finalUrl);
    const bytes = new TextEncoder().encode(out);
    return new Response(bytes, {
      status,
      headers: respHeaders({
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'no-store', 'access-control-allow-origin': '*'
      }, bytes.length)
    });
  }

  /* stream everything else untouched (images, video, fonts, JSON, …) */
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
    'access-control-allow-origin': '*'
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
