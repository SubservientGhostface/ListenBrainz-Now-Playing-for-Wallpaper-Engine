/*
 * Ambient Now Playing — Wallpaper Engine web wallpaper (ListenBrainz edition)
 *
 * The person pastes their ListenBrainz user token into the wallpaper's settings.
 * The wallpaper never polls. It:
 *   1. asks ListenBrainz who the token belongs to, once      (GET /1/validate-token)
 *   2. opens ListenBrainz's live connection — the same one listenbrainz.org uses —
 *      and joins that user's room; ListenBrainz pushes a "playing_now" event the
 *      moment a player reports a new song
 *   3. asks once what's playing at start-up and after a reconnect (GET …/playing-now)
 *   4. finds each new song's cover through ListenBrainz's metadata lookup (needs the
 *      token) and loads it from the Cover Art Archive.
 *
 * Nothing is guessed: no song → "Nothing Playing", no cover found → a plain dark square.
 * ListenBrainz's "playing now" carries no timestamps, so there is no progress line.
 */
(() => {
  "use strict";

  const API = "https://api.listenbrainz.org/1";
  const LIVE_URL = "wss://listenbrainz.org/socket.io/?EIO=4&transport=websocket";
  const CAA = "https://coverartarchive.org";
  const MB = "https://musicbrainz.org/ws/2";
  const PLAYING_NOW_FALLBACK_S = 10 * 60;   // ListenBrainz's PLAYING_NOW_MAX_DURATION

  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const body = document.body;

  const el = {
    ambient: $("ambient"),
    art: $("art"),
    meta: $("meta"),
    title: $("title"),
    artist: $("artist"),
    album: $("album"),
    ticks: $("ticks"),
  };

  const settings = {
    idleText: "Nothing Playing",
    accentMode: "auto",
    customAccent: null,     // [r,g,b] 0–255
    reactive: false,
  };

  const state = {
    track: null,            // { key, title, artist, album, ... } or null
    palette: null,
  };

  const lb = {
    token: "",
    user: "",
    gen: 0,                 // bumps when the token changes, so old requests are ignored
    status: "no-token",     // no-token | checking | ok | bad-token | offline
    pausedAt: 0,
    authRetry: 0,           // how many times a refused token has been re-checked
  };

  /* ───────────────────────── colour helpers ───────────────────────── */

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h;
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    return [h * 60, s, l];
  }

  const hsla = (h, s, l, a = 1) =>
    `hsla(${h.toFixed(1)}, ${(s * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%, ${a})`;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const hueDist = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };

  /** Parses "#rrggbb", "rgb(…)", or Wallpaper Engine's "0.1 0.2 0.3" format. */
  function parseColor(str) {
    if (!str || typeof str !== "string") return null;
    str = str.trim();
    let m;
    if ((m = str.match(/^#?([0-9a-f]{6})$/i))) {
      const n = parseInt(m[1], 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    if ((m = str.match(/rgba?\(([^)]+)\)/i))) {
      const p = m[1].split(/[ ,]+/).map(Number);
      return p.length >= 3 ? p.slice(0, 3) : null;
    }
    const p = str.split(/\s+/).map(Number);
    if (p.length >= 3 && p.every((v) => isFinite(v))) {
      return p.slice(0, 3).map((v) => Math.round(v <= 1 ? v * 255 : v));
    }
    return null;
  }

  /**
   * Reads the artwork's dominant hues. Returns two hues for the glow pools plus an
   * accent, already toned down so the glow stays atmospheric and never neon.
   */
  function paletteFromImage(img) {
    const N = 40;
    const c = document.createElement("canvas");
    c.width = c.height = N;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, N, N);
    const data = ctx.getImageData(0, 0, N, N).data;

    const BINS = 24;
    const bins = Array.from({ length: BINS }, () => ({ w: 0, x: 0, y: 0, s: 0, l: 0 }));
    let total = 0;

    for (let i = 0; i < data.length; i += 4) {
      const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
      if (l < 0.07 || l > 0.96) continue;
      const w = s * s * (1 - Math.abs(l - 0.5) * 1.5);
      if (w <= 0.01) continue;
      const b = bins[Math.floor(h / (360 / BINS)) % BINS];
      const rad = (h * Math.PI) / 180;
      b.w += w; b.x += Math.cos(rad) * w; b.y += Math.sin(rad) * w;
      b.s += s * w; b.l += l * w;
      total += w;
    }

    // Mostly black/white/grey artwork: use a quiet neutral glow
    if (total < N * N * 0.012) {
      return makePalette({ h: 260, s: 0.06 }, { h: 230, s: 0.05 }, true);
    }

    // Merge each bin with its neighbours so a hue split across two bins still wins
    const scored = bins.map((b, i) => {
      const p = bins[(i + BINS - 1) % BINS], n = bins[(i + 1) % BINS];
      return { i, score: b.w + 0.5 * (p.w + n.w) };
    }).sort((a, b) => b.score - a.score);

    const toHue = (b) => {
      const h = (Math.atan2(b.y, b.x) * 180) / Math.PI;
      return { h: (h + 360) % 360, s: b.s / b.w, w: b.w };
    };

    const first = toHue(bins[scored[0].i]);
    let second = null;
    for (const cand of scored.slice(1)) {
      const b = bins[cand.i];
      if (b.w < first.w * 0.12) break;
      const hv = toHue(b);
      if (hueDist(hv.h, first.h) >= 35) { second = hv; break; }
    }
    // Single-hue cover: use a close neighbouring hue so the two pools still differ slightly
    if (!second) second = { h: (first.h + 22) % 360, s: first.s * 0.9 };

    return makePalette(first, second, false);
  }

  function makePalette(a, b, neutral) {
    // Yellows and olives turn muddy when darkened, so they get less saturation
    const mud = (h) => (h > 42 && h < 80 ? 0.6 : 1);
    const sa = neutral ? a.s : clamp(a.s, 0.35, 0.72) * mud(a.h);
    const sb = neutral ? b.s : clamp(b.s, 0.3, 0.68) * mud(b.h);
    return {
      neutral,
      // Grey glow reads much brighter than a coloured one, so neutral pools sit lower
      poolA: neutral ? [hsla(a.h, sa, 0.17, 0.9), hsla(a.h, sa, 0.12, 0.45)]
                     : [hsla(a.h, sa, 0.34, 0.95), hsla(a.h, sa, 0.26, 0.5)],
      poolB: neutral ? [hsla(b.h, sb, 0.14, 0.8), hsla(b.h, sb, 0.1, 0.4)]
                     : [hsla(b.h, sb, 0.28, 0.85), hsla(b.h, sb, 0.2, 0.42)],
      accent: neutral ? hsla(0, 0, 0.82) : hsla(a.h, clamp(a.s * 1.4, 0.75, 0.92), 0.6),
      accentSoft: neutral ? hsla(0, 0, 0.82, 0.25) : hsla(a.h, 0.85, 0.6, 0.35),
    };
  }

  function paletteFromRgb(rgb1, rgb2) {
    if (!rgb1) return null;
    const [h1, s1] = rgbToHsl(...rgb1);
    const [h2, s2] = rgb2 ? rgbToHsl(...rgb2) : [(h1 + 22) % 360, s1];
    const neutral = s1 < 0.12;
    return makePalette({ h: h1, s: s1 }, { h: h2, s: s2 }, neutral);
  }

  /** A 12×12 copy of the cover, used (scaled up and blurred) as the glow's base layer. */
  function tinyArt(img) {
    const c = document.createElement("canvas");
    c.width = c.height = 12;
    c.getContext("2d").drawImage(img, 0, 0, 12, 12);
    return c.toDataURL();
  }

  /* ───────────────────────── ambient background ───────────────────────── */

  function setAmbient(palette, tinySrc) {
    const layer = document.createElement("div");
    layer.className = "amb-layer";

    if (palette) {
      if (tinySrc) {
        const art = document.createElement("div");
        art.className = "amb-art";
        art.style.background = `url(${tinySrc}) center / 100% 100% no-repeat`;
        layer.appendChild(art);
      }
      const a = document.createElement("div");
      a.className = "amb-blob a";
      a.style.background = `radial-gradient(closest-side, ${palette.poolA[0]} 0%, ${palette.poolA[1]} 45%, transparent 100%)`;
      const b = document.createElement("div");
      b.className = "amb-blob b";
      b.style.background = `radial-gradient(closest-side, ${palette.poolB[0]} 0%, ${palette.poolB[1]} 45%, transparent 100%)`;
      layer.append(a, b);
    }

    const old = [...el.ambient.children];
    el.ambient.appendChild(layer);
    void layer.offsetWidth;
    layer.classList.add("is-visible");
    old.forEach((o) => {
      o.classList.remove("is-visible");
      setTimeout(() => o.remove(), 2000);
    });
  }

  function applyAccent() {
    let accent, soft;
    if (settings.accentMode === "custom" && settings.customAccent) {
      const [r, g, b] = settings.customAccent;
      accent = `rgb(${r}, ${g}, ${b})`;
      soft = `rgba(${r}, ${g}, ${b}, 0.35)`;
    } else if (state.palette) {
      accent = state.palette.accent;
      soft = state.palette.accentSoft;
    } else {
      accent = "rgba(255,255,255,0.8)";
      soft = "rgba(255,255,255,0.2)";
    }
    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-soft", soft);
  }

  /* ───────────────────────── cover art ───────────────────────── */

  const coverCache = new Map();   // track key → { src, cors, palette, tiny, at } (src null = miss)
  let artToken = 0;
  let shownArtSrc = null;

  function loadImage(src, cors) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (cors) img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  /** Loads a cover. Prefers a CORS load so its colours can be read; falls back to a plain load. */
  // YouTube answers a missing size with a tiny grey placeholder instead of an error
  const tooSmall = (img) => img.naturalWidth < 200 || img.naturalHeight < 150;

  async function tryCover(src) {
    try {
      const img = await loadImage(src, true);
      if (tooSmall(img)) return null;
      try {
        return { src, cors: true, palette: paletteFromImage(img), tiny: tinyArt(img) };
      } catch (_) { /* canvas blocked */ }
      return { src, cors: true, palette: null, tiny: null };
    } catch (_) {
      try {
        const img = await loadImage(src, false);
        if (tooSmall(img)) return null;
        return { src, cors: false, palette: null, tiny: null };
      } catch (_) {
        return null;
      }
    }
  }

  /*
   * Cover lookup — the same steps listenbrainz.org uses for its "Listening now" card
   * (frontend utils.getAlbumArtFromListenMetadata + Dashboard's playing-now lookup):
   *   1. a release / release group the scrobbler sent itself → its front cover,
   *      falling back to the release group's cover
   *   2. ListenBrainz metadata lookup by artist + title only (no album, like the site),
   *      using the caa_id / caa_release_mbid it returns
   *   3. otherwise the release group of the matched release
   *   4. the same again with the album name, in case 2 found nothing
   *   5. last resort, like the site: the YouTube thumbnail if the scrobbler sent a YouTube link
   */

  /** Front cover of a release or release group, from the Cover Art Archive's JSON. */
  async function caaFront(kind, mbid) {
    if (!mbid) return null;
    try {
      const res = await fetch(`${CAA}/${kind}/${mbid}`);
      if (!res.ok) return null;
      const body = await res.json();
      const img = (body.images || []).find((i) => i.front);
      if (!img) return null;
      const t = img.thumbnails || {};
      return String(t["500"] || t.large || img.image || "").replace(/^http:/, "https:") || null;
    } catch (_) {
      return null;
    }
  }

  /** Release → its release group, from MusicBrainz (what the site does too). */
  async function releaseGroupOf(releaseMbid) {
    if (!releaseMbid) return null;
    try {
      const res = await fetch(`${MB}/release/${releaseMbid}?inc=release-groups&fmt=json`);
      if (!res.ok) return null;
      const body = await res.json();
      return (body["release-group"] && body["release-group"].id) || null;
    } catch (_) {
      return null;
    }
  }

  async function lookup(track, withAlbum) {
    const q = new URLSearchParams({ recording_name: track.title, metadata: "true", inc: "artist tag release" });
    if (track.artist) q.set("artist_name", track.artist);
    if (withAlbum) q.set("release_name", track.album);
    return api(`/metadata/lookup/?${q}`);      // throws on network / auth / rate-limit
  }

  /** Yields candidate cover URLs, best first, only doing each request when it's needed. */
  async function* coverCandidates(track) {
    // 1. IDs the scrobbler sent itself
    if (track.userRelease || track.userReleaseGroup) {
      yield await caaFront("release", track.userRelease);
      yield await caaFront("release-group", track.userReleaseGroup || await releaseGroupOf(track.userRelease));
    }
    // IDs already mapped on the listen (rare for "playing now", but free if present)
    if (track.caaId && track.caaRelease) yield `${CAA}/release/${track.caaRelease}/${track.caaId}-500.jpg`;

    // 2–4. ListenBrainz lookup: artist + title first, then with the album
    const passes = track.album ? [false, true] : [false];
    const tried = new Set();
    for (const withAlbum of passes) {
      const r = await lookup(track, withAlbum);
      if (!r || !r.release_mbid || tried.has(r.release_mbid)) continue;
      tried.add(r.release_mbid);
      const rel = (r.metadata && r.metadata.release) || {};
      if (rel.caa_id && rel.caa_release_mbid) yield `${CAA}/release/${rel.caa_release_mbid}/${rel.caa_id}-500.jpg`;
      yield await caaFront("release-group", rel.release_group_mbid || await releaseGroupOf(r.release_mbid));
    }

    // 5. YouTube thumbnail
    if (track.youtubeId) {
      yield `https://i.ytimg.com/vi/${track.youtubeId}/maxresdefault.jpg`;
      yield `https://i.ytimg.com/vi/${track.youtubeId}/hqdefault.jpg`;
    }
  }

  const MISS_RETRY_MS = 30 * 60 * 1000;

  async function findCover(track) {
    const cached = coverCache.get(track.key);
    if (cached && (cached.src || Date.now() - cached.at < MISS_RETRY_MS)) return cached.src ? cached : null;

    const seen = new Set();
    let found = null;
    try {
      for await (const url of coverCandidates(track)) {
        if (!url || seen.has(url)) continue;
        seen.add(url);
        found = await tryCover(url);
        if (found) break;
      }
    } catch (e) {
      if (!found) return undefined;   // network / rate limit: don't remember it, retry later
    }
    coverCache.set(track.key, found ? { ...found, at: Date.now() } : { src: null, at: Date.now() });
    if (coverCache.size > 60) coverCache.delete(coverCache.keys().next().value);
    return found;
  }

  async function updateCover(track) {
    const token = ++artToken;
    const cover = await findCover(track);
    if (token !== artToken) return;            // a newer song took over meanwhile
    if (cover === undefined) {
      // Retry a failed lookup a couple of times (a one-off retry, not polling)
      track.coverPending = true;
      track.coverTries = (track.coverTries || 0) + 1;
      if (track.coverTries < 3) setTimeout(() => { if (state.track === track) updateCover(track); }, 15000 * track.coverTries);
      return;
    }
    track.coverPending = false;
    showCover(cover);
  }

  const NEUTRAL = () => makePalette({ h: 260, s: 0.06 }, { h: 230, s: 0.05 }, true);

  function showCover(cover) {
    if (!cover) {
      shownArtSrc = null;
      fadeOutArt();
      state.palette = NEUTRAL();
      setAmbient(state.palette, null);
      applyAccent();
      return;
    }
    if (cover.src === shownArtSrc) return;
    shownArtSrc = cover.src;

    state.palette = cover.palette || NEUTRAL();
    setAmbient(state.palette, cover.tiny);
    applyAccent();

    const img = new Image();
    if (cover.cors) img.crossOrigin = "anonymous";
    img.decoding = "async";
    img.onload = () => {
      if (shownArtSrc !== cover.src) return;
      const old = [...el.art.querySelectorAll("img")];
      el.art.appendChild(img);
      void img.offsetWidth;
      img.classList.add("is-visible");
      old.forEach((o) => { o.classList.remove("is-visible"); setTimeout(() => o.remove(), 1300); });
    };
    img.src = cover.src;
  }

  function fadeOutArt() {
    el.art.querySelectorAll("img").forEach((o) => {
      o.classList.remove("is-visible");
      setTimeout(() => o.remove(), 1300);
    });
  }

  /* ───────────────────────── text ───────────────────────── */

  let swapTimer = null;
  const shown = { title: null, artist: null, album: null };

  function setMeta(title, artist, album) {
    if (title === shown.title && artist === shown.artist && album === shown.album) return;
    const first = shown.title === null;
    Object.assign(shown, { title, artist, album });
    clearTimeout(swapTimer);
    const write = () => {
      el.title.textContent = title;
      el.artist.textContent = artist;
      el.album.textContent = album;
      el.meta.classList.remove("is-swapping");
    };
    if (first) return write();
    el.meta.classList.add("is-swapping");
    swapTimer = setTimeout(write, 350);
  }

  const HINTS = {
    "no-token": "",
    "checking": "",
    "bad-token": "",
    "offline": "Can’t reach ListenBrainz. Reconnecting…",
    "ok": "",
  };

  function paint() {
    const idle = !state.track;
    body.classList.toggle("is-idle", idle);

    const setup = idle && (lb.status === "no-token" || lb.status === "bad-token");
    body.classList.toggle("needs-setup", setup);
    if (setup) {
      const bad = lb.status === "bad-token";
      $("setup-title").textContent = bad ? "That token didn’t work" : "Connect ListenBrainz";
      $("setup-note").textContent = bad
        ? "ListenBrainz didn’t accept it. Copy it again and paste the whole thing."
        : "This wallpaper shows what you’re playing on ListenBrainz.";
    }
    if (idle) {
      setMeta(settings.idleText, HINTS[lb.status] || "", "");
      if (shownArtSrc !== null || el.art.querySelector("img")) {
        shownArtSrc = null; artToken++; fadeOutArt();
      }
    } else {
      setMeta(state.track.title, state.track.artist, state.track.album);
    }
  }

  /* ───────────────────────── ListenBrainz ───────────────────────── */

  async function api(path) {
    const headers = {};
    if (lb.token) headers.Authorization = `Token ${lb.token}`;
    let res;
    try {
      res = await fetch(API + path, { headers, cache: "no-store" });
    } catch (_) {
      throw { network: true };
    }
    if (res.status === 401) throw { auth: true };
    if (res.status === 429) {
      const wait = Number(res.headers.get("X-RateLimit-Reset-In"));
      throw { rate: isFinite(wait) && wait > 0 ? wait : 60 };
    }
    if (!res.ok) throw { http: res.status };
    return res.json();
  }

  function youtubeId(url) {
    const m = String(url || "").match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([\w-]{11})/);
    return m ? m[1] : null;
  }

  function trackFromListen(listen) {
    const m = (listen && listen.track_metadata) || {};
    const title = (m.track_name || "").trim();
    const artist = (m.artist_name || "").trim();
    if (!title) return null;
    const info = m.additional_info || {};
    const map = m.mbid_mapping || {};
    const album = (m.release_name || "").trim();

    // ListenBrainz keeps "playing now" for the song's length, or 10 minutes if none was sent
    let seconds = Number(info.duration);
    if (!(seconds > 0)) seconds = Number(info.duration_ms) / 1000;
    if (!(seconds > 0)) seconds = PLAYING_NOW_FALLBACK_S;

    return {
      key: `${artist}\u0000${title}\u0000${album}`.toLowerCase(),
      sameSong: `${artist}\u0000${title}`,     // what ListenBrainz itself compares
      title, artist, album,
      seconds,
      userRelease: m.release_mbid || info.release_mbid || null,
      userReleaseGroup: info.release_group_mbid || null,
      caaId: map.caa_id || null,
      caaRelease: map.caa_release_mbid || null,
      youtubeId: youtubeId(info.origin_url) || youtubeId(info.youtube_id ? `https://youtu.be/${info.youtube_id}` : ""),
    };
  }

  /*
   * ListenBrainz sends no event when "playing now" ends; it just expires it after the
   * song's length. This timer does the same on our side so the screen goes back to
   * "Nothing Playing" when ListenBrainz's own page would.
   */
  let expiryTimer = null;
  function armExpiry(seconds) {
    clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => setTrack(null), seconds * 1000 + 2000);
  }

  function setTrack(track, { fromEvent = false } = {}) {
    if (!track) {
      clearTimeout(expiryTimer);
      if (state.track) { state.track = null; paint(); }
      return;
    }
    if (state.track && track.key === state.track.key) {
      // ListenBrainz ignores a repeat of the same song while it's still "playing now"
      // (no event, expiry not reset), so only a real event re-arms the timer.
      if (fromEvent) armExpiry(track.seconds);
      if (state.track.coverPending) updateCover(state.track);
      return;
    }
    state.track = track;
    armExpiry(track.seconds);
    paint();
    updateCover(track);
  }

  /** One request: what's playing right now. Used at start-up and after a reconnect only. */
  async function refreshOnce(gen) {
    const data = await api(`/user/${encodeURIComponent(lb.user)}/playing-now`);
    if (gen !== lb.gen) return;
    const listens = (data && data.payload && data.payload.listens) || [];
    setTrack(trackFromListen(listens[0]));
  }

  /* ── Live connection: ListenBrainz's Socket.IO server (Engine.IO v4 over a WebSocket) ── */

  const live = { ws: null, retry: 0, retryTimer: null, pingTimer: null, pingWait: 45000 };

  function closeLive() {
    clearTimeout(live.retryTimer);
    clearTimeout(live.pingTimer);
    if (live.ws) {
      live.ws.onopen = live.ws.onmessage = live.ws.onclose = live.ws.onerror = null;
      try { live.ws.close(); } catch (_) {}
      live.ws = null;
    }
  }

  function retryLater(gen) {
    closeLive();
    if (gen !== lb.gen || !lb.token) return;
    // Back off 2 s, 4 s, 8 s … up to 2 min. This only runs while disconnected.
    const wait = Math.min(120000, 2000 * 2 ** live.retry++);
    live.retryTimer = setTimeout(() => start(gen), wait);
  }

  function watchdog(gen) {
    // The server pings every ~25 s; if nothing arrives for a while the connection is dead
    clearTimeout(live.pingTimer);
    live.pingTimer = setTimeout(() => retryLater(gen), live.pingWait);
  }

  function openLive(gen) {
    closeLive();
    let ws;
    try {
      ws = new WebSocket(LIVE_URL);
    } catch (_) {
      return retryLater(gen);
    }
    live.ws = ws;

    ws.onmessage = (ev) => {
      if (gen !== lb.gen) return;
      const msg = String(ev.data);
      const type = msg[0];
      if (type === "0") {                         // Engine.IO open
        try {
          const o = JSON.parse(msg.slice(1));
          live.pingWait = (o.pingInterval || 25000) + (o.pingTimeout || 20000) + 5000;
        } catch (_) {}
        ws.send("40");                            // join the default namespace
        watchdog(gen);
      } else if (type === "2") {                  // ping → pong
        ws.send("3");
        watchdog(gen);
      } else if (msg.startsWith("40")) {          // namespace joined
        ws.send(`42${JSON.stringify(["json", { user: lb.user }])}`);   // join our room
        live.retry = 0;
        lb.status = "ok";
        paint();
        // Catch up on anything that started while we weren't connected
        refreshOnce(gen).catch(() => {});
      } else if (msg.startsWith("42")) {          // event
        let arr;
        try { arr = JSON.parse(msg.slice(2)); } catch (_) { return; }
        if (!Array.isArray(arr) || arr[0] !== "playing_now") return;
        let listen = arr[1];
        if (typeof listen === "string") { try { listen = JSON.parse(listen); } catch (_) { return; } }
        if (listen && listen.user_name && lb.user &&
            listen.user_name.toLowerCase() !== lb.user.toLowerCase()) return;
        setTrack(trackFromListen(listen), { fromEvent: true });
      } else if (msg.startsWith("41") || msg.startsWith("44") || type === "1") {
        // server dropped us from the namespace / refused it / is closing: reconnect
        retryLater(gen);
      }
    };
    ws.onclose = () => { if (gen === lb.gen) retryLater(gen); };
    ws.onerror = () => {};
  }

  /** Token → username (once), then the live connection. */
  async function start(gen) {
    if (gen !== lb.gen || !lb.token) return;
    try {
      if (!lb.user) {
        const v = await api("/validate-token");
        if (gen !== lb.gen) return;
        if (!v || !v.valid || !v.user_name) throw { auth: true };
        lb.user = v.user_name;
        lb.authRetry = 0;
      }
      openLive(gen);
    } catch (e) {
      if (gen !== lb.gen) return;
      if (e && e.auth) {
        lb.status = "bad-token";
        lb.user = "";
        setTrack(null);
        paint();
        // Usually the token really is wrong, but ListenBrainz can also refuse it during a
        // hiccup. Check again after 1, 5, then every 15 minutes — only while it's refused.
        const waits = [60, 300, 900];
        const wait = waits[Math.min(lb.authRetry++, waits.length - 1)] * 1000;
        closeLive();
        live.retryTimer = setTimeout(() => start(gen), wait);
        return;
      }
      if (!state.track) lb.status = "offline";
      paint();
      if (e && e.rate) {
        closeLive();
        live.retryTimer = setTimeout(() => start(gen), e.rate * 1000);
      } else {
        retryLater(gen);
      }
    }
  }

  let tokenTimer = null;
  let firstToken = true;
  function setToken(raw) {
    const t = String(raw || "").trim().replace(/^Token\s+/i, "");
    clearTimeout(tokenTimer);
    const apply = () => {
      // The same token again: leave a working connection alone, but use it as a
      // "try again" for anything that isn't connected
      if (t === lb.token && t && lb.status === "ok") return;
      if (t === lb.token && !t) return;
      lb.token = t;
      lb.user = "";
      lb.gen++;
      live.retry = 0;
      lb.authRetry = 0;
      closeLive();
      lb.status = t ? "checking" : "no-token";
      setTrack(null);
      paint();
      if (t) start(lb.gen);
    };
    // The saved token arrives once when the wallpaper loads: use it straight away.
    // After that, Wallpaper Engine may send every keystroke, so wait until typing stops.
    if (firstToken) { firstToken = false; apply(); }
    else tokenTimer = setTimeout(apply, 700);
  }

  /** Try again now (network back, wallpaper resumed) if we aren't connected. */
  function kick() {
    if (!lb.token || lb.status === "ok" || lb.status === "checking" && live.ws) return;
    clearTimeout(live.retryTimer);     // replace any scheduled retry, don't add a second one
    live.retry = 0;
    start(lb.gen);
  }
  addEventListener("online", kick);

  /* ───────────────────────── markers ───────────────────────── */

  let ticks = [];

  function buildTicks() {
    const u = Math.min(innerHeight / 100, innerWidth * 0.005625);
    const width = el.ticks.clientWidth || innerWidth;
    const count = Math.max(16, Math.round(width / (3.65 * u)));
    if (count === ticks.length) return;
    el.ticks.textContent = "";
    ticks = [];
    for (let i = 0; i < count; i++) {
      const t = document.createElement("div");
      t.className = "tick";
      el.ticks.appendChild(t);
      ticks.push(t);
    }
  }

  // Optional: markers follow the PC's audio output (Wallpaper Engine's audio listener)
  let audioRegistered = false;
  let levels = [];

  function onAudio(arr) {
    if (!settings.reactive || !ticks.length) return;
    const n = ticks.length;
    if (levels.length !== n) levels = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const band = Math.floor((i / n) * 64);
      const v = Math.min(1, ((arr[band] || 0) + (arr[band + 64] || 0)) / 2);
      levels[i] = levels[i] * 0.6 + v * 0.4;
      ticks[i].style.transform = `scaleY(${(1 + levels[i] * 2.4).toFixed(3)})`;
    }
  }

  function setReactive(on) {
    settings.reactive = on;
    body.classList.toggle("reactive", on);
    if (on && !audioRegistered && typeof window.wallpaperRegisterAudioListener === "function") {
      window.wallpaperRegisterAudioListener(onAudio);
      audioRegistered = true;
    }
    if (!on) ticks.forEach((t) => (t.style.transform = ""));
  }

  /* ───────────────────────── user properties ───────────────────────── */

  window.wallpaperPropertyListener = {
    applyUserProperties(p) {
      if (p.listenbrainztoken) setToken(p.listenbrainztoken.value);
      if (p.artworksize) root.style.setProperty("--art-size", p.artworksize.value);
      if (p.verticalposition) root.style.setProperty("--offset-y", -p.verticalposition.value);
      if (p.glowintensity) root.style.setProperty("--glow", p.glowintensity.value / 100);
      if (p.showalbum) body.classList.toggle("hide-album", !p.showalbum.value);
      if (p.showmarkers) body.classList.toggle("hide-markers", !p.showmarkers.value);
      if (p.ambientmotion) body.classList.toggle("motion", !!p.ambientmotion.value);
      if (p.reactivemarkers) setReactive(!!p.reactivemarkers.value);
      if (p.idletext) { settings.idleText = p.idletext.value || "Nothing Playing"; paint(); }
      if (p.accentmode) settings.accentMode = p.accentmode.value;
      if (p.accentcolor) settings.customAccent = parseColor(p.accentcolor.value);
      if (p.accentmode || p.accentcolor) applyAccent();
      if (p.artworksize || p.verticalposition) requestAnimationFrame(buildTicks);
    },
    // Wallpaper Engine pauses wallpapers behind full-screen apps. Events may be missed
    // meanwhile, so after a long pause catch up once (or reconnect if the link dropped).
    setPaused(isPaused) {
      if (isPaused) { lb.pausedAt = Date.now(); return; }
      const away = lb.pausedAt ? Date.now() - lb.pausedAt : 0;
      lb.pausedAt = 0;
      if (!lb.token) return;
      if (lb.status !== "ok") return kick();
      if (away < 30000) return;
      if (live.ws && live.ws.readyState === 1) refreshOnce(lb.gen).catch(() => {});
      else { live.retry = 0; start(lb.gen); }
    },
  };

  /* ───────────────────────── start ───────────────────────── */

  addEventListener("resize", buildTicks);
  buildTicks();
  applyAccent();
  setAmbient(null, null);
  paint();
})();
