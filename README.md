# Madinah Poster — v13

Fresh start. Small on purpose: 3 layouts built properly, not 100 built badly.

## Run it

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env            # optional — paste a free Groq key inside
python -m uvicorn app:app --reload --port 8000
```
Open http://localhost:8000

Works with no key at all (falls back to local rules). The key just makes
the art direction and copy smarter.

### If install fails

Dependencies are pure-Python with prebuilt wheels — nothing compiles, so
installation should be quick and painless on any OS.

If you still hit a build error mentioning **Pillow**, **numpy**, or
**zlib**, you're installing an old requirements file. v13 does no image
processing in Python (uploads are copied byte-for-byte, all rendering
happens in the browser), so neither library is needed. Re-check that
`requirements.txt` matches the one in this zip.

Tested against Python 3.11-3.14. If your Python is very new and a
dependency has no wheel yet, Python 3.12 or 3.13 is the safest fallback.

## How it works — AI does the design

Three model calls per poster. Each does something the renderer cannot:

1. **Vision reads your photo** — where's the subject, which regions are quiet
   enough for text, is that area light or dark, where's the focal point.
2. **The model authors a layout spec** — not a template name. It decides the
   background treatment, which region the text occupies, how wide the column
   is, the title size, the element order, what stays empty, and the text
   colour. Plus the Arabic copy.
3. **Vision critiques the rendered poster** — the browser screenshots the
   result, sends it back, and the model reports contrast/collision/balance
   problems with concrete adjustments. Those get applied and it re-renders.

`render.js` contains **no layout presets**. It only executes the spec.

Everything the model returns is clamped to valid ranges before rendering, so
a hallucinated value can't produce a broken poster — but it also can't be
ignored into irrelevance.

## Without a key, output is deliberately plain

If there's no `GROQ_API_KEY`, you get a flat colour card with centred text and
an orange "وضع مبسّط" banner. That's intentional. Earlier versions hid a full
design system behind the AI path, so the result was nearly identical either
way — which made the AI pointless. Now its absence is visible.

## Cost of this

~3 API calls and 5-10 seconds per poster instead of one instant call. Rate
limits matter more. That's the trade for the AI doing real work.

## Your references

13 posters in `backend/references/` (downscaled from the originals; the
dates ones were 30MB, over the API's 20MB limit). The sidebar shows which
references match the current brief.

`references/references.json` currently holds **hand-seeded** tags. To have
the vision model tag them properly against the vocabulary:

```bash
python tag_references.py        # needs GROQ_API_KEY, one-time
```

## Known gaps (honest)

- **6 of 11 occasions have no reference example** — including `ramadan` and
  `national_day`. The vocabulary names them and the ornament/palette
  defaults handle them, but there's no reference poster grounding what they
  should look like. Add a few and re-run tagging.
- **3 layouts only.** Deliberate. Judge these before more get built.
- **No vision critic yet.** That's the next piece — render, screenshot,
  have the model check contrast/collisions, fix. Not built.
- Reference tags are provisional until `tag_references.py` is run.

## If the AI says "unavailable"

Open **http://localhost:8000/api/diagnose** in your browser. It reports the
exact reason, including Groq's own error message — a bare "400 Bad Request"
on its own tells you nothing.

Common causes:

- **Key not loaded.** `.env` must sit in `backend/` next to `app.py`, contain
  `GROQ_API_KEY=gsk_...`, and the server must be **restarted** — `.env` is
  only read at startup.
- **Model retired.** Groq rotates models often (they retired `qwen/qwen3-32b`
  in June 2026). If `/api/diagnose` reports an unknown-model error, check
  https://console.groq.com/docs/models and update `GROQ_MODEL` at the top of
  `backend/brief.py` — it's a single constant.
- **Rejected parameters.** Some model builds reject JSON mode or
  `reasoning_effort`. The code now retries automatically without them, so
  this should self-heal.

Generation never fails because of this — it falls back to local rules and
still produces a poster.


## Fixed: logos unreadable, export looks different from preview

Two separate real issues, both from actual review of exported posters:

**Logos with no backing.** The footer logo strip had zero background —
logos sat directly on raw photo pixels, so a logo blended in wherever it
happened to be close in tone to the image behind it (dark logo on dark
tree silhouette, light logo on a bright sky patch). Fixed with a solid
backing bar behind the footer always, dark or light depending on context,
so logos have guaranteed contrast regardless of what's in the photo.

**Photo softer than text on export.** Not a bug in the code — a real
resolution ceiling. The on-screen preview is shown scaled *down* to fit
your window, and scaling an image down always looks clean regardless of
its actual resolution. Export resets to full size and captures at 2x (for
crisp text), which asks for ~1600px of real detail from your photo. Text
stays sharp at any scale because it's vector-rendered; a photo can't
produce detail it doesn't have, so it looks soft by comparison. Fixed by
warning at upload time if a photo is under 1600px on its long edge, before
you export and get surprised. Also added a settle frame before every
screenshot (export and the critic) as a defensive fix for any residual
preview/capture timing gap.

**Practical takeaway: upload photos at 1600px+ on the long edge** if you
want them to look as sharp as the text once exported.

## Fixed: garbled eyebrow text, colliding honorific symbol, stretched photo on export, tiny logos

Four separate real issues, found from actual exported posters:

**Garbled eyebrow badge text.** The eyebrow pill was the only element using
`letter-spacing`. Arabic is a cursive, letter-joining script — forcing
spacing between characters breaks the browser's ability to connect them,
which is what scrambled the text. Removed everywhere in the project (a
sidebar label and a dead leftover CSS rule had it too), not just where it
was actively firing.

**A small icon colliding with text.** Caused by `ﷺ` (U+FDFA), a
single-codepoint Arabic *ligature* for "peace be upon him." Tajawal likely
doesn't include a glyph for it, so the browser silently substitutes a
different font just for that character — which renders at different
metrics and collides with the surrounding text. Fixed by expanding it (and
its counterpart `ﷻ`) into normal multi-character Arabic text at the
source, which Tajawal fully supports. Sidesteps the whole class of
missing-ligature issues rather than chasing individual glyphs.

**Stretched photo on export.** A different, sneakier bug than the
resolution/softness issue from before — `object-fit: cover` was correct in
the CSS and rendered fine in the live browser preview, but `html2canvas`
(what actually rasterizes the export) has a known limitation: it doesn't
reliably honour `object-fit`/`object-position`, and can silently stretch
the raw image to fill its box instead of cropping it. Fixed by doing the
cropping ourselves, in a `<canvas>`, before html2canvas ever runs — replaced
the CSS-fit `<img>` with an already-correctly-cropped data URL, so there's
no fit logic left for html2canvas to get wrong. Verified the crop math
directly: output aspect ratio matches the target box exactly in every
tested case, and off-center focal points stay within the source image's
bounds instead of cropping outside it.

**Logos too small to read.** Were 34px tall on a 1422px-tall canvas — under
2.5% of the poster's height. Increased to 46px with a taller footer bar and
more spacing between them.

## Fixed: posters looked plain -- only text on a photo

Real, structural feedback, not a bug report: every generated poster was
photo → black veil → stacked text → thin rule → logos, and nothing else.
The palette barely showed up anywhere except a small eyebrow pill.

Root cause: the design prompt pushed restraint so hard ("leave a third
empty", "restraint reads as designed") that the model was converging on
the emptiest possible option every time, and the vocabulary's own default
ornament was "none" -- so the safe choice and the encouraged choice were
the same choice. Nothing was actually broken; the system just had no
reason to ever pick the richer options that already existed.

Fixed three ways:

- **Veils can now carry the palette's own colour** (`background.veil_tint`,
  defaults to true) instead of always being plain black -- a real `rgba()`
  gradient tinted with the palette's base colour, not `color-mix()` (which
  has known export-compatibility problems in html2canvas). This alone is
  the difference between "generic dark photo with text" and "a poster in
  this organisation's colours."
- **A real accent panel for body text** (`hierarchy.show_accent_panel`,
  defaults to true when there's body text) -- a solid card with a coloured
  border, not floating paragraphs. An actual structural element.
- **A bold new ornament, `corner_accent`** -- a solid-colour wedge at full
  opacity, distinct from the existing subtle line-pattern ornaments
  (diamond/arch/chevron/arabesque), which are easy to miss at a glance.

And the prompt itself was rebalanced: restraint is now defined as
disciplined typography and real whitespace, explicitly NOT as omitting
every mark -- a bare photo-plus-text poster is named as the failure mode
in the prompt, not the goal.

The degraded (no-AI) fallback deliberately keeps all of this off -- it
should still look obviously plain, that's the point of it existing.
Verified directly: the AI-path defaults for the new fields are on, the
fallback's are off, and a full spec using every new option renders
without error alongside a degraded spec.
