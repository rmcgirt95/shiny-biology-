import json
import re
from pathlib import Path

HELPDESK_DIR = Path(__file__).resolve().parent
MANIFESTS_DIR = HELPDESK_DIR / "manifests"

# Folders you want to crawl recursively (photos are usually nested)
RECURSIVE_FOLDERS = {
    "Group photo",
}

# File types to include
ALLOWED_EXTS = {
    ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx", ".csv",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".txt"
}

# Skip folders you don't want indexed
SKIP_DIRS = {
    "manifests", ".git", ".vscode", "__pycache__", "node_modules"
}

def slugify(name: str) -> str:
    s = (name or "").strip().lower()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_-]+", "-", s)
    s = s.strip("-")
    return s or "folder"

def nice_title_from_filename(filename: str) -> str:
    stem = Path(filename).stem
    stem = stem.replace("_", " ").replace("-", " ")
    stem = re.sub(r"\s+", " ", stem).strip()
    return stem

def list_files(folder: Path, recursive: bool) -> list[Path]:
    if recursive:
        return [p for p in folder.rglob("*") if p.is_file()]
    return [p for p in folder.iterdir() if p.is_file()]

def main():
    MANIFESTS_DIR.mkdir(parents=True, exist_ok=True)

    for entry in sorted(HELPDESK_DIR.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir():
            continue
        if entry.name in SKIP_DIRS:
            continue

        folder_name = entry.name
        recursive = folder_name in RECURSIVE_FOLDERS

        files = list_files(entry, recursive)

        items = []
        for f in sorted(files, key=lambda p: str(p).lower()):
            ext = f.suffix.lower()
            if ext not in ALLOWED_EXTS:
                continue

            rel = f.relative_to(entry).as_posix()  # supports nested paths
            items.append({
                "file": rel,
                "title": nice_title_from_filename(f.name),
                "tags": [],
                "notes": ""
            })

        out_file = MANIFESTS_DIR / f"{slugify(folder_name)}.json"
        out_file.write_text(json.dumps(items, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Wrote {out_file.name} ({len(items)} items)")

if __name__ == "__main__":
    main()
