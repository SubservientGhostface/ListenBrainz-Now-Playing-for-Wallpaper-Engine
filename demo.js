/*
 * Browser preview only — never loaded inside Wallpaper Engine.
 * Fakes ListenBrainz (API and live connection) and the Cover Art Archive so the layout and every state can be
 * checked in a normal browser, without a real token:
 *
 *   index.html?demo            playing (purple cover)
 *   ?demo=amber  ?demo=teal    other covers
 *   ?demo=cycle                a new song is pushed every 8 s
 *   ?demo=idle                 token fine, nothing playing
 *   ?demo=notoken              no token entered yet
 *   ?demo=badtoken             token rejected
 *   ?demo=offline              ListenBrainz unreachable
 *   ?demo=nocover              song found, no cover
 *
 * The covers are generated abstract images, not real album art.
 */
(() => {
  const mode = (location.search.match(/demo=([a-z]+)/) || [])[1] || "purple";

  const looks = {
    purple: { hues: [275, 300, 200], title: "Midnight Signal", artist: "Demo Artist", album: "Placeholder Sessions" },
    amber:  { hues: [28, 8, 45],     title: "Warm Static",     artist: "Another Demo Artist", album: "Sample Record" },
    teal:   { hues: [175, 195, 150], title: "Low Tide Radio",  artist: "Demo Band", album: "" },
  };
  const order = Object.keys(looks);
  let current = looks[mode] ? mode : "purple";

  function makeArt(hues, seed) {
    const S = 600, c = document.createElement("canvas");
    c.width = c.height = S;
    const g = c.getContext("2d");
    let r = seed;
    const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    g.fillStyle = "#07050c"; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 70; i++) {
      const h = hues[i % hues.length], x = rnd() * S, y = rnd() * S, rad = 40 + rnd() * 220;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `hsla(${h}, 70%, ${35 + rnd() * 30}%, ${0.08 + rnd() * 0.18})`);
      gr.addColorStop(1, "transparent");
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }
    for (let i = 0; i < 400; i++) {
      g.fillStyle = `rgba(255,255,255,${rnd() * 0.7})`;
      g.fillRect(rnd() * S, rnd() * S, rnd() * 1.8, rnd() * 1.8);
    }
    g.strokeStyle = `hsla(${hues[0]}, 60%, 80%, 0.35)`; g.lineWidth = 2;
    g.beginPath(); g.arc(S / 2, S / 2, S * 0.22, 0, Math.PI * 2); g.stroke();
    return c.toDataURL("image/png");
  }
  const arts = {};
  order.forEach((k, i) => (arts[k] = makeArt(looks[k].hues, 7 + i)));

  // Cover Art Archive → generated images
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    get() { return srcDesc.get.call(this); },
    set(v) {
      const m = String(v).match(/coverartarchive\.org\/release\/demo-(\w+)\//);
      srcDesc.set.call(this, m && arts[m[1]] ? arts[m[1]] : v);
    },
  });

  // ListenBrainz API → canned answers
  window.__demoCalls = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, opts = {}) => {
    url = String(url);
    if (!url.startsWith("https://api.listenbrainz.org/")) return realFetch(url, opts);
    const auth = (opts.headers && opts.headers.Authorization) || "";
    window.__demoCalls.push({ url, auth });
    if (mode === "offline") throw new TypeError("Failed to fetch");
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/validate-token")) {
      return mode === "badtoken"
        ? json({ code: 200, message: "Token invalid.", valid: false })
        : json({ code: 200, message: "Token valid.", valid: true, user_name: "demo_user" });
    }
    if (url.includes("/playing-now")) {
      if (mode === "idle") return json({ payload: { count: 0, listens: [], playing_now: true, user_id: "demo_user" } });
      const t = looks[current];
      return json({ payload: { count: 1, playing_now: true, user_id: "demo_user", listens: [{
        playing_now: true,
        track_metadata: { artist_name: t.artist, track_name: t.title, release_name: t.album || undefined,
          additional_info: { media_player: "Kodama", submission_client: "Kodama" } },
      }] } });
    }
    if (url.includes("/metadata/lookup/")) {
      if (!auth) return json({ code: 401, error: "auth required" }, 401);
      if (mode === "nocover") return json({});
      const name = new URL(url).searchParams.get("recording_name");
      const key = order.find((k) => looks[k].title === name);
      return json({ recording_name: name, release_mbid: `demo-${key}` });
    }
    return json({ error: "not found" }, 404);
  };

  // ListenBrainz live connection → fake Socket.IO server that pushes playing_now
  const listenFor = (key) => {
    const t = looks[key];
    return { user_name: "demo_user", playing_now: true, track_metadata: {
      artist_name: t.artist, track_name: t.title, release_name: t.album || undefined,
      additional_info: { duration_ms: 240000, media_player: "Kodama" } } };
  };
  window.WebSocket = class FakeWS {
    constructor(url) {
      this.url = url; this.readyState = 0;
      setTimeout(() => {
        if (mode === "offline") { this.readyState = 3; return this.onclose && this.onclose({}); }
        this.readyState = 1;
        this._msg('0{"sid":"demo","upgrades":[],"pingInterval":25000,"pingTimeout":20000}');
        this._ping = setInterval(() => this._msg("2"), 25000);
      }, 50);
    }
    _msg(data) { this.onmessage && this.onmessage({ data }); }
    send(data) {
      if (data === "40") return this._msg('40{"sid":"demo"}');
      if (data.startsWith("42") && mode === "cycle") {
        let i = 0;
        this._cycle = setInterval(() => {
          i = (i + 1) % order.length; current = order[i];
          this._msg("42" + JSON.stringify(["playing_now", JSON.stringify(listenFor(current))]));
        }, 8000);
      }
    }
    close() { clearInterval(this._ping); clearInterval(this._cycle); this.readyState = 3; }
  };

  // Stand in for Wallpaper Engine sending the saved settings on start
  addEventListener("load", () => {
    window.wallpaperPropertyListener.applyUserProperties({
      listenbrainztoken: { value: mode === "notoken" ? "" : "demo-token-0000" },
    });
  });
})();
