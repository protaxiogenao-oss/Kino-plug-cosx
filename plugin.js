/// <reference path="./kino.d.ts" />

/**
 * CosXplay (cosxplay.com) for Kino v1.3.0
 * Same capabilities as 123AV: search / home / browse / resolve,
 * quality setting, streamHosts any, CloudStream-style Referer root + capture fallback (fix 403 TV).
 *
 * Listings: WordPress cards with data-post-id + 320x180 thumbs.
 * Filters: /?filter=latest|most-viewed|best|longest
 * Categories: /{id}-{slug}/ e.g. 7841-nier-automata (2B)
 * Resolve: browser.capture → pass media.headers+Cookie (needed on Android TV
 * to avoid CDN 403); HTML <source high|low> as fallback.
 */

const BASE = "https://cosxplay.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function headers(extra) {
  const h = {
    "User-Agent": UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: BASE + "/",
  };
  if (extra) for (const k in extra) h[k] = extra[k];
  return h;
}

function log(...args) {
  try {
    kino.log(...args);
  } catch (_) {}
}

function preferredQuality() {
  const q = String(kino.config.get("quality") || "high").toLowerCase();
  return q === "low" ? "low" : "high";
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCharCode(parseInt(n, 10));
      } catch {
        return "";
      }
    })
    .replace(/\s+/g, " ")
    .trim();
}

function parseDurationMin(text) {
  const t = String(text || "").trim();
  if (!t) return undefined;
  let m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) {
    if (m[3] != null) {
      return Math.max(
        1,
        Math.round(
          (parseInt(m[1], 10) * 3600 +
            parseInt(m[2], 10) * 60 +
            parseInt(m[3], 10)) /
            60
        )
      );
    }
    return Math.max(
      1,
      Math.round((parseInt(m[1], 10) * 60 + parseInt(m[2], 10)) / 60)
    );
  }
  m = /(\d+)\s*min/i.exec(t);
  if (m) return parseInt(m[1], 10) || undefined;
  return undefined;
}

function toItem(v) {
  const thumb = v.thumb || undefined;
  return {
    id: v.id,
    ref: v.ref || v.id,
    title: v.title,
    kind: "movie",
    poster: thumb,
    backdrop: thumb,
    quality: v.hd ? "HD" : undefined,
    runtimeMinutes: v.runtimeMinutes,
    adult: true,
  };
}

/**
 * Parse video cards from listing HTML.
 * Cards look like: data-post-id="67084" … <a class="thumb" href="…/67084-slug/" aria-label="Title">
 */
function parseListing(html) {
  const items = [];
  const seen = {};
  const src = String(html || "");
  const re = /data-post-id="(\d+)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const id = m[1];
    if (seen[id]) continue;
    const block = src.slice(Math.max(0, m.index - 120), m.index + 2200);

    // Must look like a video thumb card (not a bare category tile)
    if (
      block.indexOf("video-img") < 0 &&
      block.indexOf("data-trailer") < 0 &&
      block.indexOf('class="thumb"') < 0
    ) {
      continue;
    }

    const hrefM = /href="(https?:\/\/cosxplay\.com\/(\d+)-([^"/]+)\/)"/i.exec(
      block
    );
    if (!hrefM) continue;
    // Prefer matching post id in path
    if (hrefM[2] !== id) {
      // still ok if nearby card
    }

    let title = "";
    const al = /aria-label="([^"]{3,200})"/i.exec(block);
    const alt = /alt="([^"]{3,200})"/i.exec(block);
    if (al) title = decodeEntities(al[1]);
    else if (alt) title = decodeEntities(alt[1]);
    else title = decodeEntities((hrefM[3] || id).replace(/-/g, " "));
    if (title.length > 200) title = title.slice(0, 197) + "…";

    let thumb;
    const img =
      /(?:data-src|src)="(https?:\/\/cosxplay\.com\/storage\/[^"]+\.(?:jpg|jpeg|webp|png)[^"]*)"/i.exec(
        block
      ) ||
      /(?:data-src|src)="(https?:\/\/[^"]+\/storage\/[^"]+\.(?:jpg|jpeg|webp|png)[^"]*)"/i.exec(
        block
      );
    if (img) thumb = img[1];

    let runtimeMinutes;
    const dur =
      /class="[^"]*duration[^"]*"[^>]*>([^<]+)</i.exec(block) ||
      />(\d+\s*min)</i.exec(block) ||
      />(\d+:\d{2}(?::\d{2})?)</.exec(block);
    if (dur) runtimeMinutes = parseDurationMin(dur[1]);

    const ref = id + "-" + (hrefM[3] || "v");
    seen[id] = true;
    items.push({
      id: id,
      ref: ref,
      title: title,
      thumb: thumb,
      runtimeMinutes: runtimeMinutes,
      hd: /hd|1080|720/i.test(block),
    });
    if (items.length >= 80) break;
  }
  return items;
}

async function fetchHtml(pathOrUrl) {
  const url =
    pathOrUrl.indexOf("http") === 0
      ? pathOrUrl
      : BASE + (pathOrUrl.charAt(0) === "/" ? pathOrUrl : "/" + pathOrUrl);
  const r = await kino.fetch(url, {
    headers: headers(),
    cookies: true,
    timeoutMs: 25000,
  });
  if (r.status === 429) throw kino.error("rate_limited", "demasiadas peticiones");
  if (r.status === 404) throw kino.error("not_found");
  if (!r.ok) {
    // Cloudflare often returns 403 to bots; surface a clear message
    if (r.status === 403) {
      throw kino.error(
        "unavailable",
        "cloudflare 403",
        {
          userMessage:
            "CosXplay bloqueó la petición (Cloudflare). Prueba más tarde o actualiza Kino.",
        }
      );
    }
    throw kino.error("unavailable", "el sitio respondió " + r.status);
  }
  const html = r.text();
  if (
    /just a moment|cf-browser-verification|turnstile|verify you are human/i.test(
      html
    ) &&
    html.length < 20000
  ) {
    throw kino.error("unavailable", "cloudflare challenge", {
      userMessage:
        "CosXplay pide verificación humana (Cloudflare). Kino no puede completar ese captcha.",
    });
  }
  return { html: html, url: r.url || url };
}

function filterPath(filter, page) {
  const f = filter || "latest";
  let path = "/?filter=" + encodeURIComponent(f);
  if (page && page > 1) {
    path = "/page/" + page + "/?filter=" + encodeURIComponent(f);
  }
  return path;
}

function categoryPath(slugPath, page) {
  // slugPath like "7841-nier-automata" or "/7841-nier-automata/"
  let p = String(slugPath || "").replace(/^\/+|\/+$/g, "");
  if (!p) p = "";
  let path = "/" + p + "/";
  if (page && page > 1) path = "/" + p + "/page/" + page + "/";
  return path;
}

async function rowFrom(path, id, title, limit, excludeIds, minKeep) {
  try {
    const { html } = await fetchHtml(path);
    let items = parseListing(html).map(toItem);
    if (excludeIds && excludeIds.size) {
      items = items.filter(function (it) {
        return !excludeIds.has(it.id);
      });
    }
    const need = minKeep != null ? minKeep : 6;
    if (items.length < need) return null;
    items = items.slice(0, limit || 60);
    if (excludeIds) {
      for (let i = 0; i < items.length; i++) excludeIds.add(items[i].id);
    }
    return {
      id: id,
      title: title,
      items: items,
      ref: path.replace(/^\//, "").replace(/\/$/, "") || "latest",
      genre: "otros",
    };
  } catch (e) {
    log("row", id, e.message || e);
    return null;
  }
}

// ---- search ----------------------------------------------------------------

export async function search(query) {
  await null;
  const q = String(query.q || "").trim();
  if (!q) return [];

  let page = 1;
  if (query.cursor && /^\d+$/.test(String(query.cursor))) {
    page = parseInt(String(query.cursor), 10) || 1;
  }

  let path =
    "/?s=" + encodeURIComponent(q.slice(0, 80));
  if (page > 1) path = "/page/" + page + "/?s=" + encodeURIComponent(q.slice(0, 80));

  let html;
  try {
    html = (await fetchHtml(path)).html;
  } catch (e) {
    log("search", e.message || e);
    throw kino.error("unavailable", e.message || "búsqueda falló");
  }

  const cards = parseListing(html);
  const items = cards.slice(0, 100).map(toItem);
  const next = cards.length >= 20 ? String(page + 1) : undefined;
  return next ? { items: items, next: next } : items;
}

// ---- home ------------------------------------------------------------------

export async function home() {
  await null;
  const rows = [];
  const seen = new Set();

  // Favorite / high-traffic sections (verified distinct filters on the site)
  const filters = [
    ["latest", "Recientes", "/?filter=latest"],
    ["most-viewed", "Más vistos", "/?filter=most-viewed"],
    ["best", "Mejor valorados", "/?filter=best"],
    ["longest", "Más largos", "/?filter=longest"],
  ];
  for (let i = 0; i < filters.length; i++) {
    const row = await rowFrom(
      filters[i][2],
      filters[i][0],
      filters[i][1],
      60,
      seen,
      6
    );
    if (row) rows.push(row);
  }

  // Popular cosplay niches (category pages on cosxplay.com)
  const cats = [
    ["59813-popular-costumes", "Popular Costumes", "/59813-popular-costumes/"],
    ["12804-video-games", "Video Games", "/12804-video-games/"],
    ["31-cosplay", "Cosplay", "/tag/31-cosplay/"],
    ["11115-asian", "Asian", "/11115-asian/"],
    ["71061-femboy", "Femboy", "/71061-femboy/"],
    ["11121-joi", "JOI", "/11121-joi/"],
    ["4063-ahegao", "Ahegao", "/4063-ahegao/"],
    ["12814-anime", "Anime", "/12814-anime/"],
    ["16652-furry", "Furry", "/16652-furry/"],
    ["11104-anal", "Anal", "/11104-anal/"],
    ["11117-big-boobs", "Big Boobs", "/11117-big-boobs/"],
  ];
  for (let i = 0; i < cats.length; i++) {
    if (rows.length >= 19) break;
    const row = await rowFrom(
      cats[i][2],
      "cat-" + cats[i][0],
      cats[i][1],
      48,
      seen,
      6
    );
    if (row) rows.push(row);
  }

  // Last row: 2B (NieR:Automata) — always preferred last
  const row2b = await rowFrom(
    "/7841-nier-automata/",
    "2b-nier",
    "2B (NieR:Automata)",
    48,
    seen,
    4
  );
  if (row2b) rows.push(row2b);

  if (!rows.length) {
    throw kino.error("unavailable", "sin listados de CosXplay");
  }
  return rows;
}

// ---- browse ----------------------------------------------------------------

export async function browse(ref, cursor) {
  await null;
  let path = String(ref || "filter=latest").replace(/^\/+/, "");
  let page = 1;
  if (cursor && /^\d+$/.test(String(cursor))) {
    page = parseInt(String(cursor), 10) || 1;
  }

  if (path.indexOf("filter=") === 0 || path.indexOf("?filter=") === 0) {
    const f = path.replace(/^\?/, "").replace(/^filter=/, "").split("&")[0];
    path = filterPath(f, page);
  } else if (path.indexOf("s=") === 0 || path.indexOf("?s=") === 0) {
    const q = path.replace(/^\?/, "").replace(/^s=/, "");
    path =
      page > 1
        ? "/page/" + page + "/?s=" + q
        : "/?s=" + q;
  } else {
    // category / tag path
    path = categoryPath(path.replace(/\/page\/\d+.*/, ""), page);
  }

  let html;
  try {
    html = (await fetchHtml(path)).html;
  } catch (e) {
    log("browse", e.message || e);
    throw kino.error("unavailable", e.message || "browse falló");
  }

  const cards = parseListing(html);
  const items = cards.slice(0, 100).map(toItem);
  const next = cards.length >= 20 ? String(page + 1) : undefined;
  return { items: items, next: next };
}

// ---- resolve ---------------------------------------------------------------
// CloudStream CosXPlay (Cs-GizliKeyif) only does:
//   document.select("video source") → src
//   ExtractorLink with referer = "https://cosxplay.com/"
// No Origin, no browser, no extra headers. That avoids nosofiles 403 on many
// Android players. We mirror that first, then fall back to browser.capture.

function extractStreams(html) {
  const high = [];
  const low = [];
  // Prefer the same selector path as CloudStream: video source[title]
  const re =
    /<source[^>]+src="(https?:\/\/[^"]+)"[^>]*(?:title="(high|low)"|type="video\/mp4")[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    const title = (m[2] || "").toLowerCase();
    if (/trailer/i.test(url)) continue;
    if (title === "low" || /_low\.mp4/i.test(url)) low.push(url);
    else high.push(url);
  }
  if (!high.length && !low.length) {
    const all = html.match(
      /https?:\/\/[^"'<\s]+nosofiles\.com[^"'<\s]+\.mp4[^"'<\s]*/gi
    );
    if (all) {
      for (let i = 0; i < all.length; i++) {
        const u = all[i];
        if (/trailer/i.test(u)) continue;
        if (/_low\.mp4/i.test(u)) low.push(u);
        else high.push(u);
      }
    }
  }
  return { high: high, low: low };
}

/** CloudStream-style headers: ONLY site-root Referer (+ UA). No Origin. */
function csHeaders() {
  return {
    Referer: BASE + "/",
    "User-Agent": UA,
  };
}

/** Full capture headers, but strip Origin (often triggers CDN 403 on TV). */
function captureHeadersClean(media, page, pageUrl) {
  const out = {};
  const src = (media && media.headers) || {};
  const keys = Object.keys(src);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const kl = String(k).toLowerCase();
    if (
      kl === "range" ||
      kl === "accept-encoding" ||
      kl === "host" ||
      kl === "content-length" ||
      kl === "connection" ||
      kl === "cookie2" ||
      kl === "origin" // CloudStream does not send Origin → skip
    ) {
      continue;
    }
    if (src[k] != null && String(src[k]) !== "") out[k] = String(src[k]);
  }
  // Force Referer to site root like CloudStream (not the deep video URL)
  out.Referer = BASE + "/";
  if (!out["User-Agent"] && !out["user-agent"]) out["User-Agent"] = UA;
  if (!out.Accept && !out.accept) out.Accept = "*/*";

  // Cookie from capture if present
  if (!out.Cookie && !out.cookie) {
    const cookies = (page && page.cookies) || [];
    if (cookies.length && media && media.url) {
      try {
        const host = String(media.url).split("/")[2] || "";
        const parts = [];
        for (let i = 0; i < cookies.length; i++) {
          const c = cookies[i];
          if (!c || !c.name) continue;
          const dh = String(c.domain || "").replace(/^\./, "");
          if (!dh || host.indexOf(dh) >= 0 || dh.indexOf(host) >= 0) {
            parts.push(c.name + "=" + (c.value || ""));
          }
        }
        if (parts.length) out.Cookie = parts.join("; ");
      } catch (_) {}
    }
  }

  const final = {};
  const fk = Object.keys(out);
  for (let i = 0; i < fk.length && i < 20; i++) final[fk[i]] = out[fk[i]];
  return final;
}

function parseRefPath(ref) {
  let slug = String(ref || "").trim();
  const um = slug.match(/(\d{3,})-([a-z0-9-]+)/i);
  const idOnly = slug.match(/^(\d{4,})$/);
  if (um) return "/" + um[1] + "-" + um[2] + "/";
  if (idOnly) return "/?p=" + idOnly[1];
  if (/cosxplay\.com\//i.test(slug)) {
    return slug.replace(/^https?:\/\/[^/]+/i, "");
  }
  return "/" + slug.replace(/^\/+/, "") + "/";
}

function collectPlayable(page) {
  const media = (page && page.media) || [];
  const extra = (page && page.requests) || [];
  const all = media.concat(extra);
  const seen = {};
  const out = [];
  for (let i = 0; i < all.length; i++) {
    const x = all[i];
    if (!x || !x.url) continue;
    if (seen[x.url]) continue;
    if (!/\.mp4/i.test(x.url)) continue;
    if (/trailer/i.test(x.url)) continue;
    seen[x.url] = true;
    out.push(x);
  }
  return out;
}

function streamEntry(url, label, headers) {
  return {
    url: url,
    mime: "video/mp4",
    headers: headers,
    label: label,
    expiresInSeconds: /verify=/i.test(url) ? 900 : 1800,
  };
}

/**
 * resolve — CloudStream order first (HTML + Referer site root),
 * then browser.capture with cleaned headers as alternatives.
 */
export async function resolve(ref, ctx) {
  await null;
  const path = parseRefPath(ref);
  const pageUrl = BASE + path;
  const pref = preferredQuality();
  const isTv = typeof kino.device === "string" && kino.device === "tv";
  if (ctx && ctx.retry) {
    log("retry", ctx.retry.reason || "", ctx.retry.status || "");
  }

  const alternatives = [];
  let primary = null;

  // ---- A) CloudStream path: fetch HTML, read <source>, Referer = site root ----
  try {
    const { html } = await fetchHtml(path);
    const streams = extractStreams(html);
    const ordered = [];
    if (pref === "low") {
      if (streams.low[0]) ordered.push({ url: streams.low[0], label: "Baja" });
      if (streams.high[0]) ordered.push({ url: streams.high[0], label: "Alta" });
    } else {
      if (streams.high[0]) ordered.push({ url: streams.high[0], label: "Alta" });
      if (streams.low[0]) ordered.push({ url: streams.low[0], label: "Baja" });
    }
    // On TV, put low first as safer progressive stream
    if (isTv && streams.low[0] && streams.high[0] && pref !== "low") {
      ordered.length = 0;
      ordered.push({ url: streams.low[0], label: "Baja" });
      ordered.push({ url: streams.high[0], label: "Alta" });
    }

    for (let i = 0; i < ordered.length; i++) {
      const entry = streamEntry(ordered[i].url, ordered[i].label, csHeaders());
      // Also offer same URL with page Referer (some CDNs want it)
      const entryPage = streamEntry(ordered[i].url, ordered[i].label + " (page)", {
        Referer: pageUrl,
        "User-Agent": UA,
      });
      if (!primary) {
        primary = entry;
        alternatives.push(entryPage);
      } else {
        alternatives.push(entry);
        alternatives.push(entryPage);
      }
    }
    log("html sources", ordered.length, isTv ? "tv" : "phone");
  } catch (e) {
    log("html resolve", e.message || e);
  }

  // ---- B) browser.capture — extra copies with cleaned headers (no Origin) ----
  if (kino.browser && typeof kino.browser.capture === "function") {
    try {
      const opts = {
        timeoutMs: 25000,
        autoplay: true,
        match: "nosofiles.*\\.mp4|_high\\.mp4|_low\\.mp4",
      };
      if (kino.browser.captureAll === true) {
        opts.captureAll = true;
        opts.alsoMatch = ["\\.mp4"];
        opts.returnCookiesOnTimeout = true;
      }
      const page = await kino.browser.capture(pageUrl, opts);
      const playable = collectPlayable(page);
      log(
        "capture",
        playable.length,
        "hdr",
        playable[0] && playable[0].headers
          ? Object.keys(playable[0].headers).join(",")
          : "none"
      );

      playable.sort(function (a, b) {
        const score = function (u) {
          let s = 0;
          if (/_high\.mp4/i.test(u)) s += pref === "low" ? 1 : 4;
          if (/_low\.mp4/i.test(u)) s += pref === "low" || isTv ? 4 : 2;
          if (/verify=/i.test(u)) s += 1;
          return s;
        };
        return score(b.url) - score(a.url);
      });

      for (let i = 0; i < playable.length; i++) {
        const m = playable[i];
        // Variant 1: CloudStream-like (only root Referer)
        const cs = streamEntry(
          m.url,
          (/_low/i.test(m.url) ? "Baja" : "Alta") + " · CS",
          csHeaders()
        );
        // Variant 2: capture headers cleaned (no Origin, Referer forced to root)
        const full = streamEntry(
          m.url,
          (/_low/i.test(m.url) ? "Baja" : "Alta") + " · cap",
          captureHeadersClean(m, page, pageUrl)
        );
        if (!primary) {
          primary = cs;
          alternatives.push(full);
        } else {
          // Avoid duplicate exact URL+label noise
          const exists = [primary].concat(alternatives).some(function (x) {
            return x.url === m.url;
          });
          if (!exists) {
            alternatives.push(cs);
            alternatives.push(full);
          } else {
            alternatives.push(full);
          }
        }
      }
    } catch (e) {
      log("browser.capture", e.code || "", e.message || e);
      if (e && e.code === "blocked") {
        throw kino.error("unavailable", "cloudflare blocked", {
          userMessage:
            "CosXplay pidió verificación humana. Kino no puede completar captchas.",
        });
      }
    }
  }

  if (!primary) {
    throw kino.error("unavailable", "sin stream", {
      userMessage:
        "No se encontró el vídeo. En la Mi TV P1 el CDN a veces bloquea (403); prueba en el teléfono.",
    });
  }

  // Cap alternatives at 8 (Kino contract)
  if (alternatives.length) {
    primary.alternatives = alternatives.slice(0, 8);
  }
  return primary;
}
