from __future__ import annotations

import os
import pathlib
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import boto3
import botocore
import pandas as pd
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


# Optional: keep local downloads too
DOWNLOAD_DIR = pathlib.Path("./downloads").resolve()
DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)





# ----------------- helpers -----------------

def _make_s3(region: str):
    return boto3.session.Session(region_name=region).client("s3")


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
    If we render via iframe/srcdoc or open via data: URL, those relative assets break.
    This rewrites them to presigned S3 URLs so plots + icons load correctly.
    """
    base = html_key.rsplit("/", 1)[0] + "/"
    soup = BeautifulSoup(html, "html.parser")

    # Rewrite Images/ and Icons/ in <img src="..."> and <a href="...">
    for tag in soup.find_all(["img", "a"]):
        attr = "src" if tag.name == "img" else "href"
        val = tag.get(attr, "") or ""
        if val.startswith(("Images/", "Icons/")):
            tag[attr] = _presign(s3, bucket, base + val)

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
            ui.output_ui("status"),
            ui.hr(),
            ui.output_ui("selected"),

            # ✅ Fallback selection that always works (even if grid click selection doesn't)
            ui.input_numeric("row_idx", "Select row #", value=0, min=0, step=1),
            ui.input_action_button("pick_btn", "Select row", class_="btn-outline-primary"),

            ui.input_action_button("preview", "Preview"),
            ui.input_action_button("view_fastqc", "View FastQC (new tab)", class_="btn-info"),
            ui.input_action_button("download", "Download"),
            width=360,
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
    preview_state = reactive.Value("")        # avoids name conflict with output
    status_state = reactive.Value("Ready.")   # avoids name conflict with output

    @reactive.Effect
    def _init():
        # Re-init S3 client when region changes
        s3.set(_make_s3(input.region()))

    @reactive.Effect
    @reactive.event(input.refresh)
    def _load_projects():
        try:
            projects.set(_list_projects(s3.get(), input.bucket()))
            status_state.set("Projects loaded.")
        except botocore.exceptions.ClientError as e:
            code = e.response.get("Error", {}).get("Code", "ClientError")
            msg = e.response.get("Error", {}).get("Message", str(e))
            status_state.set(f"AWS error loading projects: {code} — {msg}")
            projects.set([])
        except Exception as e:
            status_state.set(f"Failed to load projects: {e}")
            projects.set([])

    @output
    @render.ui
    def project_ui():
        opts = projects.get()
        if not opts:
            return ui.em("Click 'Refresh projects' to load.")
        return ui.input_select("project", "Project", opts, selected=opts[0])

    @reactive.Effect
    @reactive.event(input.list)
    def _load_objects():
        try:
            proj = input.project() if "project" in dir(input) else ""
            prefix = _normalize_prefix(f"{BASE_PREFIX}{proj}/{input.subfolder()}")
            df.set(_list_objects(s3.get(), input.bucket(), prefix))
            status_state.set(f"{len(df.get())} objects found.")
            selected_key.set(None)
            preview_state.set("")
        except botocore.exceptions.ClientError as e:
            code = e.response.get("Error", {}).get("Code", "ClientError")
            msg = e.response.get("Error", {}).get("Message", str(e))
            status_state.set(f"AWS error listing objects: {code} — {msg}")
            df.set(pd.DataFrame())
            selected_key.set(None)
            preview_state.set("")
        except Exception as e:
            status_state.set(f"Failed to list objects: {e}")
            df.set(pd.DataFrame())
            selected_key.set(None)
            preview_state.set("")

    @output
    @render.ui
    def table():
        dff = df.get()
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
            return DataGrid(df.get(), selection_mode="row", height="420px", width="100%")

        @reactive.Effect
        def _select():
            # If this works in your environment, great. If not, use the Pick Row controls.
            rows = input.grid_selected_rows()
            if rows:
                try:
                    selected_key.set(df.get().iloc[rows[0]]["key"])
                    status_state.set(f"Selected row {rows[0]}.")
                except Exception:
                    selected_key.set(None)

    # ✅ Always-works row picker
    @reactive.Effect
    @reactive.event(input.pick_btn)
    def _pick_row():
        dff = df.get()
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
        status_state.set(f"Selected row {i}.")

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

            FASTQC_PREVIEW_FILE.write_text(html, encoding="utf-8", errors="ignore")

            status_state.set(
                f"Wrote preview: exists={FASTQC_PREVIEW_FILE.exists()} "
                f"size={FASTQC_PREVIEW_FILE.stat().st_size if FASTQC_PREVIEW_FILE.exists() else 'NA'} "
                f"path={FASTQC_PREVIEW_FILE}"
            )

            await session.send_custom_message("open_fastqc", {"url": FASTQC_PREVIEW_URL})

            status_state.set("Opened FastQC in a new tab.")


            status_state.set("Opened FastQC in a new tab.")
        except botocore.exceptions.ClientError as e:
            code = e.response.get("Error", {}).get("Code", "ClientError")
            msg = e.response.get("Error", {}).get("Message", str(e))
            status_state.set(f"AWS error opening FastQC: {code} — {msg}")
        except Exception as e:
            status_state.set(f"Failed to open FastQC: {e}")

    @output
    @render.ui
    def preview_html():
        key = selected_key.get()
        if key and key.lower().endswith(".html"):
            return ui.tags.iframe(
                srcdoc=preview_state.get(),
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


