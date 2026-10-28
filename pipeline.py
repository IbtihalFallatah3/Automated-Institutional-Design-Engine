"""
AI-PRIMARY pipeline. Three model calls, each doing something the renderer
genuinely cannot do on its own:

  1. see_photo()     -- vision: where is the subject, where is it safe to put
                        text, is that region light or dark?
  2. design()        -- the model AUTHORS a layout spec: composition, region,
                        hierarchy, emphasis, what stays empty. Not a preset name.
  3. critique()      -- vision: look at the RENDERED poster and return concrete
                        adjustments (contrast, collision, balance).

Deliberate design decision (see fallback_spec): when the AI is unavailable the
output is *visibly plain* -- one centred block, no photo intelligence, no
ornament -- and flagged as degraded. Earlier versions hid a full design system
behind the AI path so the result was near-identical either way, which made the
AI pointless. If the model is doing real work, its absence should be obvious.

Everything the model returns is clamped/validated before it reaches the
renderer, so it can still never emit something unrenderable.
"""
import json
import os
import re
import base64

BASE = os.path.dirname(__file__)
LANG_PATH = os.path.join(BASE, "design_language.json")
REFS_PATH = os.path.join(BASE, "references", "references.json")

GROQ_MODEL = "llama-3.2-11b-vision-preview"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"


def load_language():
    with open(LANG_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_references():
    try:
        with open(REFS_PATH, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


# ----------------------------------------------------------------- transport

def _post(payload: dict, api_key: str, timeout: int = 40, _retries: int = 2):
    """POST to Groq, surfacing the REAL error text on failure, and retrying
    once or twice on 429 with the server-specified backoff (Retry-After
    header) -- a burst of 3 calls per poster can trip the per-minute cap
    even when the account has plenty of daily quota left."""
    import requests, time
    for attempt in range(_retries + 1):
        r = requests.post(GROQ_URL, headers={"Authorization": f"Bearer {api_key}"},
                          json=payload, timeout=timeout)
        if r.status_code == 429 and attempt < _retries:
            wait = float(r.headers.get("retry-after", 2 * (attempt + 1)))
            time.sleep(min(wait, 10))
            continue
        if r.status_code >= 400:
            try:
                detail = r.json().get("error", {}).get("message") or r.text
            except Exception:
                detail = r.text
            raise RuntimeError(f"Groq {r.status_code}: {detail[:400]}")
        return r.json()


def _chat(messages, api_key, json_mode=True, temperature=0.4):
    payload = {
        "model": GROQ_MODEL,
        "messages": messages,
        "temperature": temperature,
        "reasoning_effort": "none",
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    try:
        data = _post(payload, api_key)
    except RuntimeError as e:
        if "400" not in str(e):
            raise
        payload.pop("response_format", None)
        payload.pop("reasoning_effort", None)
        data = _post(payload, api_key)
    return _parse_json(data["choices"][0]["message"]["content"])


def _parse_json(text: str) -> dict:
    text = re.sub(r"<think>.*?</think>", "", text.strip(), flags=re.DOTALL).strip()
    text = re.sub(r"^```json|^```|```$", "", text.strip()).strip()
    s, e = text.find("{"), text.rfind("}")
    return json.loads(text[s:e + 1] if s != -1 and e != -1 else text)


def _img_msg(text, b64):
    return {"role": "user", "content": [
        {"type": "text", "text": text},
        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
    ]}


# ------------------------------------------------------- 1. photo understanding

PHOTO_PROMPT = """Analyse this photo for use as a poster background.
Return ONLY JSON:
{
 "subject": "top|upper|center|lower|bottom",       // where the main subject sits
 "quiet_zones": ["top","upper","center","lower","bottom"],  // regions calm enough to hold text, best first
 "brightness": {"top":"light|mid|dark","center":"light|mid|dark","bottom":"light|mid|dark"},
 "focal_x": 0-100, "focal_y": 0-100,               // centre of interest, percent
 "busy": true|false                                 // is the image visually noisy overall
}
No commentary."""


def see_photo(photo_path: str, api_key: str) -> dict:
    with open(photo_path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()
    raw = _chat([_img_msg(PHOTO_PROMPT, b64)], api_key, temperature=0.1)
    return clamp_photo(raw)


ZONES = ("top", "upper", "center", "lower", "bottom")
LEVELS = ("light", "mid", "dark")


def clamp_photo(r: dict) -> dict:
    b = r.get("brightness") or {}
    return {
        "subject": r.get("subject") if r.get("subject") in ZONES else "center",
        "quiet_zones": [z for z in (r.get("quiet_zones") or []) if z in ZONES] or ["bottom"],
        "brightness": {k: (b.get(k) if b.get(k) in LEVELS else "mid") for k in ("top", "center", "bottom")},
        "focal_x": _num(r.get("focal_x"), 50, 0, 100),
        "focal_y": _num(r.get("focal_y"), 50, 0, 100),
        "busy": bool(r.get("busy", False)),
    }


def _num(v, default, lo, hi):
    try:
        return max(lo, min(hi, float(v)))
    except (TypeError, ValueError):
        return default


# --------------------------------------------------------- 2. the design call

def _design_prompt(lang, photo_info, refs_summary):
    v = lang["vocabulary"]
    families = {k: desc for k, desc in v["layout_family"].items() if k != "_note"}
    family_keys = list(families.keys())
    family_lines = "\n".join(f'  - "{k}": {desc}' for k, desc in families.items())

    return f"""You are the copywriter and content editor for a Saudi municipal poster.
Canvas is 800x1422 px. You do NOT design the layout -- every position, size
and decoration is already fixed in code, measured directly off this
organisation's own reference posters. Your only two jobs are:

STEP 1 — pick layout_family: which fixed template actually fits this
content. This is still the most important decision you make, because it's
the only lever you have on structure:

{family_lines}

Vary your choice across generations the way a real editor reaches for a
different template per story -- do not default to the same family every
time. Most single-subject topics with a supporting photo are "photo_band".
Reach for "stat_grid" only when there are genuinely 2-4 countable facts,
"photo_feature_list" only when there are 2-4 distinct points, "portrait_quote"
only for an attributed statement from a named person, and "full_bleed_photo"
only when the photograph itself is the whole statement. Never invent stats,
feature points, or a quote that aren't actually implied by the topic -- a
photo_band with real content beats a stat_grid with made-up numbers.

STEP 2 — write the content for that family. Return ONLY JSON. Include the
fields common to every poster, plus ONLY the block for the family you picked:

{{
 "layout_family": one of {family_keys},
 "occasion": one of {list(v['occasion'].keys())},
 "mood": one of {list(v['mood'].keys())},
 "palette": one of {list(lang['palettes'].keys())},
 "title": "...", "eyebrow": "...", "date_label": "...",   // Arabic. "" if not needed.

 // -- if layout_family is "photo_band" --
 "body": "one short Arabic paragraph, 2-4 sentences",

 // -- if layout_family is "full_bleed_photo" --
 "subtitle": "...",
 "text_zone": {{
   "anchor": "top"|"upper"|"center"|"lower"|"bottom",  // MUST be one of photo_info.quiet_zones below
   "align": "right"|"center"
 }},
 "text_color": "light"|"dark",   // must contrast the photo at that anchor
 "scrim": "none"|"soft",         // "soft" adds a translucent panel sized to the text block only --
                                  // it never dims the rest of the photo. Default "none"; only use
                                  // "soft" when the quiet zone genuinely isn't calm enough on its own.
 "scrim_strength": 0.0-0.7,

 // -- if layout_family is "stat_grid" --
 "subtitle": "...",
 "stats": [ {{"value": "short figure, e.g. '72'", "label": "short Arabic caption"}}, ... ],  // 2-4 items, real ones

 // -- if layout_family is "photo_feature_list" --
 "subtitle": "a short second headline LINE, not a paragraph",
 "features": [ {{"heading": "short Arabic phrase", "body": "one short Arabic sentence"}}, ... ],  // 2-4 items

 // -- if layout_family is "portrait_quote" --
 "quote": "the Arabic pull-quote, one or two sentences",
 "attribution": "name and/or title of who said it, Arabic"
}}

RULES:
- Only fields for the family you picked, plus the common ones. Leave others out.
- In full_bleed_photo, text_zone.anchor MUST be one of the photo's actual
  quiet_zones below, never over the reported subject, and text_color must
  contrast whatever is actually behind it at that anchor.
- Keep every string short -- these are fixed-size templates, not flexible
  text boxes. A title is a headline, not a sentence; a stat label is 2-4
  words; a feature body is one short sentence.

PHOTO ANALYSIS (only relevant to photo_band, full_bleed_photo,
portrait_quote, and stat_grid's tile focal points):
{json.dumps(photo_info, ensure_ascii=False) if photo_info else "No photo supplied — prefer photo_feature_list or stat_grid (tiles fall back to a flat colour) unless a portrait will be supplied separately for portrait_quote."}

REFERENCE POSTERS in this organisation's style, for tone:
{refs_summary}

JSON only."""


def design(topic: str, photo_info: dict, api_key: str, lang: dict) -> dict:
    refs = load_references()
    summary = "; ".join(
        f"{r.get('occasion')}/{r.get('mood')}/{r.get('density')}" for r in refs[:8]
    ) or "none available"
    raw = _chat([
        {"role": "system", "content": _design_prompt(lang, photo_info, summary)},
        {"role": "user", "content": topic},
    ], api_key, temperature=0.6)
    return clamp_spec(raw, topic, lang)


# --------------------------------------------------------------- 3. the critic

CRITIQUE_PROMPT = """This is a rendered poster. Judge it as a design director.

Check: is the title/quote clearly legible against what's behind it? Does
text collide with the photo's subject? Does the chosen layout_family
actually suit the content (e.g. a stat_grid whose numbers look invented, a
portrait_quote with an awkward photo crop)? Layout positions/sizes are
fixed by the template and can't be changed -- only flag problems that are
actually fixable (contrast, which quiet zone, whether a scrim is needed).

Return ONLY JSON:
{
 "verdict": "good" | "needs_fix",
 "issues": ["short description", ...],
 "adjust": {
   "scrim": "none"|"soft",                    // omit if fine -- full_bleed_photo only
   "scrim_strength": 0.0-0.7,                 // omit if fine
   "text_color": "light"|"dark",              // omit if fine -- full_bleed_photo only
   "text_anchor": "top"|"upper"|"center"|"lower"|"bottom"  // omit if fine -- full_bleed_photo only
 }
}
Only include keys in "adjust" that genuinely need changing. If it looks good,
return "good" with an empty adjust object. No commentary."""


def critique(poster_b64: str, api_key: str) -> dict:
    raw = _chat([_img_msg(CRITIQUE_PROMPT, poster_b64)], api_key, temperature=0.2)
    adj = raw.get("adjust") or {}
    clean = {}
    if adj.get("text_color") in ("light", "dark"):
        clean["text_color"] = adj["text_color"]
    if adj.get("text_anchor") in ZONES:
        clean["text_anchor"] = adj["text_anchor"]
    if adj.get("scrim") in SCRIMS:
        clean["scrim"] = adj["scrim"]
    if "scrim_strength" in adj:
        clean["scrim_strength"] = _num(adj["scrim_strength"], 0.4, 0.0, 0.7)
    return {
        "verdict": "needs_fix" if clean else "good",
        "issues": [str(i)[:160] for i in (raw.get("issues") or [])][:4],
        "adjust": clean,
    }


# ------------------------------------------------------------ validation/clamp

LAYOUT_FAMILIES = ("photo_band", "full_bleed_photo", "stat_grid", "photo_feature_list", "portrait_quote")
SCRIMS = ("none", "soft")


LIGATURE_EXPANSIONS = {
    # Single-codepoint Arabic ligatures that many fonts (including Tajawal)
    # don't include a glyph for. When missing, the browser silently falls
    # back to a different font for just that character, which renders at
    # different metrics and collides with the surrounding text. Expanding
    # to the normal multi-character spelling sidesteps the whole class of
    # font-coverage issues rather than chasing one glyph at a time.
    "\uFDFA": "صلى الله عليه وسلم",  # ﷺ
    "\uFDFB": "جل جلاله",            # ﷻ
}


def _expand_ligatures(text: str) -> str:
    if not text:
        return text
    for lig, expansion in LIGATURE_EXPANSIONS.items():
        text = text.replace(lig, expansion)
    return text


def _sanitize_text_fields(spec: dict) -> dict:
    for field in ("title", "subtitle", "body", "eyebrow", "date_label", "quote", "attribution"):
        if spec.get(field):
            spec[field] = _expand_ligatures(spec[field])
    for s in spec.get("stats") or []:
        s["label"] = _expand_ligatures(s.get("label", ""))
    for f in spec.get("features") or []:
        f["heading"] = _expand_ligatures(f.get("heading", ""))
        f["body"] = _expand_ligatures(f.get("body", ""))
    return spec


def _clean_stats(raw) -> list:
    """2-4 real {value, label} pairs, or an empty list. Never invents
    content -- an item missing either field is dropped rather than padded,
    so clamp_spec can tell a genuine stat_grid apart from a hallucinated
    one and fall back if there's nothing real to show."""
    out = []
    for item in (raw or [])[:4]:
        if not isinstance(item, dict):
            continue
        value = str(item.get("value") or "").strip()
        label = str(item.get("label") or "").strip()
        if value and label:
            out.append({"value": value[:12], "label": label[:40]})
    return out


def _clean_features(raw) -> list:
    out = []
    for item in (raw or [])[:4]:
        if not isinstance(item, dict):
            continue
        heading = str(item.get("heading") or "").strip()
        body = str(item.get("body") or "").strip()
        if heading:
            out.append({"heading": heading[:60], "body": body[:120]})
    return out


def clamp_spec(r: dict, topic: str, lang: dict) -> dict:
    v, pal, d = lang["vocabulary"], lang["palettes"], lang["defaults"]
    fam_vocab = [k for k in v["layout_family"] if k != "_note"]

    tz_in = r.get("text_zone") or {}
    text_zone = {
        "anchor": tz_in.get("anchor") if tz_in.get("anchor") in ZONES else "lower",
        "align": "center" if tz_in.get("align") == "center" else "right",
    }

    stats = _clean_stats(r.get("stats"))
    features = _clean_features(r.get("features"))
    quote = str(r.get("quote") or "").strip()

    # Graceful fallback chain -- render.js should never receive a family it
    # can't actually build a good poster from. A stat_grid with one stat, a
    # feature list with one feature, or a quote layout with no quote all
    # collapse to photo_band instead of shipping a broken/empty layout.
    family = r.get("layout_family") if r.get("layout_family") in fam_vocab else d["layout_family"]
    if family == "stat_grid" and len(stats) < 2:
        family = "photo_band"
    if family == "photo_feature_list" and len(features) < 2:
        family = "photo_band"
    if family == "portrait_quote" and not quote:
        family = "photo_band"

    spec = {
        "layout_family": family,
        "occasion": r.get("occasion") if r.get("occasion") in v["occasion"] else d["occasion"],
        "mood": r.get("mood") if r.get("mood") in v["mood"] else d["mood"],
        "palette": r.get("palette") if r.get("palette") in pal else d["palette"],

        "title": str(r.get("title") or topic).strip()[:80],
        "eyebrow": str(r.get("eyebrow") or "").strip()[:40],
        "date_label": str(r.get("date_label") or "").strip()[:24],
        "subtitle": str(r.get("subtitle") or "").strip()[:60],
        "body": str(r.get("body") or "").strip()[:360],

        "text_zone": text_zone,
        "text_color": "dark" if r.get("text_color") == "dark" else "light",
        "scrim": r.get("scrim") if r.get("scrim") in SCRIMS else "none",
        "scrim_strength": _num(r.get("scrim_strength"), 0.4, 0.0, 0.7),

        "stats": stats,
        "features": features,
        "quote": quote[:200],
        "attribution": str(r.get("attribution") or "").strip()[:60],

        "ai_used": "groq",
        "degraded": False,
    }
    return _sanitize_text_fields(spec)


# ------------------------------------------------------------- degraded output

def fallback_spec(topic: str, lang: dict, reason: str) -> dict:
    """Deliberately plain. No photo intelligence, no considered content --
    a flat colour card with centred text (full_bleed_photo with no photo
    supplied renders as a flat --base card). This is what the poster looks
    like WITHOUT the AI, and it should look like it."""
    spec = {
        "layout_family": "full_bleed_photo",
        "occasion": "none", "mood": "formal",
        "palette": lang["defaults"]["palette"],
        "title": topic.strip(), "eyebrow": "", "date_label": "",
        "subtitle": "", "body": "",
        "text_zone": {"anchor": "center", "align": "center"},
        "text_color": "light", "scrim": "none", "scrim_strength": 0,
        "stats": [], "features": [], "quote": "", "attribution": "",
        "ai_used": "none", "degraded": True, "degraded_reason": reason,
    }
    return _sanitize_text_fields(spec)


# ------------------------------------------------------------------- top level

def generate(topic: str, photo_path: str = None, api_key: str = None) -> dict:
    lang = load_language()
    if not api_key:
        return fallback_spec(topic, lang, "No GROQ_API_KEY configured.")
    photo_info = None
    notes = []
    if photo_path and os.path.exists(photo_path):
        try:
            photo_info = see_photo(photo_path, api_key)
        except Exception as e:
            notes.append(f"photo analysis failed: {e}")
    try:
        spec = design(topic, photo_info, api_key, lang)
        spec["photo_info"] = photo_info
        if notes:
            spec["notes"] = notes
        return spec
    except Exception as e:
        return fallback_spec(topic, lang, f"AI call failed: {e}")


def diagnose(api_key: str = None) -> dict:
    key = api_key or os.environ.get("GROQ_API_KEY")
    if not key:
        return {"ok": False, "stage": "key",
                "detail": "No GROQ_API_KEY found. Put it in backend/.env as GROQ_API_KEY=gsk_... "
                          "then RESTART the server (.env is read only at startup)."}
    if not key.startswith("gsk_"):
        return {"ok": False, "stage": "key",
                "detail": f"Key starts with '{key[:4]}...', expected 'gsk_'."}
    try:
        data = _post({"model": GROQ_MODEL,
                      "messages": [{"role": "user", "content": "Reply with: ok"}],
                      "max_completion_tokens": 10}, key)
        return {"ok": True, "model": GROQ_MODEL,
                "reply": data["choices"][0]["message"]["content"][:80]}
    except Exception as e:
        return {"ok": False, "stage": "request", "model": GROQ_MODEL, "detail": str(e)}
