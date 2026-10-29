/// <reference path="./kino.d.ts" />

/**
 * CosXplay (cosxplay.com) for Kino v1.2.0
 * Same capabilities as 123AV: search / home / browse / resolve,
 * quality setting, streamHosts any, captureAll + headers exactos + retry 403 (manual Kino).
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

function extractStreams(html) {
  const high = [];
  const low = [];
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

/**
 * Pass capture headers to the player EXACTLY as Kino documented:
 * media.headers already include the page request headers + cookies for that URL.
 * Do not invent Range / Accept-Encoding. Cap at 20.
 */
function buildStreamHeaders(media, page, pageUrl) {
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
      kl === "cookie2"
    ) {
      continue;
    }
    if (src[k] != null && String(src[k]) !== "") out[k] = String(src[k]);
  }

  // Fallback Cookie from page.cookies / page.requests (0.9.54+)
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

  if (!out.Referer && !out.referer) {
    out.Referer = (page && page.finalUrl) || pageUrl;
  }
  if (!out.Origin && !out.origin) {
    out.Origin = BASE;
  }
  if (!out["User-Agent"] && !out["user-agent"]) {
    out["User-Agent"] = UA;
  }
  if (!out.Accept && !out.accept) {
    out.Accept = "*/*";
  }
  if (!out["Accept-Language"] && !out["accept-language"]) {
    out["Accept-Language"] = "en-US,en;q=0.9";
  }

  const final = {};
  const fk = Object.keys(out);
  for (let i = 0; i < fk.length && i < 20; i++) final[fk[i]] = out[fk[i]];
  return final;
}

function scoreMedia(url, preferLow) {
  let s = 0;
  if (/_high\.mp4/i.test(url)) s += preferLow ? 1 : 5;
  if (/_low\.mp4/i.test(url)) s += preferLow ? 5 : 2;
  if (/verify=/i.test(url)) s += 2;
  if (/trailer/i.test(url)) s -= 20;
  return s;
}

function mediaToStream(media, page, pageUrl, label) {
  return {
    url: media.url,
    mime: "video/mp4",
    headers: buildStreamHeaders(media, page, pageUrl),
    label:
      label ||
      (/_high/i.test(media.url)
        ? "Alta"
        : /_low/i.test(media.url)
          ? "Baja"
          : "MP4"),
    // Signed verify= URLs expire; ask Kino to re-resolve before they go stale
    expiresInSeconds: /verify=/i.test(media.url) ? 900 : 1800,
  };
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
  // Also dig page.requests when captureAll is on (Kino 0.9.54)
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

async function captureVideo(pageUrl) {
  const opts = {
    timeoutMs: 25000,
    autoplay: true,
    match: "nosofiles.*\\.mp4|xcdn.*\\.mp4|_high\\.mp4|_low\\.mp4",
  };
  // Official Kino 0.9.54 flags (feature-detect; older Kino ignores unknown keys poorly — gate them)
  if (kino.browser && kino.browser.captureAll === true) {
    opts.captureAll = true;
    opts.alsoMatch = ["\\.mp4"];
    opts.returnCookiesOnTimeout = true;
  }
  return kino.browser.capture(pageUrl, opts);
}

/**
 * resolve(ref, ctx?)
 * ctx.retry is set by Kino on 401/403/409 so we re-capture a fresh signed URL.
 */
export async function resolve(ref, ctx) {
  await null;
  const path = parseRefPath(ref);
  const pageUrl = BASE + path;
  const pref = preferredQuality();
  const isTv = typeof kino.device === "string" && kino.device === "tv";
  // On TV prefer low first when user asked high but CDN is strict — still offer high as alt
  const preferLow = pref === "low" || (isTv && pref !== "high");
  const retry =
    ctx && ctx.retry
      ? ctx.retry
      : null;
  if (retry) {
    log("resolve retry", retry.reason || "", retry.status || "", "attempt", retry.attempt || 1);
  }

  // --- 1) browser.capture -------------------------------------------------
  if (kino.browser && typeof kino.browser.capture === "function") {
    try {
      const page = await captureVideo(pageUrl);
      let playable = collectPlayable(page);
      log(
        "capture",
        playable.length,
        "hdr",
        playable[0] && playable[0].headers
          ? Object.keys(playable[0].headers).join(",")
          : "none",
        isTv ? "tv" : "phone"
      );

      if (playable.length) {
        playable.sort(function (a, b) {
          return scoreMedia(b.url, preferLow) - scoreMedia(a.url, preferLow);
        });

        const primary = mediaToStream(playable[0], page, pageUrl);
        const alternatives = [];
        for (let i = 1; i < playable.length && alternatives.length < 7; i++) {
          alternatives.push(
            mediaToStream(
              playable[i],
              page,
              pageUrl,
              /_low/i.test(playable[i].url)
                ? "Baja"
                : /_high/i.test(playable[i].url)
                  ? "Alta"
                  : "Alt " + i
            )
          );
        }

        // If capture headers look empty on TV, one more capture can help flaky WebViews
        if (
          isTv &&
          (!playable[0].headers || Object.keys(playable[0].headers).length < 2)
        ) {
          log("tv weak headers, second capture");
          try {
            const page2 = await captureVideo(pageUrl);
            const p2 = collectPlayable(page2);
            if (p2.length) {
              p2.sort(function (a, b) {
                return scoreMedia(b.url, preferLow) - scoreMedia(a.url, preferLow);
              });
              const s2 = mediaToStream(p2[0], page2, pageUrl);
              // Prefer the one that actually brought headers
              if (p2[0].headers && Object.keys(p2[0].headers).length >= 2) {
                if (alternatives.length < 7) {
                  alternatives.unshift(primary);
                }
                s2.alternatives = alternatives.slice(0, 7);
                return s2;
              }
            }
          } catch (e2) {
            log("second capture", e2.message || e2);
          }
        }

        if (alternatives.length) primary.alternatives = alternatives;
        return primary;
      }
    } catch (e) {
      log("browser.capture", e.code || "", e.message || e);
      // browser_unavailable / busy / blocked → HTML fallback
      if (e && e.code === "blocked") {
        throw kino.error("unavailable", "cloudflare blocked", {
          userMessage:
            "CosXplay pidió verificación humana. Kino no puede completar captchas.",
        });
      }
    }
  }

  // --- 2) HTML fallback (often 403 on TV without capture headers) ---------
  let html;
  try {
    html = (await fetchHtml(path)).html;
  } catch (e) {
    throw kino.error("unavailable", e.message || "no se cargó el vídeo", {
      userMessage:
        "No se pudo abrir el vídeo. En Xiaomi TV el CDN a veces responde 403; prueba en el teléfono.",
    });
  }

  const streams = extractStreams(html);
  let url = null;
  let label = "MP4";
  if (pref === "low" || (isTv && !streams.high[0])) {
    url = streams.low[0] || streams.high[0];
    label = streams.low[0] ? "Baja" : "Alta";
  } else {
    url = streams.high[0] || streams.low[0];
    label = streams.high[0] ? "Alta" : "Baja";
  }
  if (!url) {
    throw kino.error("unavailable", "sin MP4", {
      userMessage: "No se encontró el archivo de vídeo de este título.",
    });
  }

  const streamHeaders = {
    Referer: pageUrl,
    Origin: BASE,
    "User-Agent": UA,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };
  const alternatives = [];
  const other = url === streams.high[0] ? streams.low[0] : streams.high[0];
  if (other && other !== url) {
    alternatives.push({
      url: other,
      label: other === streams.low[0] ? "Baja" : "Alta",
      headers: streamHeaders,
      mime: "video/mp4",
    });
  }

  return {
    url: url,
    mime: "video/mp4",
    headers: streamHeaders,
    label: label,
    expiresInSeconds: 900,
    alternatives: alternatives.length ? alternatives : undefined,
  };
}
