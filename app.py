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

SUBFOLDER_CHOICES = {
    "(project root)": "",
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

FASTQC_PREVIEW_FILE = WWW_DOWNLOADS_DIR / "fastqc_preview.html"
FASTQC_PREVIEW_URL = "/downloads/fastqc_preview.html"
FASTQC_PREVIEW_BASE_URL = "/downloads"

# Optional: keep local downloads too
DOWNLOAD_DIR = pathlib.Path("./downloads").resolve()
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)


# ----------------- helpers -----------------

def _make_s3(region: str):
    return boto3.session.Session(region_name=region).client("s3")

def _fastqc_local_name_for_key(key: str) -> str:
    # stable unique name per S3 key
    h = hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]
    return f"fastqc_{h}.html"

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


def _list_objects(s3, bucket: str, prefix: str) -> pd.DataFrame:
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

            ui.input_action_button("refresh", "Refresh projects", class_="btn-primary"),
            ui.output_ui("project_ui"),

            ui.input_select("subfolder", "Subfolder", SUBFOLDER_CHOICES),

            ui.input_action_button("list", "List objects", class_="btn-success"),

            ui.hr(),

            # ✅ Usability features
            ui.input_text("filter", "Filter (contains in key)", value=""),
            ui.input_checkbox("auto_list", "Auto-list when Project/Subfolder changes", value=True),

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

    preview_state = reactive.Value("")
    status_state = reactive.Value("Ready.")
    is_loading_objects = reactive.Value(False)

    # Keep a preferred selection when project list changes
    selected_project_pref = reactive.Value("")

    def _get_project_value() -> str:
        try:
            # input.project exists only after project_ui renders at least once
            return input.project()
        except Exception:
            return ""

    def _load_projects_impl():
        try:
            plist = _list_projects(s3.get(), input.bucket())
            projects.set(plist)
            if plist:
                # If we previously had a preferred project, keep it if still available.
                pref = selected_project_pref.get()
                if pref and pref in plist:
                    pass
                else:
                    selected_project_pref.set(plist[0])
            status_state.set("Projects loaded.")
        except botocore.exceptions.ClientError as e:
            code = e.response.get("Error", {}).get("Code", "ClientError")
            msg = e.response.get("Error", {}).get("Message", str(e))
            status_state.set(f"AWS error loading projects: {code} — {msg}")
            projects.set([])
        except Exception as e:
            status_state.set(f"Failed to load projects: {e}")
            projects.set([])

    def _load_objects_impl():
    # prevent overlapping refresh/list calls
    if is_loading_objects.get():
        return

    is_loading_objects.set(True)
    try:
        proj = _get_project_value()
        prefix = _normalize_prefix(f"{BASE_PREFIX}{proj}/{input.subfolder()}")
        new_df = _list_objects(s3.get(), input.bucket(), prefix)
        df.set(new_df)

        if not new_df.empty:
            selected_key.set(new_df.iloc[0]["key"])
            status_state.set(f"{len(new_df)} objects found. Auto-selected row 0.")
        else:
            selected_key.set(None)
            status_state.set("0 objects found.")

        # Clear preview states on new list
        preview_state.set("")
        fastqc_preview_url.set("")

    except botocore.exceptions.ClientError as e:
        code = e.response.get("Error", {}).get("Code", "ClientError")
        msg = e.response.get("Error", {}).get("Message", str(e))
        status_state.set(f"AWS error listing objects: {code} — {msg}")
        df.set(pd.DataFrame())
        selected_key.set(None)
        preview_state.set("")
        fastqc_preview_url.set("")
    except Exception as e:
        status_state.set(f"Failed to list objects: {e}")
        df.set(pd.DataFrame())
        selected_key.set(None)
        preview_state.set("")
        fastqc_preview_url.set("")
    finally:
        is_loading_objects.set(False)


    @reactive.Effect
    def _init():
        # Re-init S3 client when region changes
        s3.set(_make_s3(input.region()))

    # ✅ Auto-load projects on initial page load and whenever bucket/region changes
    @reactive.Effect
    def _autoload_projects_on_start():
        # If region/bucket changes, reload project list
        _ = input.region()
        _ = input.bucket()
        _load_projects_impl()

    # Manual refresh button
    @reactive.Effect
    @reactive.event(input.refresh)
    def _load_projects_button():
        _load_projects_impl()

    @output
    @render.ui
    def project_ui():
        opts = projects.get()
        if not opts:
            return ui.em("Loading projects… (or click 'Refresh projects')")

        # Prefer stored choice if possible
        pref = selected_project_pref.get()
        selected = pref if pref in opts else opts[0]

        return ui.input_select("project", "Project", opts, selected=selected)

    # ✅ Filtered view of df (search)
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

    # Manual list button
    @reactive.Effect
    @reactive.event(input.list)
    def _list_button():
        _load_objects_impl()

    # ✅ Auto-list when project/subfolder changes (if enabled)
    @reactive.Effect
    def _auto_list_on_change():
        if not input.auto_list():
            return

        # depend on inputs
        _ = input.subfolder()
        proj = _get_project_value()

        # store preferred selection
        if proj:
            selected_project_pref.set(proj)

        # Only run if we have a project and projects loaded
        if proj and projects.get():
            _load_objects_impl()

    # ✅ Auto-refresh timer (if enabled)
    @reactive.Effect
    def _auto_refresh_timer():
        if not input.auto_refresh():
            return

        try:
            sec = int(input.auto_refresh_sec() or 30)
        except Exception:
            sec = 30

        sec = max(5, sec)

        # schedule next tick
        reactive.invalidate_later(sec * 1000)

        proj = _get_project_value()
        if proj and projects.get():
            status_state.set(f"Auto-refreshing every {sec}s…")
            _load_objects_impl()

    @output
    @render.ui
    def table():
        dff = df_filtered()
        if dff.empty:
            return ui.em("No objects")

        if HAS_SHINYWIDGETS:
            return output_widget("grid")

        # fallback table
        return ui.HTML(dff.to_html(index=True, escape=True))

    # Only define the grid + selection logic if shinywidgets is available
    if HAS_SHINYWIDGETS:

        @output
        @render_widget
        def grid():
            return DataGrid(df_filtered(), selection_mode="row", height="420px", width="100%")

        @reactive.Effect
        def _select():
            rows = input.grid_selected_rows()
            if rows:
                try:
                    # selection indexes correspond to the filtered df
                    dff = df_filtered()
                    selected_key.set(dff.iloc[rows[0]]["key"])
                    status_state.set(f"Selected row {rows[0]} (filtered view).")
                except Exception:
                    selected_key.set(None)

    # ✅ Always-works row picker
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

    @reactive.Effect
    @reactive.event(input.view_fastqc)
    async def _view_fastqc():
        key = selected_key.get()
        if not key:
            status_state.set("Select a FastQC .html file first.")
            return

        if not key.lower().endswith(".html"):
            status_state.set("View FastQC only works for the .html report. Select a .html row.")
            return

        try:
            obj = s3.get().get_object(Bucket=input.bucket(), Key=key)
            html = obj["Body"].read().decode("utf-8", errors="replace")
            html = _rewrite_fastqc_html(s3.get(), input.bucket(), key, html)

            # ✅ Write to www so it can be opened directly in new tab AND embedded in iframe
           fname = _fastqc_local_name_for_key(key)
            local_file = WWW_DOWNLOADS_DIR / fname
            local_url = f"{FASTQC_PREVIEW_BASE_URL}/{fname}"

            local_file.write_text(html, encoding="utf-8", errors="ignore")

# store URL so iframe can show the same report
            fastqc_preview_url.set(local_url)

# optional: keep in state too (not required anymore)
            preview_state.set(html)

            status_state.set(
                f"Wrote FastQC preview: {local_file.name} "
                f"(size={local_file.stat().st_size if local_file.exists() else 'NA'} bytes)"
            )

            await session.send_custom_message("open_fastqc", {"url": local_url})
            status_state.set("Opened FastQC in a new tab.")

        except botocore.exceptions.ClientError as e:
            code = e.response.get("Error", {}).get("Code", "ClientError")
            msg = e.response.get("Error", {}).get("Message", str(e))
            status_state.set(f"AWS error opening FastQC: {code} — {msg}")
        except Exception as e:
            status_state.set(f"Failed to open FastQC: {e}")

    @reactive.Effect
    @reactive.event(input.preview)
    def _preview_text():
        key = selected_key.get()
        if not key:
            status_state.set("Select a row first.")
            return

        # Simple preview for small text-like files
        try:
            # You can expand this list as needed
            ok_ext = (".txt", ".tsv", ".csv", ".log", ".json", ".md", ".html")
            if not key.lower().endswith(ok_ext):
                status_state.set("Preview supports text-like files (.txt/.csv/.log/.json/.html etc).")
                return

            obj = s3.get().get_object(Bucket=input.bucket(), Key=key)
            raw = obj["Body"].read()

            # Avoid massive previews
            max_bytes = 300_000
            if len(raw) > max_bytes:
                raw = raw[:max_bytes]
                status_state.set(f"Preview truncated to first {max_bytes} bytes.")
            else:
                status_state.set("Preview loaded.")

            txt = raw.decode("utf-8", errors="replace")
            preview_state.set(txt)
        except botocore.exceptions.ClientError as e:
            code = e.response.get("Error", {}).get("Code", "ClientError")
            msg = e.response.get("Error", {}).get("Message", str(e))
            status_state.set(f"AWS error previewing: {code} — {msg}")
        except Exception as e:
            status_state.set(f"Failed to preview: {e}")

    @output
    @render.ui
    def preview_html():
    # Only iframe the last generated FastQC preview URL
        url = fastqc_preview_url.get()
        if url:
            return ui.tags.iframe(
                src=url,
                style="width:100%; height:600px; border:1px solid #ccc;",
            )
        return None


    @output
    @render.text
    def preview_text():
        key = selected_key.get()
        if key and key.lower().endswith(".html"):
            return ""
        return preview_state.get()

    @reactive.Effect
    @reactive.event(input.download)
    def _download():
        key = selected_key.get()
        if not key:
            status_state.set("Select a row first.")
            return

        try:
            path = DOWNLOAD_DIR / key.replace("/", "__")
            s3.get().download_file(input.bucket(), key, str(path))
            status_state.set(f"Downloaded to {path}")
        except botocore.exceptions.ClientError as e:
            code = e.response.get("Error", {}).get("Code", "ClientError")
            msg = e.response.get("Error", {}).get("Message", str(e))
            status_state.set(f"AWS error downloading: {code} — {msg}")
        except Exception as e:
            status_state.set(f"Failed to download: {e}")

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
    static_assets={"/": WWW_DIR},
)
