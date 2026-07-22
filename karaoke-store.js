/* karaoke-store.js — out-of-the-box persistence + simple users for voice-built sites.
 *
 * Works identically in the local preview and on static hosting (GitHub Pages):
 *   • localStorage is the source of truth in the browser → data survives refresh.
 *   • When the karaoke preview server is running, every write is mirrored to
 *     /api/data → JSON files under data/ in the site's git repo, so your data is
 *     versioned with the site and deploys with it as read-only seed data.
 *   • On static hosting, reads fall back to those committed data/*.json files.
 *
 * API (all async unless noted):
 *   kstore.set(key, value)          kstore.get(key, fallback?)
 *   kstore.del(key)                 kstore.keys()
 *   kstore.user.current()  (sync)   kstore.user.signup(name, password)
 *   kstore.user.login(name, password)                kstore.user.logout()  (sync)
 *   kstore.user.list()              kstore.user.isAdmin(name?)
 *   kstore.user.setAdmin(name, isAdmin)   — admins only.
 *   The first signup creates the admin and signs them in. After that, signup
 *   only works for a logged-in admin (creates a regular account; the admin
 *   stays signed in) and admin rights are granted via setAdmin.
 *
 * Data is namespaced per signed-in user (or "guest"). Passwords are stored as
 * salted SHA-256 hashes.
 *
 * ⚠️ Honest limits: on a public static host there is NO server enforcing anything —
 * this auth keeps casual users separated, it does not protect secrets. For real
 * security ask Claude Karaoke to wire the site to a hosted backend
 * (OAuth, Firebase/Supabase, your own API); this library is built to be replaced.
 */
(function () {
  "use strict";
  const SITE = "ks:" + location.pathname.replace(/[^a-z0-9]/gi, "_");
  const API = "/api/data";
  let apiOk = null;

  async function apiAvailable() {
    if (apiOk !== null) return apiOk;
    try { apiOk = (await fetch(API, { method: "GET" })).ok; }
    catch (e) { apiOk = false; }
    return apiOk;
  }

  // ---- raw path helpers (path = "seg/seg", NOT user-namespaced) ----
  const lsKey = (path) => SITE + ":" + path;
  function rawLocal(path, fallback) {
    const s = localStorage.getItem(lsKey(path));
    if (s !== null) { try { return JSON.parse(s); } catch (e) {} }
    return fallback;
  }
  async function rawGet(path, fallback) {
    const local = localStorage.getItem(lsKey(path));
    if (local !== null) { try { return JSON.parse(local); } catch (e) {} }
    try {                                   // local dev API
      const r = await fetch(`${API}/${path}`);
      if (r.ok) { const v = await r.json(); localStorage.setItem(lsKey(path), JSON.stringify(v)); return v; }
    } catch (e) {}
    try {                                   // deployed: committed seed data
      const r = await fetch(`data/${path}.json`, { cache: "no-store" });
      if (r.ok) { const v = await r.json(); localStorage.setItem(lsKey(path), JSON.stringify(v)); return v; }
    } catch (e) {}
    return fallback;
  }
  async function rawSet(path, value) {
    localStorage.setItem(lsKey(path), JSON.stringify(value));
    if (await apiAvailable()) {
      try { await fetch(`${API}/${path}`, { method: "PUT", body: JSON.stringify(value) }); } catch (e) {}
    }
    return value;
  }
  async function rawDel(path) {
    localStorage.removeItem(lsKey(path));
    if (await apiAvailable()) {
      try { await fetch(`${API}/${path}`, { method: "DELETE" }); } catch (e) {}
    }
  }

  // ---- users ----
  async function sha256(text) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const USERS = "system/users";
  const clean = (name) => String(name || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");

  const user = {
    current() { return sessionStorage.getItem(SITE + ":user") || null; },
    async signup(name, password) {
      name = clean(name);
      if (!name) throw new Error("invalid username");
      if (!password) throw new Error("password required");
      const users = (await rawGet(USERS, {})) || {};
      const first = Object.keys(users).length === 0;
      if (!first) {
        const me = user.current();
        if (!me || !users[me] || !users[me].admin)
          throw new Error("only a logged-in admin can create accounts");
      }
      if (users[name]) throw new Error("user already exists");
      const salt = [...crypto.getRandomValues(new Uint8Array(8))]
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      users[name] = { salt, hash: await sha256(salt + password), admin: first };
      await rawSet(USERS, users);
      if (first) sessionStorage.setItem(SITE + ":user", name);
      return name;
    },
    async login(name, password) {
      name = clean(name);
      const users = (await rawGet(USERS, {})) || {};
      const rec = users[name];
      if (!rec || rec.hash !== (await sha256(rec.salt + password)))
        throw new Error("wrong username or password");
      sessionStorage.setItem(SITE + ":user", name);
      return name;
    },
    logout() { sessionStorage.removeItem(SITE + ":user"); },
    async list() {
      const users = (await rawGet(USERS, {})) || {};
      return Object.keys(users).sort().map((n) => ({ name: n, admin: !!users[n].admin }));
    },
    async isAdmin(name) {
      name = clean(name || user.current());
      if (!name) return false;
      const users = (await rawGet(USERS, {})) || {};
      return !!(users[name] && users[name].admin);
    },
    async setAdmin(name, admin) {
      name = clean(name);
      const users = (await rawGet(USERS, {})) || {};
      const me = user.current();
      if (!me || !users[me] || !users[me].admin)
        throw new Error("only an admin can change admin rights");
      if (!users[name]) throw new Error("no such user");
      if (!admin) {
        const admins = Object.keys(users).filter((n) => users[n].admin);
        if (admins.length === 1 && admins[0] === name)
          throw new Error("cannot remove the last admin");
      }
      users[name].admin = !!admin;
      await rawSet(USERS, users);
      return true;
    },
  };

  // ---- namespaced store ----
  const ns = (key) => `u/${user.current() || "guest"}/${key}`;
  window.kstore = {
    set: (key, value) => rawSet(ns(key), value),
    get: (key, fallback = null) => rawGet(ns(key), fallback),
    del: (key) => rawDel(ns(key)),
    async keys() {
      const prefix = ns("");
      const found = new Set();
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith(lsKey(prefix))) found.add(k.slice(lsKey(prefix).length));
      }
      if (await apiAvailable()) {
        try {
          const r = await fetch(API);
          if (r.ok) for (const k of (await r.json()).keys || [])
            if (k.startsWith(prefix)) found.add(k.slice(prefix.length));
        } catch (e) {}
      }
      return [...found].sort();
    },
    user,
  };
})();
