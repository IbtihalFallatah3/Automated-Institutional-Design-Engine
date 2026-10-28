import json
import os
import shutil
import uuid

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse

from pipeline import generate, critique, diagnose, load_language

BASE = os.path.dirname(__file__)
FRONTEND = os.path.join(BASE, "..", "frontend")
UPLOADS = os.path.join(BASE, "assets", "uploads")
LOGOS = os.path.join(BASE, "assets", "logos")
REFS = os.path.join(BASE, "references")

app = FastAPI(title="Madinah Poster v14")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.mount("/uploads", StaticFiles(directory=UPLOADS), name="uploads")
app.mount("/logos", StaticFiles(directory=LOGOS), name="logos")
app.mount("/refs", StaticFiles(directory=REFS), name="refs")
app.mount("/static", StaticFiles(directory=FRONTEND), name="static")

KEY = lambda k=None: k or os.environ.get("GROQ_API_KEY")


@app.get("/")
def index():
    return FileResponse(os.path.join(FRONTEND, "index.html"))


@app.get("/api/design-language")
def design_language():
    return JSONResponse(load_language())


@app.get("/api/diagnose")
def api_diagnose():
    return JSONResponse(diagnose())


@app.get("/api/logos")
def logos():
    mpath = os.path.join(LOGOS, "manifest.json")
    if os.path.exists(mpath):
        with open(mpath, encoding="utf-8") as f:
            manifest = json.load(f)
        for org in manifest:
            org["variant_urls"] = {k: f"/logos/{v}" for k, v in org["variants"].items()}
        return JSONResponse(manifest)
    return JSONResponse([])


@app.post("/api/generate")
def api_generate(topic: str = Form(...), photo_url: str = Form(None), api_key: str = Form(None)):
    """Stage 1+2: vision reads the photo, then the model authors the layout spec."""
    path = None
    if photo_url and photo_url.startswith("/uploads/"):
        cand = os.path.join(UPLOADS, os.path.basename(photo_url))
        if os.path.exists(cand):
            path = cand
    return JSONResponse(generate(topic, photo_path=path, api_key=KEY(api_key)))


@app.post("/api/critique")
def api_critique(image_b64: str = Form(...), api_key: str = Form(None)):
    """Stage 3: vision looks at the RENDERED poster and returns adjustments."""
    key = KEY(api_key)
    if not key:
        return JSONResponse({"verdict": "skipped", "issues": ["no API key"], "adjust": {}})
    b64 = image_b64.split(",", 1)[-1]
    try:
        return JSONResponse(critique(b64, key))
    except Exception as e:
        return JSONResponse({"verdict": "error", "issues": [str(e)[:200]], "adjust": {}})


@app.post("/api/upload")
def upload(file: UploadFile = File(...)):
    ext = os.path.splitext(file.filename)[1].lower() or ".jpg"
    name = f"{uuid.uuid4().hex}{ext}"
    with open(os.path.join(UPLOADS, name), "wb") as out:
        shutil.copyfileobj(file.file, out)
    return JSONResponse({"url": f"/uploads/{name}"})
