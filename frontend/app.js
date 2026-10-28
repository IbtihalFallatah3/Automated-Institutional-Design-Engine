const S = { lang: null, logos: [], picked: [], photos: [], spec: null };
const $ = id => document.getElementById(id);

async function init() {
  const [lang, logos] = await Promise.all([
    fetch("/api/design-language").then(r => r.json()),
    fetch("/api/logos").then(r => r.json()),
  ]);
  S.lang = lang; S.logos = logos;
  S.picked = logos.slice(0, 3).map(l => l.slug);
  S.spec = {
    layout_family: "full_bleed_photo",
    palette: "institutional_green", occasion: "none", mood: "formal",
    text_zone: { anchor: "center", align: "center" },
    text_color: "light", scrim: "none", scrim_strength: 0,
    title: "اكتب الموضوع ثم اضغط توليد",
    subtitle: "", body: "", eyebrow: "", date_label: "",
    stats: [], features: [], quote: "", attribution: "", degraded: false,
    text_offsets: {}, // editor-only manual nudges, never AI-authored -- see render.js
    text_scale: 1, logo_scale: 1, // editor-only size overrides, same rule
  };
  drawLogos(); drawThumbs(); showSpec(); await draw(); fit();
  window.addEventListener("resize", fit);
}

function fit() {
  const wrap = document.querySelector(".stageWrap");
  const scale = Math.min(1, (wrap.clientHeight - 80) / 1422);
  S._scale = scale;
  const sc = $("scaler");
  sc.style.transform = `scale(${scale})`;
  sc.style.width = `${800 * scale}px`;
  sc.style.height = `${1422 * scale}px`;
}

// Raised from 4 -- municipal posters often carry more than 4 required
// marks (Vision 2030 + the ministry + the municipality + a co-organiser...).
// logoStrip() in render.js auto-shrinks logo height a bit past 4 so a
// full row still fits without overlapping.
const MAX_LOGOS = 6;
const pickedLogos = () => S.logos.filter(l => S.picked.includes(l.slug));
let _cropCacheKey = null;

async function draw() {
  const urls = S.photos.map(p => p.url);
  const pi = S.spec.photo_info || {};
  // Crop box for photo_feature_list now depends on feature count (row
  // height) and text_scale (header height, which shifts where rows start)
  // -- both need to be in the cache key or switching feature count/text
  // size would silently reuse crops sized for the old layout.
  const key = `${urls.join(",")}|${S.spec.layout_family}|${(S.spec.stats || []).length}|${(S.spec.features || []).length}|${S.spec.text_scale || 1}|${pi.focal_x}|${pi.focal_y}`;
  let croppedPhotos;
  if (key === _cropCacheKey && S._croppedCache) {
    croppedPhotos = S._croppedCache;
  } else {
    croppedPhotos = await prepareFamilyPhotos(S.spec, urls);
    _cropCacheKey = key;
    S._croppedCache = croppedPhotos;
  }
  renderPoster(S.spec, {
    photos: S.photos, logos: pickedLogos(), croppedPhotos, logoScale: S.spec.logo_scale || 1,
    // photo_feature_list only -- see deriveBgColor in render.js. Riding
    // along on the array (set by prepareFamilyPhotos) rather than a
    // separate cache entry, so it can never go stale independently of
    // the crops it was sampled from.
    photoBgColor: croppedPhotos.bgColor,
  }, S.lang.palettes);
  attachDragHandles();
  updateResetVisibility();
}

/* ------------------------------------------------------------------------
   Manual text repositioning -- each family's title/body/header/quote block
   (tagged data-drag-role by render.js) gets a small grab handle at its
   corner. Drag nudges it; the accumulated pixel delta is written into
   S.spec.text_offsets[role] so it survives the next re-render (photo swap,
   logo toggle, quality re-check). AI-generated content never touches this
   field -- it's purely an editor-side override for when the locked
   template's default spot doesn't quite fit a specific poster's content.
   ------------------------------------------------------------------------ */
const MOVE_ICON = `<svg viewBox="0 0 20 20" fill="none"><path d="M10 2v16M2 10h16M10 2l-3 3M10 2l3 3M10 18l-3-3M10 18l3-3M2 10l3-3M2 10l3 3M18 10l-3-3M18 10l-3 3"
  stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function attachDragHandles() {
  const poster = $("poster");
  poster.querySelectorAll("[data-drag-role]").forEach(block => {
    const role = block.dataset.dragRole;
    const base = block.dataset.baseTransform || "";
    const handle = document.createElement("div");
    handle.className = "dragHandle";
    handle.title = "اسحب لتحريك النص — انقر مرتين لإعادة الضبط";
    handle.innerHTML = MOVE_ICON;
    block.appendChild(handle);

    let start = null, startOffset = { dx: 0, dy: 0 }, pending = null;

    handle.addEventListener("pointerdown", e => {
      e.preventDefault(); e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      start = { x: e.clientX, y: e.clientY };
      startOffset = { ...((S.spec.text_offsets || {})[role] || { dx: 0, dy: 0 }) };
      block.style.zIndex = "50";
    });
    handle.addEventListener("pointermove", e => {
      if (!start) return;
      const scale = S._scale || 1;
      const dx = Math.round(startOffset.dx + (e.clientX - start.x) / scale);
      const dy = Math.round(startOffset.dy + (e.clientY - start.y) / scale);
      block.style.transform = `${base}${base ? " " : ""}translate(${dx}px,${dy}px)`;
      pending = { dx, dy };
    });
    const commit = () => {
      if (!start) return;
      start = null; block.style.zIndex = "";
      if (pending) {
        S.spec.text_offsets = S.spec.text_offsets || {};
        S.spec.text_offsets[role] = pending;
        pending = null;
        updateResetVisibility();
      }
    };
    handle.addEventListener("pointerup", commit);
    handle.addEventListener("pointercancel", commit);
    handle.addEventListener("dblclick", e => {
      e.preventDefault(); e.stopPropagation();
      if (S.spec.text_offsets) delete S.spec.text_offsets[role];
      draw();
    });
  });
}

function updateResetVisibility() {
  const any = Object.keys(S.spec.text_offsets || {}).length > 0;
  const btn = $("resetPosBtn");
  if (btn) btn.style.display = any ? "inline-flex" : "none";
}

// Export must never capture the drag handles themselves.
function withHandlesHidden(fn) {
  const handles = Array.from(document.querySelectorAll(".dragHandle"));
  handles.forEach(h => h.style.display = "none");
  return Promise.resolve().then(fn).finally(() => handles.forEach(h => h.style.display = ""));
}

// User-facing labels only -- the reference-file citations (ref_01, ref_08...)
// stay in design_language.json as developer documentation. A curious
// technical user can still see them via the title="" tooltip below; nobody
// publishing a poster needs "ref_03/06" in their face.
const FAMILY_LABELS = {
  photo_band: "صورة + شريط لوني",
  full_bleed_photo: "صورة كاملة الامتداد",
  stat_grid: "شبكة إحصائيات",
  photo_feature_list: "قائمة نقاط مصوّرة",
  portrait_quote: "بورتريه واقتباس",
};
const FAMILY_REFS = {
  photo_band: "ref_01.jpg", full_bleed_photo: "ref_03.jpg / ref_06.jpg",
  stat_grid: "ref_08.jpg", photo_feature_list: "ref_12.jpg", portrait_quote: "ref_09.jpg",
};
const PALETTE_LABELS = {
  institutional_green: "أخضر مؤسسي", heritage_bronze: "برونزي تراثي",
  royal_maroon: "عنّابي ملكي", sky_institutional: "أزرق سماوي",
  desert_gold: "ذهبي صحراوي", deep_night: "ليلي داكن",
};
const OCCASION_LABELS = {
  none: "عام", ramadan: "رمضان", eid: "عيد", national_day: "اليوم الوطني",
  founding_day: "يوم التأسيس", saudi_identity: "الهوية السعودية", heritage: "تراثي",
  harvest_season: "موسم حصاد", official_statement: "بيان رسمي",
  forum_event: "فعالية / منتدى", investment: "استثماري",
};
const MOOD_LABELS = {
  formal: "رسمي", celebratory: "احتفالي", reverent: "خاشع", energetic: "حيوي", calm: "هادئ",
};
const ANCHOR_LABELS = { top: "أعلى", upper: "أعلى الوسط", center: "الوسط", bottom: "أسفل", lower: "أسفل الوسط" };
const ALIGN_LABELS = { center: "توسيط", right: "يمين" };
const SCRIM_LABELS = { none: "بدون", soft: "خفيف" };

function paletteChip(key) {
  const pal = (S.lang.palettes || {})[key];
  const dot = pal ? `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;
    background:${pal.base};margin-inline-start:6px;vertical-align:middle"></span>` : "";
  return `${PALETTE_LABELS[key] || key}${dot}`;
}

// Compact, always-visible line -- what a publishing user actually needs to
// know at a glance. The full field-by-field breakdown lives in the
// collapsed "technical details" panel for whoever wants it.
function summaryLine() {
  const s = S.spec;
  if (!s || !s.title || s.title === "اكتب الموضوع ثم اضغط توليد") return "لم يتم التوليد بعد";
  const fam = FAMILY_LABELS[s.layout_family] || s.layout_family;
  return `${fam} · ${paletteChip(s.palette)}`;
}

function showSpec() {
  const s = S.spec, t = s.text_zone;
  const row = (k, v) => (v === undefined || v === null || v === "") ? "" :
    `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  let html = "";
  if (s.degraded) {
    html += `<div class="degradedBanner">وضع مبسّط — الذكاء الاصطناعي غير متاح
      <div style="font-weight:400;margin-top:4px">${(s.degraded_reason || "").slice(0, 120)}</div></div>`;
  }

  $("summaryLine").innerHTML = summaryLine();
  document.querySelector(".statusLine").classList.toggle("ready", !!(s.title && s.title !== "اكتب الموضوع ثم اضغط توليد"));

  html += row("القالب", `<span title="مقاس عن ${FAMILY_REFS[s.layout_family] || ""}">${FAMILY_LABELS[s.layout_family] || s.layout_family}</span>`)
        + row("اللون", paletteChip(s.palette))
        + row("المناسبة", s.occasion && s.occasion !== "none" ? OCCASION_LABELS[s.occasion] || s.occasion : "")
        + row("المزاج", MOOD_LABELS[s.mood] || s.mood);

  if (s.layout_family === "full_bleed_photo")
    html += row("موضع النص", `${ANCHOR_LABELS[t.anchor] || t.anchor} · ${ALIGN_LABELS[t.align] || t.align}`)
          + row("التظليل", SCRIM_LABELS[s.scrim] || s.scrim);
  if (s.layout_family === "stat_grid")
    html += row("عدد الإحصائيات", (s.stats || []).length);
  if (s.layout_family === "photo_feature_list")
    html += row("عدد النقاط", (s.features || []).length);
  if (s.layout_family === "portrait_quote")
    html += row("الاقتباس", s.quote ? (s.quote || "").slice(0, 40) + "…" : "");

  if (s.photo_info)
    html += row("قراءة الصورة", `الموضوع: ${s.photo_info.subject}`);
  $("specBox").innerHTML = html || `<div class="row"><span class="k">لا تفاصيل بعد</span></div>`;
}

function drawLogos() {
  $("logoChips").innerHTML = S.logos.map(l => {
    const v = l.variant_urls || {};
    const u = v.primary || v.black || v.white || Object.values(v)[0];
    return `<div class="chip ${S.picked.includes(l.slug) ? "on" : ""}" data-s="${l.slug}">
      <img src="${u}"><span>${l.name_ar}</span></div>`;
  }).join("");
  $("logoChips").querySelectorAll(".chip").forEach(c => c.onclick = () => {
    const s = c.dataset.s, i = S.picked.indexOf(s);
    if (i >= 0) S.picked.splice(i, 1); else if (S.picked.length < MAX_LOGOS) S.picked.push(s);
    drawLogos(); draw();
  });
}

function drawThumbs() {
  $("thumbs").innerHTML = S.photos.map((p, i) =>
    `<div class="t"><img src="${p.url}"><button data-i="${i}">&times;</button></div>`).join("");
  $("thumbs").querySelectorAll("button").forEach(b => b.onclick = () => {
    S.photos.splice(+b.dataset.i, 1); drawThumbs(); draw();
  });
}

function settle() {
  // One rAF to let the browser actually apply a style change (e.g.
  // transform:scale reset) and paint before html2canvas measures the DOM --
  // otherwise there's a narrow window where capture can start against
  // stale layout, a second possible source of preview/export mismatch.
  return new Promise(res => requestAnimationFrame(() => requestAnimationFrame(res)));
}

async function snapshot() {
  const sc = $("scaler"), prev = sc.style.transform;
  sc.style.transform = "scale(1)";
  await settle();
  const node = $("poster");
  await Promise.all(Array.from(node.querySelectorAll("img")).map(img =>
    (img.complete && img.naturalWidth) ? null : new Promise(res => {
      img.addEventListener("load", res, { once: true });
      img.addEventListener("error", res, { once: true });
    })));
  await document.fonts.ready;
  const canvas = await withHandlesHidden(() =>
    html2canvas(node, { scale: 1, useCORS: true, width: 800, height: 1422 }));
  sc.style.transform = prev;
  return canvas;
}

/* Stage 3: the critic actually closes the loop -- it looks at the rendered
   poster and we APPLY what it says, then re-render. */
async function runCritic() {
  const box = $("criticBox");
  box.style.display = "block";
  box.innerHTML = `<span class="k">...يفحص التصميم</span>`;
  try {
    const canvas = await snapshot();
    const fd = new FormData();
    fd.append("image_b64", canvas.toDataURL("image/jpeg", 0.7));
    const res = await fetch("/api/critique", { method: "POST", body: fd }).then(r => r.json());

    const adj = res.adjust || {};
    if (adj.text_color) S.spec.text_color = adj.text_color;
    if (adj.text_anchor) S.spec.text_zone.anchor = adj.text_anchor;
    if (adj.scrim) S.spec.scrim = adj.scrim;
    if (adj.scrim_strength !== undefined) {
      S.spec.scrim_strength = adj.scrim_strength;
      if (S.spec.scrim === "none") S.spec.scrim = "soft";
    }
    await draw(); showSpec();

    const issues = (res.issues || []).map(i => `<div>• ${i}</div>`).join("");
    const changed = Object.keys(adj);
    box.innerHTML = res.verdict === "good"
      ? `<div style="color:var(--ui-good);font-weight:700">التصميم جيد ✓</div>${issues}`
      : `<div style="font-weight:700">تم التعديل: ${changed.join("، ") || "—"}</div>${issues}`;
    document.querySelector(".statusLine").classList.toggle("ready", res.verdict === "good");
  } catch (e) {
    box.innerHTML = `<span class="k">تعذر الفحص: ${String(e).slice(0, 80)}</span>`;
  }
}

$("genBtn").onclick = async () => {
  const topic = $("topic").value.trim();
  if (!topic) return;
  const btn = $("genBtn");
  btn.disabled = true; btn.textContent = "...يقرأ الصورة ويصمم";
  $("criticBox").innerHTML = "";
  $("criticBox").style.display = "none";
  try {
    const fd = new FormData();
    fd.append("topic", topic);
    if (S.photos[0]) fd.append("photo_url", S.photos[0].url);
    // Text/logo SIZE is a display preference for this session, not part of
    // the poster's content -- keep it across a fresh generation. Manual
    // text POSITION nudges are content-specific, so those correctly reset
    // (the server response has no text_offsets field).
    const keepScale = { text_scale: S.spec.text_scale, logo_scale: S.spec.logo_scale };
    S.spec = await fetch("/api/generate", { method: "POST", body: fd }).then(r => r.json());
    Object.assign(S.spec, keepScale);
    showSpec(); await draw();
    if (!S.spec.degraded && $("useCritic").checked) {
      btn.textContent = "...يفحص التصميم";
      await runCritic();
    }
  } catch (e) {
    alert("تعذر الاتصال بالخادم");
  } finally {
    btn.disabled = false; btn.textContent = "توليد";
  }
};

$("criticBtn").onclick = runCritic;
$("resetPosBtn").onclick = () => { S.spec.text_offsets = {}; draw(); };

$("textScaleSel").onchange = e => { S.spec.text_scale = parseFloat(e.target.value); draw(); };
$("logoScaleSel").onchange = e => { S.spec.logo_scale = parseFloat(e.target.value); draw(); };
$("photoBtn").onclick = () => $("photoInput").click();
function checkPhotoResolution(img) {
  // Export captures at 2x the 800px canvas width for crisp text -- a photo
  // narrower than that has to be upscaled by the browser, which is what
  // makes it look soft compared to the (vector, always-crisp) text. Warn
  // up front rather than let it be a surprise at export time.
  const needed = 1600;
  if (img.naturalWidth && img.naturalWidth < needed) {
    return `هذه الصورة ${img.naturalWidth}px فقط — قد تظهر بجودة أقل من النص عند التصدير (الأفضل ${needed}px+ على الضلع الطويل).`;
  }
  return null;
}

$("photoInput").onchange = async e => {
  const warnings = [];
  for (const f of Array.from(e.target.files).slice(0, 4 - S.photos.length)) {
    const fd = new FormData(); fd.append("file", f);
    let url;
    try { url = (await (await fetch("/api/upload", { method: "POST", body: fd })).json()).url; }
    catch { url = URL.createObjectURL(f); }
    S.photos.push({ url });
    const dims = await new Promise(res => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth });
      im.onerror = () => res({ w: 0 });
      im.src = url;
    });
    const w = { naturalWidth: dims.w };
    const warn = checkPhotoResolution(w);
    if (warn) warnings.push(warn);
  }
  drawThumbs(); draw();
  $("photoWarn").innerHTML = warnings.length
    ? warnings.map(w => `<div style="color:#a4682a">${w}</div>`).join("") : "";
};

$("exportBtn").onclick = async () => {
  const btn = $("exportBtn");
  btn.disabled = true; btn.textContent = "...جارٍ التصدير";
  try {
    const sc = $("scaler"), prev = sc.style.transform;
    sc.style.transform = "scale(1)";
    await settle();
    const node = $("poster");
    await Promise.all(Array.from(node.querySelectorAll("img")).map(img =>
      (img.complete && img.naturalWidth) ? null : new Promise(res => {
        img.addEventListener("load", res, { once: true });
        img.addEventListener("error", res, { once: true });
      })));
    await document.fonts.ready;
    const canvas = await withHandlesHidden(() =>
      html2canvas(node, { scale: 2, useCORS: true, width: 800, height: 1422 }));
    sc.style.transform = prev;
    const a = document.createElement("a");
    a.download = "poster.png"; a.href = canvas.toDataURL("image/png"); a.click();
  } finally {
    btn.disabled = false; btn.textContent = "تصدير PNG";
  }
};

init();
