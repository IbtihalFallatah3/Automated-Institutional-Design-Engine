"""
Tags every poster in references/ against the closed vocabulary in
design_language.json, using the SAME multimodal model already used for
copywriting (qwen/qwen3.6-27b on Groq, which accepts image input).

Run once after adding or changing reference posters:

    python tag_references.py

Writes references/references.json. If no GROQ_API_KEY is set, it leaves
the existing hand-seeded tags alone rather than wiping them -- the app
works fine either way, tagging just makes retrieval sharper.

Why this is a script and not a runtime step: tagging the reference set is
a one-time indexing job. Doing it per-request would waste quota and add
latency for zero benefit, since the references don't change between
requests.
"""
import base64
import json
import os
import re
import sys

from dotenv import load_dotenv
load_dotenv()

BASE = os.path.dirname(__file__)
REFS_DIR = os.path.join(BASE, "references")
TAGS_PATH = os.path.join(REFS_DIR, "references.json")
LANG_PATH = os.path.join(BASE, "design_language.json")

GROQ_MODEL = "llama-3.2-11b-vision-preview"


def load_language():
    with open(LANG_PATH, encoding="utf-8") as f:
        return json.load(f)


def _extract_json(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text.strip(), flags=re.DOTALL).strip()
    text = re.sub(r"^```json|^```|```$", "", text.strip()).strip()
    start, end = text.find("{"), text.rfind("}")
    return text[start:end + 1] if start != -1 and end != -1 else text


def tag_one(path: str, lang: dict, api_key: str) -> dict:
    import requests
    vocab = lang["vocabulary"]
    palettes = list(lang["palettes"].keys())

    prompt = (
        "You are cataloguing a poster for a design reference library. "
        "Look at the image and return ONLY a JSON object with these keys, "
        "choosing EXACTLY ONE value per key from the allowed lists:\n"
        f"occasion: {list(vocab['occasion'].keys())}\n"
        f"mood: {list(vocab['mood'].keys())}\n"
        f"density: {list(vocab['density'].keys())}\n"
        f"ornament: {list(vocab['ornament'].keys())}\n"
        f"palette: {palettes}\n"
        "Also include: has_photo (true/false), photo_role (one of: "
        "full_bleed, inset, cutout_subject, none), and "
        "text_position (one of: top, center, lower_third, bottom).\n"
        "No commentary, JSON only."
    )

    with open(path, "rb") as fh:
        b64 = base64.b64encode(fh.read()).decode()

    resp = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {api_key}"},
        json={
            "model": GROQ_MODEL,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                ],
            }],
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
        },
        timeout=60,
    )
    resp.raise_for_status()
    raw = resp.json()["choices"][0]["message"]["content"]
    return json.loads(_extract_json(raw))


def validate(tags: dict, lang: dict) -> dict:
    """Force every value back into the vocabulary. A model returning
    something unexpected must never poison the reference index."""
    vocab, palettes, defaults = lang["vocabulary"], lang["palettes"], lang["defaults"]
    out = {}
    for field in ("occasion", "mood", "density", "ornament"):
        val = tags.get(field)
        out[field] = val if val in vocab[field] else defaults[field]
    pal = tags.get("palette")
    out["palette"] = pal if pal in palettes else defaults["palette"]
    out["has_photo"] = bool(tags.get("has_photo", True))
    out["photo_role"] = tags.get("photo_role") if tags.get("photo_role") in (
        "full_bleed", "inset", "cutout_subject", "none") else "full_bleed"
    out["text_position"] = tags.get("text_position") if tags.get("text_position") in (
        "top", "center", "lower_third", "bottom") else "lower_third"
    return out


def main():
    lang = load_language()
    api_key = os.environ.get("GROQ_API_KEY")

    existing = {}
    if os.path.exists(TAGS_PATH):
        with open(TAGS_PATH, encoding="utf-8") as f:
            existing = {r["file"]: r for r in json.load(f)}

    if not api_key:
        print("No GROQ_API_KEY set -- leaving existing tags untouched.")
        print(f"{len(existing)} references currently tagged.")
        return

    files = sorted(f for f in os.listdir(REFS_DIR) if f.lower().endswith((".jpg", ".jpeg", ".png")))
    results = []
    for i, fname in enumerate(files, 1):
        path = os.path.join(REFS_DIR, fname)
        try:
            tags = validate(tag_one(path, lang, api_key), lang)
            tags["source"] = "vision_model"
            print(f"[{i}/{len(files)}] {fname} -> {tags['occasion']}/{tags['mood']}/{tags['palette']}")
        except Exception as e:
            # Keep whatever we already had rather than losing it on one failure.
            prev = existing.get(fname, {})
            tags = {k: v for k, v in prev.items() if k != "file"} or lang["defaults"].copy()
            tags["source"] = prev.get("source", "default_fallback")
            print(f"[{i}/{len(files)}] {fname} -> FAILED ({e}); kept previous tags")
        tags["file"] = fname
        results.append(tags)

    with open(TAGS_PATH, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\nWrote {TAGS_PATH} ({len(results)} references).")


if __name__ == "__main__":
    main()
