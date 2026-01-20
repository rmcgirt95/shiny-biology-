from __future__ import annotations

import os
import pathlib
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import boto3
import botocore
import pandas as pd
import hashlib
import re
import zipfile
import io
import asyncio
import traceback
from botocore.config import Config


from bs4 import BeautifulSoup

from shiny import App, reactive, render, ui

# Optional shinywidgets
try:
    from shinywidgets import output_widget, render_widget
    from shinywidgets import DataGrid

    HAS_SHINYWIDGETS = True
except Exception:
    HAS_SHINYWIDGETS = False


APP_TITLE = "RNA-Seq S3 Browser (Shiny for Python)"
DEFAULT_REGION = os.environ.get("AWS_REGION", "us-east-1")
DEFAULT_BUCKET = os.environ.get("RNASEQ_S3_BUCKET", "rnaseqdatabase")
BASE_PREFIX = os.environ.get("RNASEQ_BASE_PREFIX", "vendor-data/")
MAX_LIST_OBJECTS = int(os.environ.get("RNASEQ_MAX_LIST_OBJECTS", "5000"))

SUBFOLDER_CHOICES = {
    "(project root)": "(project root)",  # label and value same for now
    "Fastq/": "Fastq/",
    "FastQC/": "FastQC/",
    "QC/": "QC/",
    "Salmon_Quant/": "Salmon_Quant/",
    "DESeq2/": "DESeq2/",
}


# Where Shiny serves static files from
# Static files are served from ./www in Shiny for Python
APP_DIR = pathlib.Path(__file__).resolve().parent
WWW_DIR = APP_DIR / "www"
WWW_DOWNLOADS_DIR = WWW_DIR / "downloads"
WWW_DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)


FASTQC_PREVIEW_BASE_URL = "/downloads"

# Optional: keep local downloads too
DOWNLOAD_DIR = pathlib.Path("./downloads").resolve()
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


# ----------------- helpers -----------------

def _make_s3(region: str):
    cfg = Config(
        region_name=region,
        connect_timeout=5,
        read_timeout=30,
        retries={"max_attempts": 3, "mode": "standard"},
    )
    return boto3.session.Session().client("s3", config=cfg)


def _fastqc_local_name_for_key(key: str) -> str:
    # stable unique name per S3 key
    h = hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]
    return f"fastqc_{h}.html"
def _filter_df_for_view(dff: pd.DataFrame, subfolder: str) -> pd.DataFrame:
    if dff.empty:
        return dff

    sf = (subfolder or "").strip()
    if sf == "FastQC/":
        return dff[dff["key"].astype(str).str.lower().str.endswith(".html")].reset_index(drop=True)

    return dff


def _human_size(n: Optional[int]) -> str:
    if n is None:
        return ""
    nn = float(n)
    for unit in ["B", "KB", "MB", "GB", "TB"]:
        if nn < 1024:
            return f"{nn:.2f} {unit}" if unit != "B" else f"{int(nn)} B"
        nn /= 1024
    return f"{nn:.2f} PB"


def _dt(dt: Optional[datetime]) -> str:
    if not dt:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")


def _normalize_prefix(p: str) -> str:
    p = (p or "").strip().lstrip("/")
    return p if (not p or p.endswith("/")) else p + "/"


def _presign(s3, bucket: str, key: str, exp: int = 3600) -> str:
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": bucket, "Key": key},
        ExpiresIn=exp,
    )
def _safe_dir_name_from_key(key: str) -> str:
    # stable folder name per S3 key (prevents collisions)
    h = hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]
    return f"fastqc_zip_{h}"


def _extract_fastqc_zip_from_s3_to_www(s3, bucket: str, zip_key: str) -> str:
    """
    Downloads a FastQC zip from S3 and extracts it into:
      www/downloads/<unique_folder>/

    Returns the local URL to the extracted HTML report, e.g.:
      /downloads/fastqc_zip_<hash>/.../fastqc_report.html
    """
    # 1) Download zip bytes
    obj = s3.get_object(Bucket=bucket, Key=zip_key)
    zip_bytes = obj["Body"].read()

    # 2) Extract into a unique folder under www/downloads
    folder_name = _safe_dir_name_from_key(zip_key)
    out_dir = (WWW_DOWNLOADS_DIR / folder_name)
    out_dir.mkdir(parents=True, exist_ok=True)

    # 3) Extract (with zip-slip protection)
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        for member in z.infolist():
            # normalize and prevent zip-slip
            member_path = member.filename.replace("\\", "/")
            if member_path.startswith("/") or ".." in member_path.split("/"):
                # skip suspicious entries
                continue

            dest_path = (out_dir / member_path).resolve()
            if not str(dest_path).startswith(str(out_dir.resolve())):
                continue

            if member.is_dir():
                dest_path.mkdir(parents=True, exist_ok=True)
            else:
                dest_path.parent.mkdir(parents=True, exist_ok=True)
                with z.open(member) as src, open(dest_path, "wb") as dst:
                    dst.write(src.read())

    # 4) Find the FastQC html report inside extracted contents
    # FastQC typically uses: <sample>_fastqc/fastqc_report.html
    html_candidates = list(out_dir.rglob("fastqc_report.html"))

    # Some pipelines may store an alternate name; if needed, broaden search
    if not html_candidates:
        html_candidates = list(out_dir.rglob("*.html"))

    if not html_candidates:
        raise RuntimeError("Zip extracted but no HTML report was found inside.")

    # Prefer the canonical fastqc_report.html if present
    html_path = html_candidates[0].resolve()

    # 5) Build a local URL relative to WWW_DIR (served by Shiny static assets)
    rel = html_path.relative_to(WWW_DIR).as_posix()
    return "/" + rel


def _rewrite_fastqc_html(s3, bucket: str, html_key: str, html: str) -> str:
    """
    FastQC HTML references Images/* and Icons/* relative paths.
    Rewrite references to presigned S3 URLs so plots + icons load correctly.
    Handles <img>, <a>, <link>, <script>, and CSS url(...) inside <style>.
    """
    base = html_key.rsplit("/", 1)[0] + "/"
    soup = BeautifulSoup(html, "html.parser")

    def _maybe_presign(val: str) -> str:
        if not val:
            return val
        # normalize
        val = val.strip()
        # cover typical fastqc references
        if val.startswith(("Images/", "Icons/")):
            return _presign(s3, bucket, base + val)
        return val

    # Rewrite common tag attrs
    for tag in soup.find_all(["img", "a", "link", "script"]):
        if tag.name == "img":
            tag["src"] = _maybe_presign(tag.get("src", "") or "")
        elif tag.name == "a":
            tag["href"] = _maybe_presign(tag.get("href", "") or "")
        elif tag.name == "link":
            tag["href"] = _maybe_presign(tag.get("href", "") or "")
        elif tag.name == "script":
            src = tag.get("src", "") or ""
            if src:
                tag["src"] = _maybe_presign(src)

    # Rewrite CSS url(Images/...) inside <style> blocks
    for style in soup.find_all("style"):
        css = style.string or ""
        if not css:
            continue

        def _css_repl(m):
            path = m.group(2) + m.group(3)  # Images/ + filename OR Icons/ + filename
            url = _presign(s3, bucket, base + path)
            return f'url("{url}")'

        css = re.sub(
            r'url\((["\']?)(Images/|Icons/)([^"\')]+)\1\)',
            _css_repl,
            css,
        )
        style.string = css

    return str(soup)



def _list_projects(s3, bucket: str) -> List[str]:
    r = s3.list_objects_v2(Bucket=bucket, Prefix=BASE_PREFIX, Delimiter="/")
    return sorted(p["Prefix"].split("/")[-2] for p in r.get("CommonPrefixes", []))


def _list_objects(s3, bucket: str, prefix: str, limit: int = MAX_LIST_OBJECTS) -> pd.DataFrame:
    rows: List[Dict[str, Any]] = []
    token: Optional[str] = None

    while True:
        args: Dict[str, Any] = dict(Bucket=bucket, Prefix=prefix, MaxKeys=1000)
        if token:
            args["ContinuationToken"] = token

        r = s3.list_objects_v2(**args)

        for o in r.get("Contents", []) or []:
            rows.append(
                {
                    "key": o.get("Key", ""),
                    "size": _human_size(o.get("Size")),
                    "last_modified": _dt(o.get("LastModified")),
                    "storage_class": o.get("StorageClass", ""),
                }
            )
            if limit and len(rows) >= limit:
                # Stop early to prevent "infinite" listing on huge prefixes
                token = None
                r["IsTruncated"] = False
                break

        if not r.get("IsTruncated"):
            break
        token = r.get("NextContinuationToken")

    df = pd.DataFrame(rows)
    if not df.empty:
        df = df.sort_values(["last_modified", "key"], ascending=[False, True]).reset_index(drop=True)
    return df



# ----------------- UI -----------------

app_ui = ui.page_fluid(
    ui.h2(APP_TITLE),

    # JS handler to open FastQC HTML in a new tab
    ui.tags.script(
        """
        (function () {
          if (window.__fastqcOpenHandlerInstalled) return;
          window.__fastqcOpenHandlerInstalled = true;

          Shiny.addCustomMessageHandler("open_fastqc", function (payload) {
            try {
              const url = (payload && payload.url) ? payload.url : "";
              if (!url) {
                alert("No URL provided.");
                return;
              }
              const w = window.open(url, "_blank", "noopener,noreferrer");
              if (!w) {
                alert("Popup blocked. Please allow popups for this site.");
              }
            } catch (e) {
              alert("Failed to open FastQC report: " + e);
            }
          });
        })();
        """
    ),

        ui.layout_sidebar(
        ui.sidebar(
            ui.input_text("region", "AWS Region", value=DEFAULT_REGION),
            ui.input_text("bucket", "Bucket", value=DEFAULT_BUCKET),
            ui.input_radio_buttons(
                "view_mode",
                "View",
                {"samples": "Samples (recommended)", "files": "Raw files"},
                selected="samples",
            ),

            ui.input_numeric("sample_idx", "Select sample row #", value=0, min=0, step=1),
            ui.input_action_button("pick_sample_btn", "Select sample", class_="btn-outline-primary"),

            ui.input_action_button("refresh", "Refresh projects", class_="btn-primary"),
            ui.output_ui("project_ui"),
            ui.output_ui("sample_selected"),
            ui.input_action_button("open_log", "Open Salmon log", class_="btn-outline-secondary"),
            ui.input_action_button("open_meta", "Open meta_info.json", class_="btn-outline-secondary"),
            ui.input_action_button("download_quant", "Download quant.sf", class_="btn-outline-secondary"),

            ui.input_select("subfolder", "Subfolder", SUBFOLDER_CHOICES),

            ui.input_action_button("list", "List objects", class_="btn-success"),

            ui.hr(),

            # ✅ Usability features
            ui.input_text("filter", "Filter (contains in key)", value=""),
            ui.input_checkbox("auto_list", "Auto-list when Project/Subfolder changes", value=False),

            ui.hr(),

            ui.input_checkbox("auto_refresh", "Auto-refresh list", value=False),
            ui.input_numeric("auto_refresh_sec", "Refresh interval (sec)", value=30, min=5, step=5),

            ui.hr(),

            ui.output_ui("status"),
            ui.hr(),
            ui.output_ui("selected"),

            # ✅ Fallback selection that always works (even if grid click selection doesn't)
            ui.input_numeric("row_idx", "Select row #", value=0, min=0, step=1),
            ui.input_action_button("pick_btn", "Select row", class_="btn-outline-primary"),

            ui.input_action_button("preview", "Preview (text)", class_="btn-secondary"),
            ui.input_action_button("view_fastqc", "View FastQC (new tab)", class_="btn-info"),
            ui.input_action_button("download", "Download", class_="btn-secondary"),
            width=380,
        ),
        ui.div(
            ui.h4("Objects"),
            ui.output_ui("table"),
            ui.hr(),
            ui.h4("Preview"),
            ui.output_ui("preview_html"),
            ui.output_text_verbatim("preview_text"),
        ),
    ),
)


# ----------------- Server -----------------

def server(input, output, session):
    s3 = reactive.Value(None)
    projects = reactive.Value([])
    df = reactive.Value(pd.DataFrame())
    selected_key = reactive.Value(None)
    fastqc_preview_url = reactive.Value("")
    selected_sample = reactive.Value("")

    preview_state = reactive.Value("")
    status_state = reactive.Value("Ready.")
    is_loading_objects = reactive.Value(False)
    selected_project_pref = reactive.Value("")

    def _get_project_value() -> str:
        try:
            return input.project()
        except Exception:
            return ""

    @reactive.Effect
    def _init_s3():
        _ = input.region()
        s3.set(_make_s3(input.region()))

    # ---------------------------
    # Thread workers (NO reactive.set inside these)
    # ---------------------------
    def _load_projects_work() -> List[str]:
        return _list_projects(s3.get(), input.bucket())

    def _load_objects_work(proj: str, subfolder: str) -> pd.DataFrame:
        sf = "" if subfolder == "(project root)" else (subfolder or "")
        prefix = _normalize_prefix(f"{BASE_PREFIX}{proj}/{sf}")


        print("[LIST]", input.bucket(), prefix)

        new_df = _list_objects(
            s3.get(),
            input.bucket(),
            prefix,
            limit=MAX_LIST_OBJECTS,   # keep the limit
        )
        return _filter_df_for_view(new_df, subfolder)

    # ---------------------------
    # Async loaders (reactive.set ONLY here)
    # ---------------------------
    async def _load_projects_async():
        try:
            plist = await asyncio.to_thread(_load_projects_work)
            projects.set(plist)

            if plist:
                pref = selected_project_pref.get()
                if not pref or pref not in plist:
                    selected_project_pref.set(plist[0])

            status_state.set("Projects loaded.")
        except botocore.exceptions.ClientError as e:
            code = e.response.get("Error", {}).get("Code", "ClientError")
            msg = e.response.get("Error", {}).get("Message", str(e))
            projects.set([])
            status_state.set(f"AWS error loading projects: {code} — {msg}")
        except Exception as e:
            print("[ERROR] load_projects_async:", repr(e))
            traceback.print_exc()
            projects.set([])
            status_state.set(f"Failed to load projects: {e}")


    async def _load_objects_async():
        if s3.get() is None:
            status_state.set("S3 client not ready yet. Try again in a second.")
            return

        proj = _get_project_value()

        if not proj:
            status_state.set("Select a project first.")
            df.set(pd.DataFrame())
            selected_key.set(None)
            return

        if is_loading_objects.get():
            return

        is_loading_objects.set(True)
        try:
            prefix = _normalize_prefix(f"{BASE_PREFIX}{proj}/{input.subfolder()}")
            status_state.set(f"Listing up to {MAX_LIST_OBJECTS} objects in: {prefix}")
            new_df = await asyncio.to_thread(_load_objects_work, proj, input.subfolder())
            df.set(new_df)

            if not new_df.empty:
                selected_key.set(new_df.iloc[0]["key"])
                status_state.set(f"{len(new_df)} objects found. Auto-selected row 0.")
            else:
                selected_key.set(None)
                status_state.set("0 objects found.")

            preview_state.set("")
            fastqc_preview_url.set("")
        except botocore.exceptions.ClientError as e:
            code = e.response.get("Error", {}).get("Code", "ClientError")
            msg = e.response.get("Error", {}).get("Message", str(e))
            df.set(pd.DataFrame())
            selected_key.set(None)
            status_state.set(f"AWS error listing objects: {code} — {msg}")
        except Exception as e:
            print("[ERROR] load_objects_async:", repr(e))
            traceback.print_exc()
            df.set(pd.DataFrame())
            selected_key.set(None)
            status_state.set(f"Failed to list objects: {e}")

        finally:
            is_loading_objects.set(False)

    # ---------------------------
    # Samples table
    # ---------------------------
    @reactive.Calc
    def samples_df() -> pd.DataFrame:
        dff = df.get()
        if dff.empty:
            return pd.DataFrame()

        keys = dff["key"].astype(str)
        mask = keys.str.contains("/Salmon_Quant/")
        dff = dff[mask].copy()
        if dff.empty:
            return pd.DataFrame()

        keys = dff["key"].astype(str)

        sample_from_dir = keys.str.extract(r"/Salmon_Quant/([^/]+)/", expand=False)
        sample_from_done = keys.str.extract(r"/Salmon_Quant/([^/]+)\.done$", expand=False)
        dff["sample"] = sample_from_dir.fillna(sample_from_done).fillna("")

        low = keys.str.lower()
        dff["is_quant"] = low.str.endswith("/quant.sf")
        dff["is_genes"] = low.str.endswith("/quant.genes.sf")
        dff["is_log"] = low.str.endswith("/logs/salmon_quant.log")
        dff["is_meta"] = low.str.endswith("/aux_info/meta_info.json")
        dff["is_done"] = low.str.endswith(".done")

        g = dff.groupby("sample")

        out = pd.DataFrame(
            {
                "sample": g.size().index,
                "status": g["is_done"].any().values,
                "quant.sf": g["is_quant"].any().values,
                "quant.genes.sf": g["is_genes"].any().values,
                "log": g["is_log"].any().values,
                "meta": g["is_meta"].any().values,
                "files": g.size().values,
                "last_modified_latest": g["last_modified"].max().values,
            }
        )

        out["status"] = out["status"].map(lambda x: "✅ Complete" if x else "⚠️ Partial")
        return out.sort_values(["status", "sample"], ascending=[False, True]).reset_index(drop=True)

    # ---------------------------
    # Startup + buttons (NO duplicates)
    # ---------------------------
    @reactive.Effect
    async def _autoload_projects_on_start():
        _ = input.region()
        _ = input.bucket()
        await _load_projects_async()

    @reactive.Effect
    @reactive.event(input.refresh)
    async def _refresh_projects():
        await _load_projects_async()

    @reactive.Effect
    @reactive.event(input.list)
    async def _list_button():
        await _load_objects_async()

    @reactive.Effect
    async def _auto_list_on_change():
    # only run if user wants it
        if not input.auto_list():
            return

    # must have a real project selected
        proj = _get_project_value()
        if not proj:
            return

    # must have projects loaded
        if not projects.get():
            return

    # IMPORTANT: only trigger when inputs actually change
    # Use these reads to establish dependencies
        subfolder = input.subfolder()

    # remember selected project preference (doesn't trigger listing again)
        selected_project_pref.set(proj)

    # avoid overlapping list calls
        if is_loading_objects.get():
            return

        await _load_objects_async()



    @reactive.Effect
    async def _auto_refresh_timer():
        if not input.auto_refresh():
            return

        try:
            sec = int(input.auto_refresh_sec() or 30)
        except Exception:
            sec = 30

        sec = max(5, sec)
        reactive.invalidate_later(sec * 1000)

        proj = _get_project_value()
        if proj and projects.get():
            status_state.set(f"Auto-refreshing every {sec}s…")
            await _load_objects_async()

    # ---------------------------
    # Outputs
    # ---------------------------
    @output
    @render.ui
    def project_ui():
        opts = projects.get()
        if not opts:
            return ui.em("Loading projects… (or click 'Refresh projects')")

        pref = selected_project_pref.get()
        selected = pref if pref in opts else opts[0]
        return ui.input_select("project", "Project", opts, selected=selected)

    @output
    @render.ui
    def sample_selected():
        s = selected_sample.get()
        return ui.div(ui.strong("Sample:"), ui.code(s)) if s else ui.em("No sample selected")

    @reactive.Calc
    def df_filtered() -> pd.DataFrame:
        dff = df.get()
        if dff.empty:
            return dff

        needle = (input.filter() or "").strip().lower()
        if not needle:
            return dff

        mask = dff["key"].astype(str).str.lower().str.contains(needle, na=False)
        return dff[mask].reset_index(drop=True)

    @output
    @render.ui
    def table():
        dff = samples_df() if input.view_mode() == "samples" else df_filtered()
        if dff.empty:
            return ui.em("No objects")
        return ui.HTML(dff.to_html(index=True, escape=True))

    @reactive.Effect
    @reactive.event(input.pick_sample_btn)
    def _pick_sample():
        sdf = samples_df()
        if sdf.empty:
            status_state.set("No samples available. Click 'List objects' first.")
            return

        try:
            i = int(input.sample_idx() or 0)
        except Exception:
            status_state.set("Sample index must be a number.")
            return

        if i < 0 or i >= len(sdf):
            status_state.set(f"Sample row out of range. Use 0 to {len(sdf) - 1}.")
            return

        sample = str(sdf.iloc[i]["sample"])
        selected_sample.set(sample)

        full_df = df.get()
        keys = full_df["key"].astype(str)

        candidate = full_df[
            keys.str.contains(f"/Salmon_Quant/{re.escape(sample)}/")
            & keys.str.lower().str.endswith("/quant.sf")
        ]
        if not candidate.empty:
            selected_key.set(candidate.iloc[0]["key"])
            status_state.set(f"Selected sample '{sample}' and auto-selected quant.sf.")
            return

        any_file = full_df[keys.str.contains(f"/Salmon_Quant/{re.escape(sample)}/")]
        if not any_file.empty:
            selected_key.set(any_file.iloc[0]["key"])
            status_state.set(f"Selected sample '{sample}'.")
        else:
            status_state.set(f"Selected sample '{sample}', but no files were found.")

    @reactive.Effect
    @reactive.event(input.pick_btn)
    def _pick_row():
        dff = df_filtered()
        if dff.empty:
            status_state.set("No rows to pick. Click 'List objects' first.")
            return

        try:
            i = int(input.row_idx() or 0)
        except Exception:
            status_state.set("Row index must be a number.")
            return

        if i < 0 or i >= len(dff):
            status_state.set(f"Row out of range. Use 0 to {len(dff) - 1}.")
            return

        selected_key.set(dff.iloc[i]["key"])
        status_state.set(f"Selected row {i} (filtered view).")

    @output
    @render.ui
    def selected():
        return ui.code(selected_key.get()) if selected_key.get() else ui.em("None")

    @output
    @render.ui
    def status():
        return ui.div(status_state.get())





APP_DIR = pathlib.Path(__file__).resolve().parent
WWW_DIR = (APP_DIR / "www").resolve()
print(f"[BOOT] app.py={__file__}  WWW_DIR={WWW_DIR}")

app = App(
    app_ui,
    server,
    static_assets={
        "/": WWW_DIR,
        "/downloads": WWW_DOWNLOADS_DIR,  # serve www/downloads at /downloads
    },
)


