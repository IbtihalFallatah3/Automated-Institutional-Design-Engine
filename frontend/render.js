/* Executes an AI-authored layout spec.

   Second rebuild. The first rebuild (5 "families") was still too loose --
   each family had its own free-floating parameters (title size, ornament
   choice, panel style...) that didn't come from any specific reference, so
   output still looked like a generic invention rather than this
   organisation's actual posters.

   This version locks each family to the SPECIFIC reference poster(s) it's
   modelled on -- fixed proportions, fixed positions, fixed decorative
   marks, measured directly off backend/references/*.jpg (see the comment
   above each render function for which ref and what was measured). The
   model only supplies CONTENT now: which family, the text, the photo(s),
   the palette. It no longer touches spacing, sizing, or ornament choice --
   that discretion is exactly what kept producing "a design" instead of
   "this organisation's design." */

const SP = { xs: 8, sm: 16, md: 24, lg: 40, xl: 64, xxl: 104 };
const W = 800, H = 1422;
// Footer logo-strip height -- deliberately its OWN constant, not SP.xxl.
// SP.xxl is also reused elsewhere as a top-of-canvas header offset; tying
// the footer to it would mean "make logos bigger" silently pushes headers
// down too. Sized generously so it still comfortably fits 6 logos at the
// largest manual logo-size setting (see logoStrip()) without wrapping.
const FOOTER = 116;

// Every font-size in this file is wrapped in fs() instead of a bare
// "Npx" -- it multiplies by --text-scale, a CSS custom property set once
// in renderPoster() from spec.text_scale (an editor-only override, 0.85-
// 1.25, never AI-authored -- see the "حجم النص" control in app.js). This
// preserves the family's proportions (title still N times bigger than
// body) while giving a human a little room to compensate for unusually
// long/short content, without turning font size into a free-for-all.
const fs = n => `calc(${n}px * var(--text-scale, 1))`;

const esc = s => { const d = document.createElement("div"); d.innerText = s || ""; return d.innerHTML; };
const paras = t => !t ? "" : t.split(/\n+/).map(p => p.trim()).filter(Boolean)
  .map(p => `<p style="margin:0 0 ${SP.sm}px">${esc(p)}</p>`).join("");

function hexToRgba(hex, alpha) {
  const h = (hex || "#000000").replace("#", "");
  const r = parseInt(h.substring(0, 2), 16) || 0;
  const g = parseInt(h.substring(2, 4), 16) || 0;
  const b = parseInt(h.substring(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

// Tight, fairly opaque near shadow (defines the letterforms) + a soft wide
// one (separates the block from a busy photo). Only used where text sits
// directly on photo pixels, never on a solid colour.
const shadowFor = light => light ? "text-shadow:0 1px 2px rgba(0,0,0,.7), 0 8px 22px rgba(0,0,0,.4);" : "";

/* ------------------------------------------------------------------------
   Manual repositioning (editor-only, never AI-authored). Each family's
   "big" text block (title/body/header/quote) can be nudged by hand in the
   UI via a small drag handle -- app.js writes the accumulated pixel delta
   into spec.text_offsets[role] and this file re-applies it as an ADDITIONAL
   translate() on top of whatever positioning the block already needs
   (e.g. full_bleed_photo's centred anchor uses translateY(-50%) --
   dragging must compose with that, not replace it). data-drag-role /
   data-base-transform let app.js find the block and reconstruct the same
   transform live during a drag without duplicating this file's per-family
   positioning logic.
   ------------------------------------------------------------------------ */
function offsetT(spec, role, base) {
  const o = (spec.text_offsets || {})[role];
  return `${base || ""}${o ? ` translate(${o.dx}px,${o.dy}px)` : ""}`;
}
function dragAttrs(role, base) {
  return `class="dragBlock" data-drag-role="${role}" data-base-transform="${(base || "").replace(/"/g, "")}"`;
}
// NOTE: no letter-spacing anywhere in this file -- Arabic is a cursive,
// letter-joining script and forced spacing breaks glyph joining.

/* ------------------------------------------------------------------------
   Photo cropping happens in a canvas, not CSS object-fit -- html2canvas
   (export) does not reliably honour object-fit/object-position and can
   silently stretch the raw image instead of cropping it. Pre-cropping to a
   data URL sidesteps that entirely.
   ------------------------------------------------------------------------ */
function coverCrop(img, boxW, boxH, focalXPct, focalYPct) {
  const srcW = img.naturalWidth, srcH = img.naturalHeight;
  const srcAspect = srcW / srcH, boxAspect = boxW / boxH;
  let cropW, cropH;
  if (srcAspect > boxAspect) { cropH = srcH; cropW = srcH * boxAspect; }
  else { cropW = srcW; cropH = srcW / boxAspect; }
  const fx = (focalXPct ?? 50) / 100, fy = (focalYPct ?? 50) / 100;
  let cropX = srcW * fx - cropW / 2;
  let cropY = srcH * fy - cropH / 2;
  cropX = Math.max(0, Math.min(srcW - cropW, cropX));
  cropY = Math.max(0, Math.min(srcH - cropH, cropY));
  const outScale = Math.min(2, srcW / boxW, srcH / boxH);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(boxW * Math.max(1, outScale)));
  canvas.height = Math.max(1, Math.round(boxH * Math.max(1, outScale)));
  const ctx2d = canvas.getContext("2d");
  ctx2d.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.95);
}

/* ------------------------------------------------------------------------
   Deriving a flat background tone FROM an actual uploaded photo, instead
   of a fixed palette hex -- used by photo_feature_list so the thin gaps
   between rows and the header/footer areas always harmonise with whatever
   photo the editor uploads, rather than a flat colour that happens to be
   close (a warm photo next to a cool palette base, or vice versa). The
   sample is deliberately clamped (see deriveBgColor) so it stays dark/
   muted enough for the white overlaid text and logos to stay legible
   regardless of how bright or saturated the source photo is.
   ------------------------------------------------------------------------ */
function averageColor(img) {
  const size = 12;
  const c = document.createElement("canvas");
  c.width = size; c.height = size;
  const cx = c.getContext("2d");
  cx.drawImage(img, 0, 0, size, size);
  const data = cx.getImageData(0, 0, size, size).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
  return [r / n, g / n, b / n];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s; const l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4;
    }
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

// Clamps lightness/saturation into a band that still visibly reads as
// "sampled from this photo" (hue is untouched) while staying dark and
// muted enough for the white overlaid text/logos to stay legible -- an
// unclamped average can land too pale (a bright/sandy photo would wash
// the white text out) or too neon (a single saturated patch in a small
// sample swinging the whole average).
function deriveBgColor(samples) {
  const r = samples.reduce((a, s) => a + s[0], 0) / samples.length;
  const g = samples.reduce((a, s) => a + s[1], 0) / samples.length;
  const b = samples.reduce((a, s) => a + s[2], 0) / samples.length;
  const [h, s, l] = rgbToHsl(r, g, b);
  const sClamped = Math.min(0.55, Math.max(0.18, s));
  const lClamped = Math.min(0.26, Math.max(0.14, l));
  const [rr, gg, bb] = hslToRgb(h, sClamped, lClamped);
  const hex = n => n.toString(16).padStart(2, "0");
  return `#${hex(rr)}${hex(gg)}${hex(bb)}`;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

// vertical photo/band split for photo_band -- measured off ref_01.jpg: the
// solid colour band starts at y=1070 of a 1400px-tall reference (0.764).
const PHOTO_BAND_SEAM = Math.round(H * 0.764);
// portrait_quote photo height -- ref_09 is a square (800x800) with the
// photo occupying ~62% of that; adapted proportionally to this taller
// 800x1422 canvas so the quote block below still gets comparable room.
const PORTRAIT_PHOTO_H = Math.round(H * 0.46);
// stat_grid caption bar height -- ref_08's cream number/label bar above
// each photo tile is a fixed-height strip, not proportional.
const STAT_CAPTION_H = 60;
// photo_feature_list row gap -- a thin seam between full-bleed rows
// (mockup used ~7px at this canvas' scale; SP.xs is the closest token).
const FEATURE_ROW_GAP = SP.xs;

function logoStrip(ctx, onDark, bare) {
  if (!ctx.logos.length) return "";
  const n = ctx.logos.length;
  const scale = ctx.logoScale || 1;
  // Bigger default (56px, was 44px) per "everything needs to be readable."
  // Auto-shrinks a little past 4 logos so a full row (up to 6) still fits
  // one line instead of overlapping -- the manual "حجم الشعارات" control
  // multiplies on top of this, so a user can compensate either way if
  // their specific logo set (e.g. a wide wordmark) still doesn't fit.
  const baseH = n <= 4 ? 56 : n === 5 ? 50 : 44;
  const h = Math.round(baseH * scale);
  const gap = n <= 4 ? SP.xl : n <= 6 ? SP.lg : SP.md;
  const maxW = Math.round(W / n - gap);
  const imgs = ctx.logos.map(l => {
    const v = l.variant_urls || {};
    const url = onDark ? (v.white || v.primary) : (v.primary || v.black || v.white);
    const filt = onDark && !v.white ? "filter:brightness(0) invert(1);opacity:.92;" : "";
    return `<img src="${url}" style="height:${h}px;max-width:${maxW}px;object-fit:contain;${filt}">`;
  }).join("");
  // Families with their own solid-colour footer area (photo_band, stat_grid,
  // photo_feature_list, portrait_quote) don't need a separate backing bar --
  // pass bare=true to place logos directly on that colour, matching the
  // references (which never double up a bar on top of an already-solid
  // area). full_bleed_photo still needs the bar since logos there sit
  // directly on unpredictable photo pixels.
  if (bare)
    return `<div style="position:absolute;left:0;right:0;bottom:0;height:${FOOTER}px;
      display:flex;align-items:center;justify-content:center;gap:${gap}px">${imgs}</div>`;
  const bg = onDark ? "rgba(8,12,14,0.82)" : "rgba(255,255,255,0.92)";
  const border = onDark ? "" : "border-top:1px solid rgba(0,0,0,0.06);";
  return `<div style="position:absolute;left:0;right:0;bottom:0;height:${FOOTER}px;
    background:${bg};${border}
    display:flex;align-items:center;justify-content:center;gap:${gap}px">${imgs}</div>`;
}

/* ===========================================================================
   FAMILY 1 -- photo_band  (measured off ref_01.jpg)
   Full-bleed photo, top 76.4% of the canvas. A solid colour band (the
   palette's base colour) fills the bottom 23.6%. The title straddles the
   seam -- roughly half over the photo, half over the band -- right
   aligned, with a small two-dot mark to its left at the same seam line
   (ref_01's decorative "..". Body copy sits inside the band below the
   title. Logos sit directly on the band, no extra backing needed.
   =========================================================================== */
function renderPhotoBand(spec, ctx, pal) {
  const photo = (ctx.croppedPhotos || [])[0];
  const seam = PHOTO_BAND_SEAM;

  const photoHtml = photo
    ? `<img src="${photo}" style="position:absolute;top:0;left:0;width:100%;height:${seam}px;
         object-fit:cover;filter:saturate(1.07) contrast(1.04)">`
    : `<div style="position:absolute;top:0;left:0;width:100%;height:${seam}px;background:var(--base);opacity:.7"></div>`;

  const band = `<div style="position:absolute;top:${seam}px;left:0;width:100%;height:${H - seam}px;background:var(--base)"></div>`;

  const dots = `<div style="position:absolute;top:${seam - 40}px;left:${SP.lg}px;display:flex;gap:6px">
      <div style="width:22px;height:22px;border-radius:50%;background:var(--accent)"></div>
      <div style="width:22px;height:22px;border-radius:50%;background:var(--accent);opacity:.55"></div>
    </div>`;

  const eyebrow = spec.eyebrow
    ? `<div style="position:absolute;top:${SP.md}px;left:${SP.lg}px;color:#fff;font-size:${fs(13)};font-weight:700;
         text-shadow:0 1px 4px rgba(0,0,0,.6)" contenteditable>${esc(spec.eyebrow)}</div>` : "";

  const title = `<div ${dragAttrs("title", "")} style="position:absolute;top:${seam - 76}px;right:${SP.lg}px;left:${SP.lg}px;
      text-align:right;direction:rtl;color:#fff;font-size:${fs(64)};font-weight:800;line-height:1.1;
      transform:${offsetT(spec, "title", "")};
      text-shadow:0 2px 4px rgba(0,0,0,.55), 0 10px 26px rgba(0,0,0,.4)" contenteditable>${esc(spec.title)}</div>`;

  const bodyTop = seam + 108;
  const body = spec.body
    ? `<div ${dragAttrs("body", "")} style="position:absolute;top:${bodyTop}px;right:${SP.lg}px;left:${SP.lg}px;
         text-align:right;direction:rtl;color:rgba(255,255,255,.92);font-size:${fs(15)};line-height:1.7;
         transform:${offsetT(spec, "body", "")}"
         contenteditable>${paras(spec.body)}</div>` : "";

  const dateLine = spec.date_label
    ? `<div style="position:absolute;top:${H - FOOTER - 40}px;right:${SP.lg}px;color:var(--accent);
         font-size:${fs(12)};font-weight:700" contenteditable>${esc(spec.date_label)}</div>` : "";

  return photoHtml + band + dots + eyebrow + title + body + dateLine + logoStrip(ctx, true, true);
}

/* ===========================================================================
   FAMILY 2 -- full_bleed_photo  (measured off ref_03.jpg / ref_06.jpg)
   Photo fills the whole canvas, no band, no card. Text sits in whichever
   region the vision pass reports as quiet, carried by weight + a two-layer
   shadow. When the text needs more separation than shadow alone gives, a
   translucent rectangle sized to the text block itself appears behind it
   (ref_03) -- never a tint over the whole photo.
   =========================================================================== */
function zoneStyle(anchor) {
  switch (anchor) {
    case "top":    return `top:${SP.xxl}px;`;
    case "upper":  return `top:${Math.round(H * 0.22)}px;`;
    case "center": return `top:50%;`;
    case "bottom": return `bottom:${FOOTER + SP.lg}px;`;
    default:       return `bottom:${FOOTER + SP.xxl}px;`;   // "lower"
  }
}
// "center" needs its own translateY(-50%) BEFORE the drag offset composes
// in -- kept separate from zoneStyle() so offsetT() can build one clean
// transform string instead of two independent `transform:` declarations
// fighting each other.
const zoneBaseTransform = anchor => anchor === "center" ? "translateY(-50%)" : "";

function renderFullBleedPhoto(spec, ctx, pal) {
  const photo = (ctx.croppedPhotos || [])[0];
  const light = spec.text_color !== "dark";
  const ink = light ? "#fff" : "#16232b";
  const shadow = shadowFor(light);
  const align = spec.text_zone.align === "center" ? "center" : "right";
  const width = align === "center" ? W - SP.lg * 2 : Math.round(W * 0.78);
  const inset = SP.lg;

  const bg = photo
    ? `<img src="${photo}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:saturate(1.08) contrast(1.05)">`
    : `<div style="position:absolute;inset:0;background:var(--base)"></div>`;

  const scrimBg = spec.scrim === "soft"
    ? `background:${hexToRgba("#000000", Math.max(0, Math.min(0.7, spec.scrim_strength ?? 0.4)))};
       border-radius:6px;padding:${SP.sm}px ${SP.md}px;margin:-${SP.sm}px -${SP.md}px;` : "";

  const eyebrow = spec.eyebrow
    ? `<div style="display:inline-block;font-size:${fs(12)};font-weight:700;padding:${SP.xs}px ${SP.sm}px;
         border-radius:999px;background:var(--accent);color:#1b1b1b;margin-bottom:${SP.md}px"
         contenteditable>${esc(spec.eyebrow)}</div>` : "";

  const subtitle = spec.subtitle
    ? `<div style="font-size:${fs(22)};font-weight:500;line-height:1.45;opacity:.92;margin-top:${SP.sm}px;${shadow}"
         contenteditable>${esc(spec.subtitle)}</div>` : "";

  const base = zoneBaseTransform(spec.text_zone.anchor);
  const textHtml = `<div ${dragAttrs("text", base)} style="position:absolute;${zoneStyle(spec.text_zone.anchor)}
      inset-inline-end:${inset}px;width:${width}px;text-align:${align};direction:rtl;color:${ink};
      transform:${offsetT(spec, "text", base)}">
      <div style="${scrimBg}">
        ${eyebrow}
        <div style="font-size:${fs(58)};font-weight:800;line-height:1.15;${shadow}" contenteditable>${esc(spec.title)}</div>
        ${subtitle}
      </div>
    </div>`;

  return bg + textHtml + logoStrip(ctx, light, false);
}

/* ===========================================================================
   FAMILY 3 -- stat_grid  (measured off ref_08.jpg)
   Short header, then a 2-4 tile grid. Each tile is a cream caption bar
   (big bold number + short label, dark ink -- fixed contrast, independent
   of the photo) directly above its photo, not text overlaid on the photo
   itself. Simplified from the full reference, which also carries a hero
   photo and a separate bulleted "pillars" section above the grid -- this
   family reproduces the grid unit precisely; the extra sections are their
   own components (see photo_band / photo_feature_list) rather than
   duplicated here.
   =========================================================================== */
function statGridBoxes(n) {
  const gap = SP.sm;
  const areaX = SP.lg, areaTop = Math.round(H * 0.22), areaBottom = H - FOOTER - SP.lg;
  const areaW = W - SP.lg * 2, areaH = areaBottom - areaTop;
  let boxes = [];
  if (n <= 2) {
    const w = (areaW - gap) / 2;
    boxes = [0, 1].slice(0, n).map(i => ({ x: areaX + i * (w + gap), y: areaTop, w, h: areaH }));
  } else if (n === 3) {
    const rowH = (areaH - gap) / 2, halfW = (areaW - gap) / 2;
    boxes = [
      { x: areaX, y: areaTop, w: areaW, h: rowH },
      { x: areaX, y: areaTop + rowH + gap, w: halfW, h: rowH },
      { x: areaX + halfW + gap, y: areaTop + rowH + gap, w: halfW, h: rowH },
    ];
  } else {
    const w = (areaW - gap) / 2, h = (areaH - gap) / 2;
    boxes = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([cx, cy]) => ({
      x: areaX + cx * (w + gap), y: areaTop + cy * (h + gap), w, h,
    }));
  }
  return boxes.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) }));
}

function statTile(box, croppedUrl, stat, pal) {
  const photoH = Math.max(40, box.h - STAT_CAPTION_H);
  const bg = croppedUrl
    ? `<img src="${croppedUrl}" style="position:absolute;top:${STAT_CAPTION_H}px;left:0;width:100%;height:${photoH}px;
         object-fit:cover;filter:saturate(1.05) contrast(1.03)">`
    : `<div style="position:absolute;top:${STAT_CAPTION_H}px;left:0;width:100%;height:${photoH}px;background:var(--base);opacity:.55"></div>`;
  return `<div style="position:absolute;left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px;overflow:hidden">
      <div style="position:absolute;top:0;left:0;width:100%;height:${STAT_CAPTION_H}px;background:var(--surface);
        display:flex;align-items:center;justify-content:flex-end;gap:${SP.xs}px;padding:0 ${SP.sm}px;direction:rtl">
        <div style="font-size:${fs(26)};font-weight:800;color:var(--base);line-height:1" contenteditable>${esc(String(stat.value))}</div>
        <div style="font-size:${fs(12)};font-weight:600;color:#16232b;line-height:1.2;max-width:${box.w - 60}px"
          contenteditable>${esc(stat.label)}</div>
      </div>
      ${bg}
    </div>`;
}

function renderStatGrid(spec, ctx, pal) {
  const stats = (spec.stats || []).slice(0, 4);
  const n = Math.max(2, stats.length);
  const boxes = statGridBoxes(n);
  const photos = ctx.croppedPhotos || [];
  const tiles = stats.map((s, i) => statTile(boxes[i], photos[i], s, pal)).join("");

  const header = `<div ${dragAttrs("header", "")} style="position:absolute;top:${SP.xxl}px;left:${SP.lg}px;right:${SP.lg}px;
      text-align:right;direction:rtl;color:#fff;transform:${offsetT(spec, "header", "")}">
      <div style="font-size:${fs(34)};font-weight:800;line-height:1.2" contenteditable>${esc(spec.title)}</div>
      ${spec.subtitle ? `<div style="font-size:${fs(15)};font-weight:400;line-height:1.7;opacity:.85;margin-top:${SP.sm}px"
        contenteditable>${esc(spec.subtitle)}</div>` : ""}
    </div>`;

  return `<div style="position:absolute;inset:0;background:var(--base)"></div>` + header + tiles + logoStrip(ctx, true, true);
}

/* ===========================================================================
   FAMILY 4 -- photo_feature_list  (measured off ref_12.jpg, row treatment
   revised per a reference the user supplied: each row's photo runs full
   canvas width, edge-to-edge with its neighbours; the heading/body sit
   directly on top of the photo, held legible by a bottom-anchored dark
   gradient scrim -- the same technique full_bleed_photo/photo_band use for
   title-over-photo, just repeated per row instead of once. Two-line header
   (main line + accent-coloured second line) stays as before.
   =========================================================================== */
// Row height is derived, not fixed -- however many rows (2-4), they fill
// exactly the space between the header and the footer. headerH mirrors the
// header markup below (kept in one place so prepareFamilyPhotos can crop
// each photo to the exact row box and never drift out of sync with it).
// Any rounding remainder goes to the LAST row so the block's bottom edge
// meets the footer exactly instead of leaving a sliver gap.
function photoFeatureLayout(spec, n) {
  const ts = spec.text_scale || 1;
  const headerH = Math.round(SP.xxl + 44 * 1.2 * ts + (spec.subtitle ? 26 * 1.3 * ts + 2 : 0) + SP.md);
  const gap = FEATURE_ROW_GAP;
  const availH = H - headerH - FOOTER;
  const rowH = Math.floor((availH - gap * (n - 1)) / n);
  const leftover = availH - (rowH * n + gap * (n - 1));
  return { headerH, rowH, gap, leftover };
}

function renderPhotoFeatureList(spec, ctx, pal) {
  const features = (spec.features || []).slice(0, 4);
  const n = features.length;
  const photos = ctx.croppedPhotos || [];
  const { headerH, rowH, gap, leftover } = photoFeatureLayout(spec, n);

  const header = `<div ${dragAttrs("header", "")} style="position:absolute;top:${SP.xxl}px;left:${SP.lg}px;right:${SP.lg}px;
      text-align:right;direction:rtl;transform:${offsetT(spec, "header", "")}">
      <div style="font-size:${fs(44)};font-weight:800;line-height:1.2;color:#fff" contenteditable>${esc(spec.title)}</div>
      ${spec.subtitle ? `<div style="font-size:${fs(26)};font-weight:800;line-height:1.3;color:var(--accent);margin-top:2px"
        contenteditable>${esc(spec.subtitle)}</div>` : ""}
    </div>`;

  const rows = features.map((f, i) => {
    const h = i === n - 1 ? rowH + leftover : rowH;
    const top = headerH + i * (rowH + gap);
    const photo = photos[i]
      ? `<img src="${photos[i]}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;
           filter:saturate(1.05) contrast(1.03)">`
      : `<div style="position:absolute;inset:0;background:var(--accent);opacity:.35"></div>`;
    // Bottom-anchored scrim -- transparent over the top ~35% of the row
    // (where the photo can breathe) fading to a near-opaque dark base at
    // the bottom, where the heading/body actually sit.
    const scrim = `<div style="position:absolute;inset:0;
        background:linear-gradient(to bottom, rgba(10,6,10,0) 35%, rgba(10,6,10,.82) 100%)"></div>`;
    return `<div style="position:absolute;top:${top}px;left:0;width:100%;height:${h}px;overflow:hidden">
        ${photo}${scrim}
        <div style="position:absolute;left:${SP.lg}px;right:${SP.lg}px;bottom:${SP.md}px;
            text-align:right;direction:rtl;color:#fff;${shadowFor(true)}">
          <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end">
            <span style="font-size:${fs(19)};font-weight:800;line-height:1.3" contenteditable>${esc(f.heading)}</span>
            <span style="width:8px;height:8px;background:var(--accent);transform:rotate(45deg);flex:none"></span>
          </div>
          <div style="font-size:${fs(13)};font-weight:400;line-height:1.6;opacity:.92;margin-top:4px" contenteditable>${esc(f.body)}</div>
        </div>
      </div>`;
  }).join("");

  // Sampled from the actual uploaded photo(s) when available (see
  // deriveBgColor in prepareFamilyPhotos) so the header/footer/row-gap
  // fill always harmonises with whatever photo was used, instead of a
  // fixed palette hex that might clash. Falls back to the palette base
  // when there's no photo to sample from (e.g. the empty-state preview).
  const bg = ctx.photoBgColor || pal.base;
  return `<div style="position:absolute;inset:0;background:${bg}"></div>` + header + rows + logoStrip(ctx, true, true);
}

/* ===========================================================================
   FAMILY 5 -- portrait_quote  (measured off ref_09.jpg, a square reference
   adapted proportionally to this taller 800x1422 canvas)
   Portrait photo across the full width of the top ~46%, its bottom edge
   fading into the palette's base colour. A large pull-quote sits below,
   full width, right aligned, with a big faded quotation mark. Attribution
   is a small coloured role line + a bold name line beneath a thin rule.
   =========================================================================== */
function renderPortraitQuote(spec, ctx, pal) {
  const photo = (ctx.croppedPhotos || [])[0];
  const photoH = PORTRAIT_PHOTO_H;

  const img = photo
    ? `<img src="${photo}" style="position:absolute;top:0;left:0;width:100%;height:${photoH}px;object-fit:cover;
         -webkit-mask-image:linear-gradient(to bottom, #000 68%, transparent 100%);
         mask-image:linear-gradient(to bottom, #000 68%, transparent 100%)">`
    : "";

  // The quote block is vertically centred in the space below the photo
  // (down to the footer) rather than pinned right under it -- ref_09 is a
  // near-square canvas, so on this much taller 800x1422 poster, pinning to
  // the top of that space left a large dead gap under short attributions.
  // Centring means any quote length fills the space intentionally instead
  // of leaving a lopsided gap at the bottom.
  const text = `<div ${dragAttrs("quote", "")} style="position:absolute;top:${photoH}px;left:0;right:0;bottom:${FOOTER}px;
      display:flex;align-items:center;transform:${offsetT(spec, "quote", "")}">
      <div style="width:100%;padding:0 ${SP.lg}px;text-align:right;direction:rtl;color:#fff">
        ${spec.eyebrow ? `<div style="font-size:${fs(12)};font-weight:700;color:var(--accent);margin-bottom:${SP.sm}px"
          contenteditable>${esc(spec.eyebrow)}</div>` : ""}
        <div style="font-size:${fs(64)};font-weight:800;line-height:.5;color:var(--accent);opacity:.5">&rdquo;</div>
        <div style="font-size:${fs(34)};font-weight:800;line-height:1.4;margin-top:${SP.sm}px" contenteditable>${esc(spec.quote)}</div>
        ${spec.attribution ? `<div style="height:2px;width:56px;background:var(--accent);margin:${SP.lg}px 0 ${SP.sm}px auto"></div>
          <div style="font-size:${fs(15)};font-weight:700;color:var(--accent)" contenteditable>${esc(spec.attribution)}</div>` : ""}
      </div>
    </div>`;

  return `<div style="position:absolute;inset:0;background:var(--base)"></div>` + img + text + logoStrip(ctx, true, true);
}

/* ===========================================================================
   photo prep -- crop box(es) each family needs, matching the geometry
   above exactly (statGridBoxes/photoFeatureLayout are shared between the
   crop step and the render step so they can never drift apart).
   =========================================================================== */
async function prepareFamilyPhotos(spec, photoUrls) {
  if (!photoUrls || !photoUrls.length) return [];
  const family = spec.layout_family;
  const pi = spec.photo_info || {};

  if (family === "stat_grid") {
    const n = Math.max(2, Math.min(4, (spec.stats || []).length || 2));
    const boxes = statGridBoxes(n);
    const soloFocals = [[38, 38], [62, 38], [38, 62], [62, 62]];
    const out = [];
    for (let i = 0; i < n; i++) {
      const url = photoUrls[i % photoUrls.length];
      try {
        const img = await loadImage(url);
        const [fx, fy] = photoUrls.length > 1 ? [50, 50] : soloFocals[i % soloFocals.length];
        const photoH = Math.max(40, boxes[i].h - STAT_CAPTION_H);
        out.push(coverCrop(img, boxes[i].w, photoH, fx, fy));
      } catch { out.push(null); }
    }
    return out;
  }

  if (family === "photo_feature_list") {
    const n = Math.max(2, Math.min(4, (spec.features || []).length || 2));
    const { rowH } = photoFeatureLayout(spec, n);
    // Each row now runs full canvas width with the text overlaid near the
    // bottom (see renderPhotoFeatureList) -- focal points are biased
    // upward so a single reused photo keeps its subject clear of the
    // bottom scrim/text band across rows, not just centred.
    const soloFocals = [[35, 30], [65, 30], [50, 35], [40, 40]];
    const out = [];
    const colorSamples = [];
    for (let i = 0; i < n; i++) {
      const url = photoUrls[i % photoUrls.length];
      try {
        const img = await loadImage(url);
        colorSamples.push(averageColor(img));
        const [fx, fy] = photoUrls.length > 1 ? [50, 38] : soloFocals[i % soloFocals.length];
        out.push(coverCrop(img, W, rowH, fx, fy));
      } catch { out.push(null); }
    }
    // Header/footer/row-gap fill, sampled from the actual photo(s) in use
    // (see deriveBgColor) instead of the fixed palette base -- read by
    // renderPhotoFeatureList via ctx.photoBgColor. Falls back to the
    // palette when there's no photo to sample (out.bgColor left unset).
    if (colorSamples.length) out.bgColor = deriveBgColor(colorSamples);
    return out;
  }

  let box;
  if (family === "photo_band") box = { w: W, h: PHOTO_BAND_SEAM };
  else if (family === "portrait_quote") box = { w: W, h: PORTRAIT_PHOTO_H };
  else box = { w: W, h: H }; // full_bleed_photo

  try {
    const img = await loadImage(photoUrls[0]);
    return [coverCrop(img, box.w, box.h, pi.focal_x, pi.focal_y)];
  } catch {
    return [null];
  }
}

/* ===========================================================================
   dispatcher
   =========================================================================== */
function renderPoster(spec, ctx, palettes) {
  const pal = palettes[spec.palette] || palettes.institutional_green;
  const el = document.getElementById("poster");
  el.style.setProperty("--base", pal.base);
  el.style.setProperty("--accent", pal.accent);
  el.style.setProperty("--surface", pal.surface);
  el.style.setProperty("--text-scale", spec.text_scale || 1);

  let body;
  switch (spec.layout_family) {
    case "full_bleed_photo":     body = renderFullBleedPhoto(spec, ctx, pal); break;
    case "stat_grid":            body = renderStatGrid(spec, ctx, pal); break;
    case "photo_feature_list":   body = renderPhotoFeatureList(spec, ctx, pal); break;
    case "portrait_quote":       body = renderPortraitQuote(spec, ctx, pal); break;
    default:                     body = renderPhotoBand(spec, ctx, pal); break; // photo_band
  }

  el.innerHTML = body + (spec.degraded
    ? `<div style="position:absolute;top:0;left:0;right:0;padding:${SP.xs}px;background:#b3521f;
         color:#fff;font-size:12px;font-weight:700;text-align:center;direction:rtl">
         وضع مبسّط — الذكاء الاصطناعي غير متاح</div>` : "");
}
