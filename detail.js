let dropboxRefreshToken = null;
let formHasUnsavedChanges = false;
let systemSwipeBlocker = null;
let globalSwipeEnabled = true;
let updatedFields = {};

// --- Original Subcontractor (linked record) support ---

// --- Original Subcontractor (linked record) support ---
function normalizePhoneForTel(phoneRaw) {
  if (!phoneRaw) return "";
  return String(phoneRaw).replace(/[^\d+]/g, "");
}

function getLinkedIdsFromField(fieldValue) {
  if (Array.isArray(fieldValue) && fieldValue.length > 0) return fieldValue;
  if (typeof fieldValue === "string" && fieldValue.trim() !== "") return [fieldValue.trim()];
  return [];
}

async function fetchSubcontractorById(recId) {
  const baseId = window.env?.AIRTABLE_BASE_ID;
  const table = window.env?.AIRTABLE_SUBCONTRACTOR_TABLE_NAME; // 'tbl9SgC5wUi2TQuF7'
  const apiKey = window.env?.AIRTABLE_API_KEY;
  if (!baseId || !table || !apiKey || !recId) return null;

  const url = `https://api.airtable.com/v0/${baseId}/${table}/${recId}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.fields || null;
}

async function fetchSubcontractorByName(name) {
  const baseId = window.env?.AIRTABLE_BASE_ID;
  const table = window.env?.AIRTABLE_SUBCONTRACTOR_TABLE_NAME;
  const apiKey = window.env?.AIRTABLE_API_KEY;
  if (!baseId || !table || !apiKey || !name) return null;

  const formula = `LOWER({Subcontractor Company Name}) = '${String(name).toLowerCase().replace(/'/g, "\\'")}'`;
  const url = `https://api.airtable.com/v0/${baseId}/${table}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.records?.[0]?.fields || null;
}

async function setOriginalSubcontractorFromLinked(fields) {
  const target = document.getElementById("original-subcontractor");
  if (!target || !fields) return;

  function normalizePhoneForTel(phoneRaw) {
    if (!phoneRaw) return "";
    return String(phoneRaw).replace(/[^\d+]/g, "");
  }
  function getLinkedIdsFromField(fieldValue) {
    if (Array.isArray(fieldValue) && fieldValue.length > 0) return fieldValue;
    if (typeof fieldValue === "string" && fieldValue.trim() !== "") return [fieldValue.trim()];
    return [];
  }
  async function fetchSubcontractorById(recId) {
    const baseId = window.env?.AIRTABLE_BASE_ID;
    const table = window.env?.AIRTABLE_SUBCONTRACTOR_TABLE_NAME; // 'tbl9SgC5wUi2TQuF7'
    const apiKey = window.env?.AIRTABLE_API_KEY;
    if (!baseId || !table || !apiKey || !recId) return null;
    const url = `https://api.airtable.com/v0/${baseId}/${table}/${recId}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.fields || null;
  }
  async function fetchSubcontractorByName(name) {
    const baseId = window.env?.AIRTABLE_BASE_ID;
    const table = window.env?.AIRTABLE_SUBCONTRACTOR_TABLE_NAME;
    const apiKey = window.env?.AIRTABLE_API_KEY;
    if (!baseId || !table || !apiKey || !name) return null;
    const formula = `LOWER({Subcontractor Company Name}) = '${String(name).toLowerCase().replace(/'/g, "\\'")}'`;
    const url = `https://api.airtable.com/v0/${baseId}/${table}?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) return null;
    const data = await res.json();
    return data?.records?.[0]?.fields || null;
  }

  const linkedValue =
    fields["Original Subcontractor"] ??
    fields["Subcontractor (Original)"] ??
    fields["Original Sub"] ??
    fields["Subcontractor"];

  let displayName = "";
  let phoneNumber = "";

  const linkedIds = getLinkedIdsFromField(linkedValue);
  if (linkedIds.length > 0) {
    const subFields = await fetchSubcontractorById(linkedIds[0]);
    if (subFields) {
      displayName =
        subFields["Subcontractor Company Name"] ??
        subFields["Name"] ?? subFields["Company"] ?? "";
      phoneNumber =
        subFields["Subcontractor Phone Number"] ??
        subFields["Phone"] ?? subFields["Phone Number"] ?? "";
    }
  } else if (typeof linkedValue === "string" && linkedValue.trim() !== "") {
    const subFields = await fetchSubcontractorByName(linkedValue.trim());
    if (subFields) {
      displayName = subFields["Subcontractor Company Name"] ?? linkedValue.trim();
      phoneNumber =
        subFields["Subcontractor Phone Number"] ??
        subFields["Phone"] ?? subFields["Phone Number"] ?? "";
    } else {
      displayName = linkedValue.trim();
    }
  }

  if (!displayName) displayName = "N/A";
  const tel = normalizePhoneForTel(phoneNumber);

  // Make sure it can show multiple lines and isn’t clipped
  target.style.whiteSpace = "normal";
  target.style.display = "block";

  // Render both lines; make the number clickable
  if (tel && phoneNumber) {
    target.innerHTML = `
      <div>${displayName}</div>
      <div style="font-size:0.9em; color:#555;">
        <a href="tel:${tel}" style="color:inherit; text-decoration:none;">${phoneNumber}</a>
      </div>
    `;
  } else {
    target.textContent = displayName;
  }
}


async function fetchWithRetry(url, options = {}, maxRetries = 5) {
  let attempt = 0;
  let delay = 500; // start with 500ms

  while (attempt < maxRetries) {
    const response = await fetch(url, options);

    if (response.status !== 429) return response;

    console.warn(`⚠️ Rate limited, retrying in ${delay}ms...`);
    await new Promise(res => setTimeout(res, delay));
    delay *= 2; // exponential backoff
    attempt++;
  }

  throw new Error(`❌ Max retries reached for ${url}`);
}

function getWarrantyId() {
    const id = document.getElementById("warranty-id")?.value?.trim();
    if (id) return id;
    if (currentWarrantyId) {
        return currentWarrantyId;
    }
    return null;
}

function updateMaterialVisibility() {
  const materialSelect = document.getElementById('material-needed-select');
  const materialsContainer = document.getElementById('materials-needed-container');
  const vendorDropdownContainer = document.getElementById('vendor-dropdown-container');

  if (!materialSelect || !materialsContainer || !vendorDropdownContainer) {
    return;
  }

  const selected = materialSelect.value.trim();

  if (selected === 'Needs Materials') {
    materialsContainer.style.display = '';
    vendorDropdownContainer.style.display = '';
  } else {
    materialsContainer.style.display = 'none';
    vendorDropdownContainer.style.display = 'none';
  }
}

document.getElementById('material-needed-select').addEventListener('change', updateMaterialVisibility);
window.addEventListener('DOMContentLoaded', updateMaterialVisibility);


function checkAndHideDeleteButton() {
    const deleteButton = document.getElementById("delete-images-btn");
    const issueContainer = document.getElementById("issue-pictures");
    const completedContainer = document.getElementById("completed-pictures");

    if (!deleteButton || !issueContainer || !completedContainer) return;

    const issueImages = issueContainer.querySelectorAll("img").length;
    const completedImages = completedContainer.querySelectorAll("img").length;
    const selectedCheckboxes = document.querySelectorAll(".image-checkbox:checked").length;


    if (issueImages > 0 || completedImages > 0 || selectedCheckboxes > 0) {
        deleteButton.style.setProperty("display", "block", "important");
    } else {
        deleteButton.style.setProperty("display", "none", "important");
    }
}

function addCarouselSwipeHandlers(overlay) {
  let startX = 0, startY = 0, touchMoved = false;

  // Use the inner body, not the overlay
  const swipeTarget = overlay.querySelector("#carousel-body") || overlay;

  swipeTarget.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      touchMoved = false;
    }
  }, { passive: false });

  swipeTarget.addEventListener("touchmove", (e) => {
    if (e.touches.length !== 1) return;

    const diffX = e.touches[0].clientX - startX;
    const diffY = e.touches[0].clientY - startY;

    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 10) {
      e.preventDefault();  // 🚫 block browser back nav
      touchMoved = true;
    }
  }, { passive: false });

swipeTarget.addEventListener("touchend", (e) => {
  if (!touchMoved || e.changedTouches.length !== 1) return;

  const diffX = e.changedTouches[0].clientX - startX;
  if (Math.abs(diffX) > 40) {
    diffX > 0 ? prevImage() : nextImage();
  }
}, { passive: false });

}


function ensureCarouselOverlay() {
  let overlay = document.getElementById("attachment-carousel");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "attachment-carousel";
  overlay.style.display = "none";
  overlay.innerHTML = `
    <button id="carousel-prev" class="carousel-nav carousel-nav-left">&#8592;</button>
    <div id="carousel-body"></div>
    <button id="carousel-next" class="carousel-nav carousel-nav-right">&#8594;</button>
    <button id="carousel-close-button" class="carousel-close">&times;</button>
  `;
  document.body.appendChild(overlay);

  // Attach swipe events right here!
  addCarouselSwipeHandlers(overlay);

  const nextBtn = overlay.querySelector("#carousel-next");
  const prevBtn = overlay.querySelector("#carousel-prev");
  const closeBtn = overlay.querySelector("#carousel-close-button");

  // Setup nav/close button listeners
nextBtn.addEventListener("click", (e) => {
  e.preventDefault();
  nextImage();
});

prevBtn.addEventListener("click", (e) => {
  e.preventDefault();
  prevImage();
});


  closeBtn.addEventListener("click", () => {
    closeCarousel();
  });

  return overlay;
}

// ✅ Open the carousel
function openCarousel(files, startIndex = 0, warrantyId, field) {
  const overlay = ensureCarouselOverlay();
  const body = document.getElementById("carousel-body");
  if (!overlay || !body) return;

  currentCarouselFiles = files;
  currentCarouselIndex = startIndex;
  currentCarouselField = field;
  currentWarrantyId = warrantyId;

  overlay.style.display = "flex";
  globalSwipeEnabled = false; // 🔒 disable page swipe
  displayCarouselItem(currentCarouselIndex);


  // ✅ Prevent page scroll
  document.body.style.overflow = "hidden";
  // Debug: log files loaded into carousel
  console.log("📝 currentCarouselFiles length:", currentCarouselFiles.length);
  console.log(currentCarouselFiles.map(f => f.filename || f.url));
}


document.addEventListener("keydown", (e) => {
  const overlay = document.getElementById("attachment-carousel");
  if (!overlay || overlay.style.display === "none") return; // only if open

  if (e.key === "ArrowRight") nextImage();
  if (e.key === "ArrowLeft") prevImage();
  if (e.key === "Escape") closeCarousel();
});


// ✅ Display an individual item
function displayCarouselItem(index) {
  const body = document.getElementById("carousel-body");

  if (!body || !Array.isArray(currentCarouselFiles) ||
      index < 0 || index >= currentCarouselFiles.length) {
    console.warn("❌ Invalid carousel state:", { body, files: currentCarouselFiles, index });
    return;
  }

  const file = currentCarouselFiles[index];
  console.log("📸 Rendering file:", file);

  body.innerHTML = "";

  if (file?.url) {
    if (file.type?.startsWith("image/")) {
 const img = document.createElement("img");
const bustedUrl = file.url + (file.url.includes("?") ? "&" : "?") + "ts=" + Date.now();
img.src = bustedUrl;
img.alt = file.filename || "Image Preview";

/* Better mobile + landscape handling */
img.style.width = "100%";
img.style.height = "auto";
img.style.maxHeight = "90vh";
img.style.objectFit = "contain";
img.style.transition = "transform 0.3s ease";

window.addEventListener("orientationchange", () => {
  // adjust dynamically on rotation
  if (window.matchMedia("(orientation: landscape)").matches) {
    img.style.width = "auto";
    img.style.height = "90vh";
  } else {
    img.style.width = "100%";
    img.style.height = "auto";
  }
});


  body.appendChild(img);

  // ✅ Debug logs
  console.log("📸 Rendering image:", file.filename || file.url);
  console.log("🔗 Image URL (with cache‑buster):", bustedUrl);
  console.log("📍 Carousel index:", index, "of", currentCarouselFiles.length);
    } else if (file.type === "application/pdf") {
      const iframe = document.createElement("iframe");
      iframe.src = file.url;
      iframe.style.width = "80vw";
      iframe.style.height = "80vh";
      body.appendChild(iframe);
    } else {
      console.warn("⚠️ Unsupported file type, showing raw link:", file);
      const a = document.createElement("a");
      a.href = file.url;
      a.textContent = file.filename || "Download File";
      a.target = "_blank";
      body.appendChild(a);
    }
  } else {
    console.error("❌ File missing .url:", file);
  }

  updateCarouselNavVisibility();
}

function updateCarouselNavVisibility() {
  const overlay = document.getElementById("attachment-carousel");
  if (!overlay) return;

  const nextBtn = overlay.querySelector("#carousel-next");
  const prevBtn = overlay.querySelector("#carousel-prev");

  if (currentCarouselFiles.length <= 1) {
    nextBtn.style.display = "none";
    prevBtn.style.display = "none";
  } else {
    nextBtn.style.display = "block";
    prevBtn.style.display = "block";
  }
}


// ✅ Close the carousel
function closeCarousel() {
  const overlay = document.getElementById("attachment-carousel");
  const closeBtn = document.getElementById("carousel-close-button");
  const saveBtn = document.getElementById("save-job");

  if (overlay) overlay.style.display = "none";
  if (closeBtn) closeBtn.style.display = "none";
  if (saveBtn) saveBtn.style.display = "block";

  // Re-enable body scroll
  document.body.style.overflow = "auto";

  // ✅ Remove system swipe blocker
  if (systemSwipeBlocker && overlay) {
    overlay.removeEventListener("touchstart", systemSwipeBlocker.touchstart);
    overlay.removeEventListener("touchmove", systemSwipeBlocker.touchmove);
    systemSwipeBlocker = null;
  }
  globalSwipeEnabled = true; // 🔓 re-enable page swipe

  // Reset state
  currentCarouselFiles = [];
  currentCarouselIndex = 0;
  currentCarouselField = null;
  currentWarrantyId = null;
}



document.getElementById("carousel-close-button")?.addEventListener("click", () => {
  closeCarousel();
});


// ✅ Setup navigation buttons
document.getElementById("carousel-next")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (currentCarouselFiles.length > 0) {
    currentCarouselIndex = (currentCarouselIndex + 1) % currentCarouselFiles.length;
    displayCarouselItem(currentCarouselIndex);
  }
});

document.getElementById("carousel-prev")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (currentCarouselFiles.length > 0) {
    currentCarouselIndex =
      (currentCarouselIndex - 1 + currentCarouselFiles.length) % currentCarouselFiles.length;
    displayCarouselItem(currentCarouselIndex);
  }
});

// ✅ Close button logic
document.getElementById("close-carousel")?.addEventListener("click", () => {
  closeCarousel();
});

// ✅ Optional: Delete button
document.getElementById("delete-current-attachment")?.addEventListener("click", async (e) => {
  e.preventDefault();
  e.stopPropagation();

  if (!currentWarrantyId) {
    console.error("❌ currentWarrantyId is missing.");
    alert("Missing warranty ID. Cannot proceed with deletion.");
    return;
  }

  if (!currentCarouselField) {
    console.error("❌ currentCarouselField is missing.");
    alert("Missing image field name. Cannot proceed with deletion.");
    return;
  }

  if (!currentCarouselFiles || !currentCarouselFiles[currentCarouselIndex]) {
    console.error("❌ No current file selected or invalid index.");
    alert("No file selected. Cannot delete.");
    return;
  }

  const fileToDelete = currentCarouselFiles[currentCarouselIndex];

  if (!fileToDelete.id) {
    alert("File is missing a valid ID. Cannot delete.");
    return;
  }

  if (!confirm(`Delete ${fileToDelete.filename}?`)) {
    return;
  }

  try {
    const existing = await fetchCurrentImagesFromAirtable(currentWarrantyId, currentCarouselField);
    const updated = existing.filter(file => file.id !== fileToDelete.id);

    await updateAirtableRecord(window.env.AIRTABLE_TABLE_NAME, currentWarrantyId, {
      [currentCarouselField]: updated
    });

    currentCarouselFiles = updated;

    if (currentCarouselFiles.length === 0) {
      closeCarousel();
    } else {
      currentCarouselIndex = Math.min(currentCarouselIndex, currentCarouselFiles.length - 1);
      displayCarouselItem(currentCarouselIndex);
    }

    showToast("✅ File deleted successfully.", "success");

    // 🔄 Force background image containers to update without disrupting carousel
    setTimeout(() => {
      refreshImageContainers();
    }, 1000); // slight delay to allow Airtable update to propagate

  } catch (error) {
    console.error("❌ Error deleting file from Airtable:", error);
    showToast("❌ Failed to delete file. Try again.", "error");
  }
});

async function displayImages(files, containerId, fieldName = "") {
    const container = document.getElementById(containerId);
    if (!container) {
        return;
    }

      if (
    containerId === "issue-pictures" &&
    status?.toLowerCase().trim() === "scheduled- awaiting field"
  ) {
    container.innerHTML = ""; // Just in case
    container.style.display = "none";
    return;
  }

    container.innerHTML = ""; // Clear existing content

  if (!files || files.length === 0) {
    const isIssue = fieldName === "Picture(s) of Issue";
    const header = isIssue ? "Issue Images" : "Completed Images";
    const wrapperId = isIssue ? "issue-images-container" : "completed-images-container";

    container.innerHTML = `
        <div class="${isIssue ? "issue-images-wrapper" : "completed-images-wrapper"}">
            <h3 style="margin-top: 10px;">${header}</h3>
            <div id="${wrapperId}"><p>No images uploaded yet.</p></div>
        </div>
    `;

    container.style.display = "block";
    checkAndHideDeleteButton();
    return;
}

    for (const file of files) {
        if (!file.url) {
            console.error("❌ Missing 'url' field in file object:", file);
            continue;
        }
        const wrapperDiv = document.createElement("div");
        wrapperDiv.classList.add("file-wrapper");
        wrapperDiv.style.display = "inline-block";
        wrapperDiv.style.margin = "10px";
        wrapperDiv.style.position = "relative";
        wrapperDiv.style.textAlign = "center";
        wrapperDiv.style.width = "200px";
    
        // ✅ Declare checkbox properly before using it
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.classList.add("file-checkbox", "image-checkbox");
        checkbox.dataset.imageId = file.id || "";
    
        // ✅ Add event listener inside the loop
        checkbox.addEventListener("change", function () {
            wrapperDiv.classList.toggle("checked", this.checked);
        });
    
        // Overlay text for "Marked for Deletion"
        const overlay = document.createElement("div");
        overlay.classList.add("marked-for-deletion");
        overlay.innerText = "Marked for Deletion";

        // Handle checkbox state changes
        checkbox.addEventListener("change", function () {
            if (this.checked) {
                wrapperDiv.classList.add("checked");
            } else {
                wrapperDiv.classList.remove("checked");
            }
        });

        // Filename label
        const fileLabel = document.createElement("p");
        fileLabel.innerText = file.filename || "Unknown File";
        fileLabel.style.fontSize = "12px";
        fileLabel.style.marginTop = "5px";
        fileLabel.style.wordBreak = "break-word"; 

        // Add this once outside the function
const previewModal = document.getElementById("previewModal");
const previewContent = document.getElementById("previewContent");

if (previewModal) {
  previewModal.addEventListener("click", (e) => {
    if (e.target?.id === "closePreview") {
      previewModal.style.display = "none";
      previewContent.innerHTML = `
        <span id="closePreview" style="position:absolute; top:20px; right:30px; font-size:30px; cursor:pointer; color:white;">&times;</span>
      `;
    }
  });
}
        let previewElement;

        if (file.type && file.type === "application/pdf") {
            previewElement = document.createElement("canvas");
            previewElement.style.width = "100%";
            previewElement.style.border = "1px solid #ddd";
            previewElement.style.borderRadius = "5px";
            previewElement.style.cursor = "pointer";

previewElement.addEventListener("click", () => {
const fileIndex = files.findIndex(f => f.url === file.url);
openCarousel(files, fileIndex >= 0 ? fileIndex : 0, getWarrantyId(), fieldName);

});

            try {
                const pdf = await pdfjsLib.getDocument(file.url).promise;
                const page = await pdf.getPage(1);
                const scale = 1;
                const viewport = page.getViewport({ scale });
                const context = previewElement.getContext("2d");
                previewElement.height = viewport.height;
                previewElement.width = viewport.width;

                await page.render({
                    canvasContext: context,
                    viewport: viewport,
                });
            } catch (error) {
                console.error("❌ Error loading PDF preview:", error);
                previewElement = document.createElement("iframe");
                previewElement.src = file.url;
                previewElement.width = "180";
                previewElement.height = "220";
                previewElement.style.borderRadius = "10px";
                previewElement.style.border = "1px solid #ddd";
            }
        } else if (file.type && typeof file.type === "string" && file.type.startsWith("image/")) {
            previewElement = document.createElement("img");
            previewElement.src = file.url; 
            previewElement.setAttribute("data-file-id", file.id || "");
            previewElement.classList.add("uploaded-file");
            previewElement.style.maxWidth = "100%";
            previewElement.style.borderRadius = "5px";
            previewElement.style.border = "1px solid #ddd";
            previewElement.style.cursor = "pointer";

previewElement.addEventListener("click", () => {
  const fileIndex = files.findIndex(f => f.url === file.url);
  openCarousel(files, fileIndex >= 0 ? fileIndex : 0, getWarrantyId(), fieldName);
});

        } else {
            previewElement = document.createElement("a");
            previewElement.href = file.url;
            previewElement.innerText = "Download File";
            previewElement.target = "_blank";
            previewElement.style.display = "block";
            previewElement.style.padding = "5px";
            previewElement.style.background = "#f4f4f4";
            previewElement.style.borderRadius = "5px";
            previewElement.style.textDecoration = "none";
        }

        // Append elements
        wrapperDiv.appendChild(checkbox);
        wrapperDiv.appendChild(overlay);
        wrapperDiv.appendChild(previewElement);
        wrapperDiv.appendChild(fileLabel);
        container.appendChild(wrapperDiv);
    }

container.style.display = "none";
container.offsetHeight;
container.style.display = "block";




    // ✅ Check if we need to show or hide delete button
    checkAndHideDeleteButton();
}

async function fetchCurrentImagesFromAirtable(warrantyId, imageField) {
    
    if (!warrantyId) {
        console.error("❌ Warranty ID is missing. Cannot fetch images.");
        return [];
    }

    const url = `https://api.airtable.com/v0/${window.env.AIRTABLE_BASE_ID}/${window.env.AIRTABLE_TABLE_NAME}?filterByFormula=${encodeURIComponent(`{Warranty Record ID} = '${warrantyId}'`)}&fields[]=${imageField}`;

    try {
        const response = await fetchWithRetry(url, {
            headers: { Authorization: `Bearer ${window.env.AIRTABLE_API_KEY}` }
        });

        if (!response.ok) {
            console.error("❌ Error fetching record:", response.status, response.statusText);
            return [];
        }

        const data = await response.json();

        if (data.records.length === 0) {
            return [];
        }

        const record = data.records[0];

        if (record.fields && record.fields[imageField]) {
            return record.fields[imageField];
        } else {
            return [];
        }
    } catch (error) {
        console.error("❌ Error fetching images by Warranty ID:", error);
        return [];
    }
}

 document.getElementById("nav-toggle").addEventListener("click", function () {
    document.querySelector("nav").classList.toggle("collapsed");
  });

async function loadImagesForLot(warrantyId, statusRaw) {
  const issuePicturesSection = document.getElementById("issue-pictures");
  const completedPicturesSection = document.getElementById("completed-pictures");
  const uploadIssueInput = document.getElementById("upload-issue-picture");
  const uploadCompletedInput = document.getElementById("upload-completed-picture");

  if (!issuePicturesSection || !completedPicturesSection || !uploadIssueInput || !uploadCompletedInput) {
    console.error("❌ One or more required image containers or inputs are missing.");
    return;
  }

  // Clear UI first
  issuePicturesSection.innerHTML = "📡 Loading issue images...";
  completedPicturesSection.innerHTML = "📡 Loading completed images...";

  const status = (statusRaw || "").toLowerCase().trim();

  try {
    const issueImages = await fetchCurrentImagesFromAirtable(warrantyId, "Picture(s) of Issue");
    const completedImages = await fetchCurrentImagesFromAirtable(warrantyId, "Completed  Pictures");

    const hasIssueImages = Array.isArray(issueImages) && issueImages.length > 0;
    const hasCompletedImages = Array.isArray(completedImages) && completedImages.length > 0;

    // Clear loading state
    issuePicturesSection.innerHTML = "";
    completedPicturesSection.innerHTML = "";

    // Hide/show upload inputs
    uploadIssueInput.style.display = hasIssueImages ? "block" : "none";
    uploadCompletedInput.style.display = hasCompletedImages ? "block" : "none";

    // ✅ Only display issue images if status is NOT 'Scheduled- Awaiting Field'
if (hasIssueImages) {
  if (status === "scheduled- awaiting field") {
    // Check if wrapper already exists to avoid re-adding
    const wrapperExists = document.getElementById("issue-images-container");
    if (!wrapperExists) {
      let html = `
        <div class="issue-images-wrapper">
          <h3 style="margin-top: 10px;">Issue Images</h3>
          <div id="issue-images-container"></div>
      `;

      if (hasCompletedImages) {
        html += `<hr style="margin-top: 10px; margin-bottom: 10px;">`;
      }

      html += `</div>`;
      issuePicturesSection.innerHTML = html;
    }

    issuePicturesSection.style.display = "block";

    // Always re-render the images inside the inner container
    await displayImages(issueImages, "issue-images-container", "Picture(s) of Issue");
  } else {
    await displayImages(issueImages, "issue-pictures", "Picture(s) of Issue");
  }
} else {
  issuePicturesSection.innerHTML = "<p>No issue images uploaded yet.</p>";
  issuePicturesSection.style.display = "block";
}

  if (hasCompletedImages) {
  const completedContainer = document.getElementById("completed-pictures");
  if (completedContainer) {
    completedContainer.innerHTML = `
      <div class="completed-images-wrapper">
        <h3 style="margin-top: 10px;">Completed Images</h3>
        <div id="completed-images-container"></div>
      </div>
    `;
    await displayImages(completedImages, "completed-images-container", "Completed  Pictures");
  }
}

    // Refresh delete button visibility
    setTimeout(checkAndHideDeleteButton, 300);

  } catch (error) {
    console.error(`❌ Error loading images for warranty ID: ${warrantyId}`, error);
    issuePicturesSection.innerHTML = "❌ Error loading issue images.";
    completedPicturesSection.innerHTML = "❌ Error loading completed images.";
  }
}

async function refreshImageContainers() {

  const warrantyId = getWarrantyId();
  if (!warrantyId) {
    console.error("❌ Cannot refresh images: missing warranty ID");
    return;
  }

  const statusField = document.getElementById("field-status");
  const status = statusField?.value || "";

  try {
    await loadImagesForLot(warrantyId, status);
  } catch (error) {
    console.error("❌ Failed to refresh image containers:", error);
    showToast("❌ Error refreshing images. Try again.", "error");
  }
}

function setInputValue(id, value) {
    const element = document.getElementById(id);
    if (!element) {
        return;
    }

    if (id === "subcontractor-payment") {

        // Show raw string (like "Sub Not Needed")
        if (typeof value === "string" && isNaN(parseFloat(value))) {
            element.value = value;
            return;
        }

        // Format number as currency
        const numberValue = parseFloat(value);
        if (!isNaN(numberValue)) {
            element.value = `$${numberValue.toLocaleString(undefined, {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            })}`;
        } else {
            element.value = "";
        }
        return;
    }

    // Default case
    element.value = value || "";
}

async function getRecordIdByWarrantyId(warrantyId) {
    const filterFormula = `{Warranty Record ID} = "${warrantyId}"`;
    const url = `https://api.airtable.com/v0/${window.env.AIRTABLE_BASE_ID}/${window.env.AIRTABLE_TABLE_NAME}?filterByFormula=${encodeURIComponent(filterFormula)}&maxRecords=1`;

    try {
        const response = await fetchWithRetry(url, {
            headers: { Authorization: `Bearer ${window.env.AIRTABLE_API_KEY}` }
        });

        const data = await response.json();

        if (data.records?.length > 0) {
            return data.records[0].id;
        }

        return null;
    } catch (error) {
        console.error("❌ Error fetching by Warranty Record ID:", error);
        return null;
    }
}

function showToast(message, type = "success", duration = 3000) {
    let toast = document.getElementById("toast-message");

    // Create toast element if it doesn’t exist
    if (!toast) {
        toast = document.createElement("div");
        toast.id = "toast-message";
        toast.className = "toast-container";
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.classList.add("show");

    toast.style.background = type === "error"
        ? "rgba(200, 0, 0, 0.85)"
        : "rgba(0, 128, 0, 0.85)";

    // Remove any existing click handler to prevent duplicates
    document.removeEventListener("click", toastClickAwayHandler);

    // Add click-away dismiss logic
    function toastClickAwayHandler(e) {
        if (!toast.contains(e.target)) {
            toast.classList.remove("show");
            document.removeEventListener("click", toastClickAwayHandler);
        }
    }

    document.addEventListener("click", toastClickAwayHandler);

    // Auto-hide after duration
    setTimeout(() => {
        toast.classList.remove("show");
        document.removeEventListener("click", toastClickAwayHandler);
    }, duration);
}


// When the modal or scrollable container opens:
document.body.classList.add('noscroll');
// When it closes:
document.body.classList.remove('noscroll');


function openMapApp() {
    const addressInput = document.getElementById("address");

    if (!addressInput || !addressInput.value) {
        alert("⚠️ No address available.");
        return;
    }

    const address = encodeURIComponent(addressInput.value.trim());
    const userAgent = navigator.userAgent.toLowerCase();

    // Automatically open Apple Maps on iOS
    if (userAgent.match(/(iphone|ipad|ipod)/i)) {
        window.location.href = `maps://maps.apple.com/?q=${address}`;
        return;
    }

    // Automatically open Google Maps on Android
    if (userAgent.match(/android/i)) {
        window.location.href = `geo:0,0?q=${address}`;
        return;
    }

    // Create a modal for other devices (Desktop, etc.)
    const modal = document.createElement("div");
    modal.id = "mapModal";
    modal.style.position = "fixed";
    modal.style.top = "50%";
    modal.style.left = "50%";
    modal.style.transform = "translate(-50%, -50%)";
    modal.style.background = "#fff";
    modal.style.padding = "20px";
    modal.style.borderRadius = "10px";
    modal.style.boxShadow = "0px 4px 6px rgba(0,0,0,0.1)";
    modal.style.zIndex = "1000";
    modal.style.textAlign = "center";

    // Modal content
    modal.innerHTML = `
        <h3>Select Navigation App</h3>
        <button id="googleMapsBtn" style="padding:10px; margin:5px; background:#4285F4; color:white; border:none; border-radius:5px; cursor:pointer;">Google Maps</button>
        <button id="wazeBtn" style="padding:10px; margin:5px; background:#1DA1F2; color:white; border:none; border-radius:5px; cursor:pointer;">Waze</button>
        <button id="closeModalBtn" style="padding:10px; margin:5px; background:#d9534f; color:white; border:none; border-radius:5px; cursor:pointer;">Close</button>
    `;

    document.body.appendChild(modal);

    // Event listeners for buttons
    document.getElementById("googleMapsBtn").addEventListener("click", function () {
        window.location.href = `https://www.google.com/maps/search/?api=1&query=${address}`;
    });

    document.getElementById("wazeBtn").addEventListener("click", function () {
        window.location.href = `https://waze.com/ul?q=${address}`;
    });

    document.getElementById("closeModalBtn").addEventListener("click", function () {
        document.body.removeChild(modal);
    });
}

document.addEventListener("DOMContentLoaded", async function () {
    
    const params = new URLSearchParams(window.location.search);
    let recordId = params.get("id") || getSavedRecordId();
    const isCarouselMode = params.get("carousel") === "true";

    if ((!recordId || recordId.trim() === "") && !isCarouselMode) {
        console.error("❌ ERROR: No record ID found in URL or localStorage!");
        alert("No job selected. Redirecting to job list.");
        window.location.href = "index.html";
        return;
    }

    // ✅ Save to localStorage if it came from URL
    if (recordId) saveRecordIdToLocal(recordId);

    // ✅ Fetch Airtable API keys from environment
    const airtableApiKey = window.env?.AIRTABLE_API_KEY || "Missing API Key";
    const airtableBaseId = window.env?.AIRTABLE_BASE_ID || "Missing Base ID";
    const airtableTableName = window.env?.AIRTABLE_TABLE_NAME || "Missing Table Name";
        dropboxAccessToken = await fetchDropboxToken();
    

    if (!airtableApiKey || !airtableBaseId || !airtableTableName) {
        console.error("❌ Missing Airtable credentials! Please check your environment variables.");
        alert("Configuration error: Missing Airtable credentials.");
        return;
    }

    try {
        primaryData = await fetchAirtableRecord(airtableTableName, recordId); // ✅ Assign it here

        let resolvedRecordId = recordId;
if (!resolvedRecordId.startsWith("rec")) {
  resolvedRecordId = await getRecordIdByWarrantyId(recordId);
  if (!resolvedRecordId) {
    console.error("❌ Could not resolve Record ID for:", recordId);
    return;
  }
}

populateVendorDropdownWithSelection(resolvedRecordId); // don’t await

           // ✅ Populate UI with Primary Fields
populatePrimaryFields(primaryData.fields);
await setOriginalSubcontractorFromLinked(primaryData.fields);

const lotName = primaryData.fields["Lot Number and Community/Neighborhood"];
const statusRaw = primaryData.fields["Status"];
const status = (statusRaw || "").trim().toLowerCase();
const warrantyId = primaryData.fields["Warranty Record ID"];

const redirectStatuses = [
    "pending review",
    "customer review needed",
    "material purchase needed",
    "subcontractor to pay",
    "ready to invoice",
    "completed",
    "confirmed"
];

const noLongerNeedsFieldTech = ![
    "field tech review needed",
    "scheduled awaiting field technician",
    "scheduled- awaiting field"
].includes(status);

if (redirectStatuses.includes(status) || noLongerNeedsFieldTech) {
    const fieldTechName = primaryData.fields["field tech"] || "Field Tech";
    showToast(`📦 ${lotName} status updated to "${statusRaw}" by ${fieldTechName}. Redirecting...`, "success", 6000);

    const redirectTimer = setTimeout(() => {
        window.location.href = "index.html";
    }, 6000);

    // Cancel redirect if toast is dismissed early
    document.addEventListener("click", function handleClickAway(event) {
        const toast = document.getElementById("toast-message");
        if (toast && !toast.contains(event.target)) {
            clearTimeout(redirectTimer);
            toast.classList.remove("show");
            document.removeEventListener("click", handleClickAway);
        }
    });

    return;
}

await loadImagesForLot(warrantyId, statusRaw).then(() => {
    checkAndHideDeleteButton();
});

        // ✅ Fetch Subcontractors Based on `b` Value and Populate Dropdown

if (!recordId.startsWith("rec")) {
    resolvedRecordId = await getRecordIdByWarrantyId(recordId);
    if (!resolvedRecordId) {
        console.error("❌ Could not resolve Record ID for:", recordId);
        return;
    }
}

await fetchAndPopulateSubcontractors(resolvedRecordId);

        /** ✅ Subcontractor Handling Logic **/
        const subcontractorCheckbox = document.querySelector("#sub-not-needed");
        const subcontractorDropdown = document.querySelector("#subcontractor-dropdown");
        const saveButton = document.querySelector("#save-job");
 // Ensure the delete button exists before referencing it
 const deleteButton = document.getElementById("delete-images-btn");

 if (!deleteButton) {
     return; // Exit to prevent errors
 }
        if (!subcontractorCheckbox || !subcontractorDropdown || !saveButton) {
            return;
        }

        // Function to handle checkbox toggle
  function toggleSubcontractorField() {
            const input = document.getElementById("subcontractor-dropdown");
            const datalist = document.getElementById("subcontractor-options");
            const checkbox = document.getElementById("sub-not-needed");
            const paymentContainer = document.getElementById("subcontractor-payment-container");
            const paymentInput = document.getElementById("subcontractor-payment");
        
            if (!input || !checkbox || !datalist || !paymentContainer || !paymentInput) return;
        
            if (checkbox.checked) {
                input.value = "Sub Not Needed";
                input.setAttribute("readonly", "true");
                input.style.pointerEvents = "none";
                input.style.background = "#e9ecef";
        
                paymentContainer.style.display = "none";
                paymentInput.value = "Sub Not Needed"; // Set value to match logic
        
                // 🔁 Add "Sub Not Needed" to datalist if missing
                const exists = Array.from(datalist.options).some(opt => opt.value === "Sub Not Needed");
                if (!exists) {
                    const option = document.createElement("option");
                    option.value = "Sub Not Needed";
                    option.label = "Sub Not Needed (Manual Entry)";
                    datalist.appendChild(option);
                }
            } else {
                input.value = "";
                input.removeAttribute("readonly");
                input.style.pointerEvents = "auto";
                input.style.background = "";
        
                paymentContainer.style.display = "block";
                paymentInput.value = ""; // Clear when re-enabled
            }
        }
        
// ✅ Global helper to handle Airtable/Dropbox rate limits



        function checkImagesVisibility() {
            const images = document.querySelectorAll(".image-container img"); // Adjust selector if needed
            if (images.length > 0) {
                deleteButton.style.display = "block"; // Show button if images exist
            } else {
                deleteButton.style.display = "none"; // Hide button if no images
            }
        }
    
        // Optional: Run check when images are dynamically added/removed
        const observer = new MutationObserver(checkImagesVisibility);
        observer.observe(document.body, { childList: true, subtree: true });
    
        // Handle delete button click (assuming you have logic to delete images)
        deleteButton.addEventListener("click", function () {
            document.querySelectorAll(".image-container img.selected").forEach(img => img.remove());
            checkImagesVisibility(); // Re-check visibility after deletion
        });

        // Set initial checkbox state from job data
        setCheckboxValue("sub-not-needed", primaryData.fields["Subcontractor Not Needed"]);
        setTimeout(() => {
            toggleSubcontractorField();
        }, 50);
        // Apply subcontractor logic on load
        toggleSubcontractorField();
        
        /** ✅ Add Event Listener for Save Button **/
        saveButton.addEventListener("click", async function () {

            const scrollPosition = window.scrollY;

            const requiredFields = ["job-name", "StartDate", "EndDate"];
            for (const id of requiredFields) {
              const el = document.getElementById(id);
              if (el && !el.value.trim()) {
                el.focus();
                showToast(`⚠️ Please fill out ${id.replace("-", " ")}`, "error");
                return;
              }
            }
          
            const warrantyId = getWarrantyId(); // <-- ensure this is defined BELOW getWarrantyId()
            if (!warrantyId) {
                alert("Warranty ID missing!");
                return;
              }
            const lotName = document.getElementById("job-name")?.value?.trim();
            if (!lotName) {
                return;
            }
        
            try {
                // 🔄 Get the original record from Airtable to compare datetime values
                const recordData = await fetchAirtableRecord(window.env.AIRTABLE_TABLE_NAME, warrantyId);

                if (!recordData || !recordData.fields) {
                    alert("❌ Could not load record data. Try again.");
                    return;
                }
        
                const originalStartUTC = recordData.fields["StartDate"];
                const originalEndUTC = recordData.fields["EndDate"];
                const currentStartLocal = document.getElementById("StartDate")?.value;
                const currentEndLocal = document.getElementById("EndDate")?.value;
                const convertedStartUTC = safeToISOString(currentStartLocal);
                const convertedEndUTC = safeToISOString(currentEndLocal);
                const convertedStartAMPM = safeToISOString(currentStartLocal);
             const billableSelect = document.getElementById("billable-status");
const value = billableSelect?.value?.trim() || "";

if (value === "Billable" || value === "Non Billable") {
    updatedFields["Billable/ Non Billable"] = value;
} else {
    updatedFields["Billable/ Non Billable"] = null; // or skip if you don’t want to overwrite
}

                
                    let jobData = {
    "DOW to be Completed": document.getElementById("dow-completed").value,
    "Subcontractor Not Needed": subcontractorCheckbox.checked,
"Billable/ Non Billable": billableSelect ? billableSelect.value : undefined,
    "Homeowner Builder pay": document.getElementById("homeowner-builder").value,
    "Billable Reason (If Billable)": document.getElementById("billable-reason").value,
 "Field Review Not Needed": document.getElementById("field-review-not-needed")?.checked || false,
"Field Review Needed": document.getElementById("field-review-needed")?.checked || false,
    "Subcontractor Payment": parseFloat(document.getElementById("subcontractor-payment").value) || 0,
    "Materials Needed": document.getElementById("materials-needed").value,
"Field Tech Reviewed": document.getElementById("field-tech-reviewed")?.checked || false,
"Job Completed": document.getElementById("job-completed")?.checked || false,
"Material Not Needed": document.getElementById("material-not-needed")?.checked || false,
    "Date Warranty Started": document.getElementById("date-warranty-started").value 
};

                const fieldTechReviewedEl = document.getElementById("field-tech-reviewed");
                const jobCompletedEl = document.getElementById("job-completed");
                
                if (!fieldTechReviewedEl) console.warn("⚠️ Element #field-tech-reviewed not found.");
                if (!jobCompletedEl) console.warn("⚠️ Element #job-completed not found.");
                
                jobData["Field Tech Reviewed"] = fieldTechReviewedEl?.checked || false;
                jobData["Job Completed"] = jobCompletedEl?.checked || false;
                
// ✅ Safely parse Subcontractor Payment input
const paymentInput = document.getElementById("subcontractor-payment");
let paymentValue = paymentInput?.value?.replace(/[^0-9.]/g, ""); // Strip $ and commas
paymentValue = parseFloat(paymentValue);
if (!isNaN(paymentValue)) {
    jobData["Subcontractor Payment"] = paymentValue;
}

                // ✅ Add dates only if they changed
                if (convertedStartAMPM !== originalStartUTC) {
                    jobData["StartDate"] = convertedStartAMPM;
                } else {
                }
        
                if (convertedEndUTC !== originalEndUTC) {
                    jobData["EndDate"] = convertedEndUTC;
                } else {
                }
        
                // ✅ Handle subcontractor logic
                const selectedSub = subcontractorDropdown.value.trim();
        if (subcontractorCheckbox.checked) {
    jobData["Subcontractor"] = "Sub Not Needed";
    }       
        else if (selectedSub !== "") {
    jobData["Subcontractor"] = selectedSub;
    }
        if (window.materialDropdownValue) {
    updatedFields["Material/Not needed"] = window.materialDropdownValue;
    }
               
        if (!warrantyId) {
    console.error("❌ Warranty ID is missing.");
    return;
    }

        if (window.materialDropdownValue) {
    jobData["Material/Not needed"] = window.materialDropdownValue;

        if (window.materialDropdownValue === "Do Not Need Materials") {
        jobData["Material Vendor"] = []; // 🧹 Clear vendor
    }
}

                // ✅ Save to Airtable
                await updateAirtableRecord(window.env.AIRTABLE_TABLE_NAME, warrantyId, jobData);
        
                // ✅ Refresh UI with new data
                const refreshed = await fetchAirtableRecord(window.env.AIRTABLE_TABLE_NAME, warrantyId);

                if (refreshed) {
                    await populatePrimaryFields(refreshed.fields);
                    showToast("✅ Job saved successfully!", "success");
                }
        
            } catch (err) {
                console.error("❌ Error saving job data:", err);
            }
        });
            
        // ✅ Apply subcontractor logic on load
        toggleSubcontractorField();
    
        // ✅ Event listener for checkbox
        subcontractorCheckbox.addEventListener("change", () => {
            toggleSubcontractorField();
        
            const status = document.getElementById("field-status")?.value || "";
            const normalizedStatus = status.toLowerCase().trim();
        
            let shouldHideCompleted = [
                "scheduled- awaiting field",
                "field tech review needed"
            ].includes(normalizedStatus);
            
            // ✅ Force override: never hide if explicitly this status
            if (normalizedStatus === "scheduled awaiting field technician") {
                shouldHideCompleted = false;
            }
            
            if (normalizedStatus === "scheduled awaiting field technician") {
            
                [
                    "job-completed-container",
                    "job-completed",
                    "job-completed-check",
                    "upload-completed-picture",
                    "completed-pictures-heading",
                    "completed-pictures"
                ].forEach(showElement);
            }
            
            const elementsToToggle = [
                "completed-pictures",
                "upload-completed-picture",
                "completed-pictures-heading",
                "job-completed-container",
                "job-completed",
                "job-completed-check"
            ];  
        });
                        
    } catch (error) {
        const timestamp = new Date().toISOString();
        console.groupCollapsed(`❌ Error occurred [${timestamp}]`);
        console.error("🔍 Operation Context: [Describe what was being done here]");
        console.error("📛 Error Name:", error.name || "N/A");
        console.error("📝 Error Message:", error.message || "No message");
        if (error.stack) {
            console.error("📜 Stack Trace:", error.stack);
        }
        console.error("🧾 Full Error Object:", error);
        console.groupEnd();
    }
    
 function safeToISOString(dateString) {
    if (!dateString || typeof dateString !== "string") return null;
    const d = new Date(dateString);
    return isNaN(d.getTime()) ? null : d.toISOString();
}

    async function ensureDropboxToken() {
        if (!dropboxAccessToken) {
            dropboxAccessToken = await fetchDropboxToken();
                    }
    
        if (!dropboxAccessToken) {
            console.error("❌ Dropbox Access Token could not be retrieved.");
            alert("Error: Could not retrieve Dropbox access token.");
            return false;
        }
        return true;
    }
    
    function updateDeleteButtonLabel() {
        const deleteButton = document.getElementById("delete-images-btn");
        if (!deleteButton) {
            return;
        }
    
        const selectedImages = document.querySelectorAll(".image-checkbox:checked").length;
    
        deleteButton.textContent = selectedImages === 1 ? "Delete Selected Image" : "Delete Selected Images";
    
        // Log if the button state is changing
        if (selectedImages > 0) {
            deleteButton.style.display = "block"; // Ensure the button is visible
        } else {
            deleteButton.style.display = "none";
        }
    }

    // 🔹 Listen for checkbox changes and update the button label accordingly
    document.addEventListener("change", function (event) {
        if (event.target.classList.contains("image-checkbox")) {
            checkAndHideDeleteButton();
        }
    });
    
    // 🔹 Initial check on page load to set correct delete button state
    document.addEventListener("DOMContentLoaded", function () {
        updateDeleteButtonLabel();
    });
    
    document.getElementById("upload-issue-picture").addEventListener("change", async function (event) {
        if (event.target.files.length > 0) {
          if (await ensureDropboxToken()) {
            showToast("📤 Uploading issue photo...", "info");
            await uploadToDropbox(event.target.files, "Picture(s) of Issue");
            showToast("✅ Photo uploaded successfully!", "success");
          } else {
            showToast("❌ Dropbox authentication failed!", "error");
          }
        }
      });
      
      document.getElementById("upload-completed-picture").addEventListener("change", async function (event) {
        if (event.target.files.length > 0) {
          if (await ensureDropboxToken()) {
            showToast("📤 Uploading completed photo...", "info");
            await uploadToDropbox(event.target.files, "Completed  Pictures");
            showToast("✅ Photo uploaded successfully!", "success");
          } else {
            showToast("❌ Dropbox authentication failed!", "error");
          }
        }
      });
      
    const labels = document.querySelectorAll('.billable-label');
    let lastSelectedBillable = null;
    
    labels.forEach(label => {
        const input = label.querySelector('input');
    
        label.addEventListener('click', (e) => {
            e.preventDefault(); // prevent default radio behavior
    
            const isSelected = label.classList.contains('selected');
    
            // Deselect all
            labels.forEach(l => {
                l.classList.remove('selected');
                l.querySelector('input').checked = false;
            });
    
            const billableReasonDiv = document.getElementById("billable-reason-container");
            const homeownerBuilderSelect = document.getElementById("homeowner-builder");
            const homeownerBuilderContainer = homeownerBuilderSelect?.parentElement;
    
            if (isSelected) {
                // Toggle off
                lastSelectedBillable = null;
                if (billableReasonDiv) billableReasonDiv.style.display = "none";
                if (homeownerBuilderContainer) homeownerBuilderContainer.style.display = "none";
            } else {
                // Set new selection
                label.classList.add('selected');
                input.checked = true;
                lastSelectedBillable = input.value;
    
                const showExtra = input.value === "Billable";
    
                if (billableReasonDiv) {
                    billableReasonDiv.style.display = showExtra ? "block" : "none";
                }
    
                if (homeownerBuilderContainer) {
                    homeownerBuilderContainer.style.display = showExtra ? "block" : "none";
                }
            }
        });
    });

function allowScrollBounce(el) {
  el.addEventListener('wheel', function(e) {
    const scrollTop = el.scrollTop;
    const scrollHeight = el.scrollHeight;
    const height = el.clientHeight;
    const delta = e.deltaY;
    const atTop = scrollTop === 0;
    const atBottom = scrollTop + height >= scrollHeight - 1;

    if ((atTop && delta < 0) || (atBottom && delta > 0)) {
      // If at the end and user keeps scrolling, let page scroll
      e.preventDefault();
      window.scrollBy({ top: delta, behavior: 'auto' });
    }
    // Otherwise, container scrolls normally
  }, { passive: false });
}

document.addEventListener('DOMContentLoaded', function() {
  const scrollable = document.querySelector('.job-details-container');
  if (scrollable) allowScrollBounce(scrollable);
});

    async function fetchAirtableRecord(tableName, lotNameOrRecordId) {
    
        if (!lotNameOrRecordId) {
            console.error("❌ Lot Name or Record ID is missing. Cannot fetch record.");
            return null;
        }
    
        let recordId = lotNameOrRecordId;
    
        if (!recordId.startsWith("rec")) {
            recordId = await getRecordIdByWarrantyId(recordId);
            
            if (!recordId) {
                return null;
            }
        }
    
        const url = `https://api.airtable.com/v0/${window.env.AIRTABLE_BASE_ID}/${tableName}/${recordId}`;
    
        try {
            const response = await fetchWithRetry(url, {
                headers: { Authorization: `Bearer ${window.env.AIRTABLE_API_KEY}` }
            });
    
            if (!response.ok) {
                console.error(`❌ Error fetching record: ${response.status} ${response.statusText}`);
                return null;
            }
    
            const data = await response.json();
    
            if (data.fields && !data.fields["Completed  Pictures"]) {
                data.fields["Completed  Pictures"] = []; 
            }
    
            return data;
        } catch (error) {
            console.error("❌ Error fetching Airtable record:", error);
            return null;
        }
    }

document.querySelectorAll(".job-link").forEach(link => {
    link.addEventListener("click", function (event) {
        event.preventDefault();

        const jobId = this.dataset.recordId?.trim();

        if (!jobId) {
            console.error("❌ ERROR: Missing job ID in the link. Check 'data-record-id' attribute.");
            alert("Error: No job ID found. Please try again.");
            return;
        }

        // ✅ Save to localStorage before redirect
        saveRecordIdToLocal(jobId);

        const url = new URL(window.location.origin + window.location.pathname);
        url.searchParams.set("id", jobId);

        window.location.href = url.toString();
    });
});

document.addEventListener("DOMContentLoaded", function () {
  const subcontractorCheckbox = document.getElementById("sub-not-needed");
  const subcontractorDropdown = document.getElementById("subcontractor-dropdown");
  const subcontractorLabel = document.getElementById("subcontractor-dropdown1-label");
  const paymentContainer = document.getElementById("subcontractor-payment-container");

  function toggleSubcontractorFields() {
    const shouldHide = subcontractorCheckbox.checked;

    if (subcontractorDropdown) {
      subcontractorDropdown.style.display = shouldHide ? "none" : "";
    }

    if (subcontractorLabel) {
      subcontractorLabel.style.display = shouldHide ? "none" : "";
    }

    if (paymentContainer) {
      paymentContainer.style.display = shouldHide ? "none" : "";
    }
  }

  // Initial toggle on page load
  toggleSubcontractorFields();

  // Watch for checkbox change
  subcontractorCheckbox.addEventListener("change", toggleSubcontractorFields);
});

    async function fetchSubcontractorNameById(recordId) {
        const url = `https://api.airtable.com/v0/${window.env.AIRTABLE_BASE_ID}/tbl9SgC5wUi2TQuF7/${recordId}`;
      
        const response = await fetchWithRetry(url, {
          headers: {
            Authorization: `Bearer ${window.env.AIRTABLE_API_KEY}`
          }
        });
      
        if (!response.ok) {
          console.error("Failed to fetch subcontractor record", recordId);
          return "";
        }
      
        const data = await response.json();
        return data.fields["Subcontractor Company Name"] || ""; 
      }
      
async function populatePrimaryFields(job) {
  populateStaticInputs(job);
  populateMaterialSection(job);
  toggleJobCompletedVisibility(job);
  updateConditionalFieldVisibility(job);
  updateBillableFields(job);
  setReviewCheckboxes(job);
  showElement("save-job");

  // Async vendor + subcontractor in parallel
  requestIdleCallback(() => populateVendorDropdownWithSelection(job["Warranty Record ID"]));
  populateSubcontractorSection(job).then(() => {
  });

  // Adjust large textareas without blocking
  ["description", "dow-completed", "materials-needed"].forEach(id => {
    requestIdleCallback(() => adjustTextareaSize(id));
  });

  // Reveal the full form once background tasks are started
  requestIdleCallback(() => {
    document.getElementById("job-form")?.style.setProperty("opacity", "1", "important");
  });
}

function populateMaterialSection(job) {
    const materialSelect = document.getElementById("material-needed-select");
    const materialsTextarea = document.getElementById("materials-needed");
    const textareaContainer = document.getElementById("materials-needed-container");
    const value = job["Material/Not needed"] ?? "";
    const materialsValue = job["Materials Needed"] ?? "";


    if (materialSelect) {
        materialSelect.value = value;
        window.materialDropdownValue = value;
    }

    if (materialsTextarea) {
        materialsTextarea.value = materialsValue;
    }

    // ✅ Fallback if value is unexpected
    if (!value || (value !== "Needs Materials" && value !== "Do Not Need Materials")) {
        if (materialSelect) materialSelect.value = "";
        if (textareaContainer) textareaContainer.style.display = "none";
    }

    // ✅ Show or hide materials textarea depending on input
    if (value === "Needs Materials" || materialsValue.trim() !== "") {
        if (textareaContainer) textareaContainer.style.display = "block";
    }

    updateMaterialVisibility(); // sync vendor/materials visibility
}

document.addEventListener("DOMContentLoaded", function () {
  const materialSelect = document.getElementById('material-needed-select');
  materialSelect?.addEventListener('change', updateMaterialVisibility);
});

function toggleJobCompletedVisibility(job) {
    const container = document.getElementById("job-completed-container");
    const statusRaw = job["Status"];
    const status = (statusRaw || "").toLowerCase().trim();
    const shouldHide = status === "field tech review needed";

    if (container) {
        container.style.display = shouldHide ? "none" : "block";
    }

    // ✅ Also force hide the checkbox and label
    hideElementById("job-completed");
    hideElementById("job-completed-check");
    hideElementById("completed-pictures");
    hideElementById("upload-completed-picture");
    hideElementById("completed-pictures-heading");
    hideElementById("file-input-container");

    if (!shouldHide) {
        showElement("job-completed");
        showElement("job-completed-check");
        showElement("completed-pictures");
        showElement("upload-completed-picture");
        showElement("completed-pictures-heading");
        showElement("file-input-container");
    }
}

function updateConditionalFieldVisibility(job) {
  const status = job["Status"];
  if (status === "Scheduled- Awaiting Field") {
    [
      "billable-status", "homeowner-builder", "subcontractor", 
      "materials-needed", "billable-reason", "billable-reason-label", // <--- added here
      "field-review-not-needed", "field-review-needed",
      "field-tech-reviewed", "additional-fields-container", "message-container",
      "materials-needed-label", "upload-issue-picture-label", "field-tech-reviewed-label",
      "materials-needed-container", "material-needed-container", "issue-pictures",
      "upload-issue-picture", "trigger-issue-upload", "issue-file-list"
    ].forEach(hideElementById);

    // ✅ Do NOT hide job-completed or save-job here!
    showElement("job-completed");
    showElement("save-job");
  } else {
    showElement("job-completed");
    showElement("job-completed-label");
    showElement("save-job");
  }
}
document.getElementById("billable-status")?.addEventListener("change", function () {
    const container = document.getElementById("billable-reason-container");
    const homeownerBuilderContainer = document.getElementById("homeowner-builder")?.parentElement;

    if (this.value === "Billable") {
        if (container) container.style.display = "block";
        if (homeownerBuilderContainer) homeownerBuilderContainer.style.display = "block";
    } else {
        if (container) container.style.display = "none";
        if (homeownerBuilderContainer) homeownerBuilderContainer.style.display = "none";
    }
});

function updateBillableFields(job) {
    const billableValue = job["Billable/ Non Billable"] ?? "";
    const billableSelect = document.getElementById("billable-status");
    const container = document.getElementById("billable-reason-container");
    const homeownerBuilderContainer = document.getElementById("homeowner-builder")?.parentElement;

    if (billableSelect) {
        billableSelect.value = billableValue || ""; // show "" if empty
    }

    // Show/hide extra fields depending on value
    if (billableValue === "Billable") {
        if (container) container.style.display = "block";
        if (homeownerBuilderContainer) homeownerBuilderContainer.style.display = "block";
    } else {
        if (container) container.style.display = "none";
        if (homeownerBuilderContainer) homeownerBuilderContainer.style.display = "none";
    }

    setInputValue("homeowner-builder", job["Homeowner Builder pay"] ?? "");
    setInputValue("billable-reason", job["Billable Reason (If Billable)"] ?? "");
}


function setReviewCheckboxes(job) {
    setCheckboxValue("field-tech-reviewed", job["Field Tech Reviewed"]);
    setCheckboxValue("job-completed-checkbox", job["Job Completed"]);
}

async function populateSubcontractorSection(job) {
    const subElement = document.getElementById("original-subcontractor");
    const container = subElement?.parentElement;
    const originalSub = job["Original Subcontractor"];
    let phone = job["Original Subcontractor Phone Number"];

    if (!Array.isArray(originalSub) || originalSub.length === 0) return;

    const id = originalSub[0];
    const name = await fetchSubcontractorNameById(id);
    if (!name) return;

    if (Array.isArray(phone)) phone = phone[0];

    subElement.textContent = name;
    subElement.style.cursor = "pointer";
    subElement.style.color = "#007bff";
    subElement.style.textDecoration = "underline";
    subElement.onclick = () => {
        const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
        isMobile ? window.location.href = `tel:${phone}` : alert(`📞 ${name}\n${phone}`);
    };

    const phoneLine = document.createElement("div");
    phoneLine.textContent = phone;
    phoneLine.style.fontSize = "0.85rem";
    phoneLine.style.color = "#555";
    phoneLine.style.marginTop = "4px";
    container.appendChild(phoneLine);

    container.style.display = "";
}

function populateStaticInputs(job) {
    const safe = val => val ?? "";

    setInputValue("warranty-id", job["Warranty Record ID"]);
    setInputValue("job-name", safe(job["Lot Number and Community/Neighborhood"]));
    setInputValue("field-tech", safe(job["field tech"]));
    setInputValue("address", safe(job["Address"]));
    setInputValue("homeowner-name", safe(job["Home owner full name"]));
    setInputValue("homeowner-number", safe(job["Homeowner number"]));
    setInputValue("description", safe(job["Description of Issue"]));
    setInputValue("dow-completed", safe(job["DOW to be Completed"]));
    setInputValue("StartDate", convertUTCToLocalInput(job["StartDate"]));
    setInputValue("EndDate", convertUTCToLocalInput(job["EndDate"]));
    setInputValue("date-warranty-started", safe(job["Date Warranty Started"])); // <-- Added line
    setInputValue("subcontractor", safe(job["Subcontractor"]));
    setInputValue("subcontractor-payment", safe(job["Subcontractor Payment"]));
    setInputValue("material-needed-select", safe(job["Material/Not needed"]));
    setCheckboxValue("sub-not-needed", job["Subcontractor Not Needed"] || false);

    const subDropdown = document.getElementById("subcontractor-dropdown");
    if (subDropdown) subDropdown.setAttribute("data-selected", safe(job["Subcontractor"]));

    ["description", "dow-completed", "materials-needed"].forEach(adjustTextareaSize);
}

document.getElementById("material-needed-select")?.addEventListener("change", (e) => {
    const value = e.target.value;
  
    // show or hide textarea
    const textarea = document.getElementById("materials-needed-textarea");
    if (value === "Needs Materials") {
      textarea?.classList.remove("hidden");
    } else {
      textarea?.classList.add("hidden");
    }
  
    // store this value for later save
    window.materialDropdownValue = value;
  });

function updateMaterialsTextareaVisibility() {
    const materialSelect = document.getElementById("material-needed-select");
    const textareaContainer = document.getElementById("materials-needed-container");

    if (!materialSelect || !textareaContainer) return;

    if (materialSelect.value === "Needs Materials") {
        textareaContainer.style.display = "block";
    } else {
        textareaContainer.style.display = "none";
    }
}

document.getElementById("material-needed-select")?.addEventListener("change", function () {
    const value = this.value;
    const textarea = document.getElementById("materials-needed");
    const materialsNeededContainer = document.getElementById("materials-needed-container");
    const vendorDropdown = document.getElementById("vendor-dropdown");

    window.materialDropdownValue = value;

    if (value === "Needs Materials") {
        if (materialsNeededContainer) materialsNeededContainer.style.display = "block";
    } else {
        // Confirm before clearing materials
        if (textarea?.value.trim()) {
            const confirmClear = confirm("You have entered materials. Do you want to clear them?");
            if (confirmClear) {
                textarea.value = "";
            } else {
                // Stay on "Needs Materials"
                this.value = "Needs Materials";
                window.materialDropdownValue = "Needs Materials";
                return;
            }
        }

        // ✅ Clear vendor dropdown selection
        if (vendorDropdown && vendorDropdown.value.trim()) {
            vendorDropdown.value = "";
        }

        if (materialsNeededContainer) materialsNeededContainer.style.display = "none";
    }
});

// Function to hide an element safely
function hideElementById(elementId) {
    const element = document.getElementById(elementId);
    if (!element) {
        return;
    }
    element.style.display = "none";
    element.style.margin = "0";     // reset margin
    element.style.padding = "0";    // reset padding
    element.style.height = "0";     // if it's a block element that may take height
}

// Function to resize any textarea dynamically
function adjustTextareaSize(id) {
    const textarea = document.getElementById(id);
    if (textarea) {
        textarea.style.height = "auto"; // Reset height
        textarea.style.height = textarea.scrollHeight + "px"; // Adjust height based on content
    }
}

// Ensure resizing also happens when a user types in the textarea
document.addEventListener("input", function (event) {
    if (event.target.tagName.toLowerCase() === "textarea") {
        adjustTextareaSize(event.target.id);
    }
});

function showElement(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
        element.style.display = "block";
    } else {
    }
}

function checkAndHideDeleteButton() {
    const deleteButton = document.getElementById("delete-images-btn");

    if (!deleteButton) {
        return;
    }

    const issueImages = document.querySelectorAll("#issue-pictures .file-wrapper img").length;
    const completedImages = document.querySelectorAll("#completed-pictures .file-wrapper img").length;

    if (issueImages > 0 || completedImages > 0) {
        deleteButton.style.display = "block";
    } else {
        deleteButton.style.display = "none";
    }
}

document.getElementById("delete-images-btn").addEventListener("click", async function (event) {
    event.preventDefault(); // ✅ Prevents page refresh
    const warrantyId = getWarrantyId();

    const checkboxes = document.querySelectorAll(".image-checkbox:checked");
    if (checkboxes.length === 0) {
        alert("⚠️ Please select at least one image to delete.");
        return;
    }

    // 🔹 Extract selected image IDs
    const imageIdsToDelete = Array.from(checkboxes).map(cb => cb.dataset.imageId).filter(id => id);

    if (imageIdsToDelete.length === 0) {
        return;
    }

    // 🔹 Delete from both "Picture(s) of Issue" and "Completed Pictures"
    await deleteImagesByLotName(warrantyId, imageIdsToDelete, "Picture(s) of Issue");
    await deleteImagesByLotName(warrantyId, imageIdsToDelete, "Completed  Pictures");

    // ✅ Refresh UI to reflect changes
    await loadImagesForLot(warrantyId, document.getElementById("field-status")?.value);
});

/** ✅ Function to remove images from Airtable */
async function deleteImagesByLotName(warrantyId, imageIdsToDelete, imageField) {
  if (!warrantyId) {
    console.error("❌ Lot Name is missing. Cannot delete images.");
    return;
  }
  if (!Array.isArray(imageIdsToDelete) || imageIdsToDelete.length === 0) return;

  try {
    let existingImages = await fetchCurrentImagesFromAirtable(warrantyId, imageField);
    if (!existingImages || existingImages.length === 0) return;

    const updatedImages = existingImages.filter(img => !imageIdsToDelete.includes(img.id));
    if (updatedImages.length === existingImages.length) return;

    checkAndHideDeleteButton();

    // 🔧 FIX: actually patch Airtable with the updated attachments
    await updateAirtableRecord(window.env.AIRTABLE_TABLE_NAME, warrantyId, {
      [imageField]: updatedImages
    });

    // refresh UI
    await loadImagesForLot(warrantyId);
  } catch (error) {
    console.error(`❌ Error deleting images from '${imageField}' in Airtable:`, error);
  }
}

async function testFetchImages() {
        try {
            const recordData = await fetchAirtableRecord(airtableTableName, recordId);
    
            if (recordData.fields["Picture(s) of Issue"]) {
              
            } else {
            }
        } catch (error) {
            console.error("❌ Error fetching test images from Airtable:", error);
        }
    }
    
    testFetchImages();
    document.getElementById("delete-images-btn").addEventListener("click", function () {
    });
    
    // ✅ Save record ID in localStorage before navigating away
function saveRecordIdToLocal(recordId) {
    localStorage.setItem("currentRecordId", recordId);
}

// ✅ Retrieve record ID from localStorage on page load
function getSavedRecordId() {
    return localStorage.getItem("currentRecordId");
}

// ✅ Set the record ID on page load
document.addEventListener("DOMContentLoaded", () => {
let recordId = new URLSearchParams(window.location.search).get("id") || getSavedRecordId();

    if (!recordId) {
        console.error("❌ No record ID found! Preventing redirect loop.");
        alert("No job selected.");
        return; // ✅ Prevents infinite redirects
    }

    saveRecordIdToLocal(recordId); 
    setTimeout(checkAndHideDeleteButton, 500); // slight delay if images render async
    document.getElementById("material-needed-select").addEventListener("change", updateMaterialsTextareaVisibility);
});

document.addEventListener("DOMContentLoaded", function () {

    const formElements = document.querySelectorAll(
        'input:not([disabled]), textarea:not([disabled]), select:not([disabled])'
    );

    formElements.forEach(element => {
        element.addEventListener("input", () => {
            formHasUnsavedChanges = true;
        }, { once: false });

        element.addEventListener("change", () => {
            formHasUnsavedChanges = true;
        }, { once: false });
    });

    // ✅ 💡 Add this right here:
    setTimeout(() => {
        const input = document.getElementById("upload-completed-picture");
        const label = document.querySelector("label[for='upload-completed-picture']");

        if (input) input.style.setProperty("display", "none", "important");
        if (label) label.style.setProperty("display", "none", "important");
    }, 500);
});

function formatDateTimeForAirtable(dateInput) {
    if (!dateInput) return "";
    let dateObj = new Date(dateInput);
    if (isNaN(dateObj.getTime())) return "";
    return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        month: "2-digit",
        day: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
    }).format(dateObj).replace(",", "");
}
   
document.getElementById("save-job").addEventListener("click", async function () {
        const scrollPosition = window.scrollY; // ✅ Add this as your first line    
        const warrantyId = getWarrantyId();
    
        if (!warrantyId) {
            const warrantyElement = document.getElementById("warranty-id");
            const rawWarrantyId = warrantyElement ? warrantyElement.value : undefined;
    
            showToast("❌ Error: Warranty ID is missing or empty. Please check the field.", "error");
            alert("⚠️ Cannot save because the 'Warranty ID' is missing or invalid. Please ensure the field is filled in.");
            return;
        }
        
const currentRecord = await fetchAirtableRecord(window.env.AIRTABLE_TABLE_NAME, warrantyId);
const originalStartUTC = currentRecord?.fields?.["StartDate"] ?? null;
const originalEndUTC = currentRecord?.fields?.["EndDate"] ?? null;
const originalFormattedStart = currentRecord?.fields?.["FormattedStartDate"] ?? "";

const currentStartLocal = document.getElementById("StartDate")?.value || "";
const currentEndLocal   = document.getElementById("EndDate")?.value || "";

const convertedStartUTC = safeToISOString(currentStartLocal);
const formattedStartAT  = formatDateTimeForAirtable(currentStartLocal); // your existing formatter

// Update Start + FormattedStartDate only if either changed
if ((convertedStartUTC ?? "") !== (originalStartUTC ?? "") ||
    (formattedStartAT  ?? "") !== (originalFormattedStart ?? "")) {
  updatedFields["StartDate"] = convertedStartUTC ?? null;   // null clears if empty
  updatedFields["FormattedStartDate"] = formattedStartAT ?? "";
}

// Material/Not needed (guard element safely)
const materialSelect = document.getElementById("material-needed-select");
updatedFields["Material/Not needed"] = materialSelect?.value?.trim() || null;

// EndDate only if changed
const convertedEndUTC = safeToISOString(currentEndLocal);
if ((convertedEndUTC ?? "") !== (originalEndUTC ?? "")) {
  updatedFields["EndDate"] = convertedEndUTC;
}
 else {
        }
        
        
      // ✅ Manually handle radio buttons for Billable/Non Billable
const billableSelect = document.getElementById("billable-status");
if (billableSelect && billableSelect.value.trim()) {
    updatedFields["Billable/ Non Billable"] = billableSelect.value.trim();
} else {
    updatedFields["Billable/ Non Billable"] = null;
}

        const subcontractorPaymentInput = document.getElementById("subcontractor-payment");
if (subcontractorPaymentInput) {
    let subcontractorPaymentRaw = subcontractorPaymentInput.value.replace(/[^0-9.]/g, ""); // Remove $ and commas
    let subcontractorPayment = parseFloat(subcontractorPaymentRaw);

    if (!isNaN(subcontractorPayment)) {
        updatedFields["Subcontractor Payment"] = subcontractorPayment; // ✅ Send pure number
    } else {
        updatedFields["Subcontractor Payment"] = null; // or 0 if you prefer
    }
}

// ⬇️ Airtable update happens after logging
await updateAirtableRecord(window.env.AIRTABLE_TABLE_NAME, warrantyId, updatedFields);

formHasUnsavedChanges = false;

        const inputs = document.querySelectorAll("input:not([disabled]), textarea:not([disabled]), select:not([disabled])");

        inputs.forEach(input => {

            const fieldName = input.getAttribute("data-field");
            if (!fieldName) return;
        
            // 🛑 SKIP this field because we already handled it correctly above
            if (fieldName === "Subcontractor Payment") return; 
        
            if (input.name === "billable-status") return;
        
            let value = input.value.trim();
        
            if (input.type === "checkbox") {
                value = input.checked;
            } else if (input.tagName === "SELECT") {
                if (value === "") return;
            }
            else if (input.type === "number") {
                value = value === "" || isNaN(value) ? null : parseFloat(value);
            } else if (input.type === "date") {
                value = formatDateToISO(value);
            } else {
                value = value === "" ? null : value;
            }
        
            updatedFields[fieldName] = value;
        });
        
        // Clean empty strings to nulls (avoid Airtable errors)
        for (let key in updatedFields) {
            const value = updatedFields[key];
        
            if (value === "") updatedFields[key] = null;
            if (typeof value === "undefined") delete updatedFields[key];
            if (typeof value === "number" && isNaN(value)) delete updatedFields[key];
        }
            
        if (Object.keys(updatedFields).length === 0) {
            alert("No changes detected.");
            return;
        }
    
        try {
            // ✅ Update Airtable with cleaned values
            await updateAirtableRecord(window.env.AIRTABLE_TABLE_NAME, warrantyId, updatedFields);
            window.scrollTo({ top: scrollPosition, behavior: "instant" });

            const debugStartDate = safeToISOString(document.getElementById("StartDate")?.value);
            
            showToast("✅ Job details saved successfully!", "success");
    
           // ✅ Refresh UI after save to reflect correct date format
           await new Promise(resolve => setTimeout(resolve, 3000)); // ⏳ wait 3 seconds for automation

           const updatedData = await fetchAirtableRecord(window.env.AIRTABLE_TABLE_NAME, warrantyId);
           
           if (updatedData && updatedData.fields) {
               await populatePrimaryFields(updatedData.fields);
           
               const statusRaw = updatedData.fields["Status"];
               const status = (statusRaw || "").trim().toLowerCase();
           
                              const redirectStatuses = [
                                "pending review",
                                "customer review needed",
                                "material purchase needed",
                                "subcontractor to pay",
                                "ready to invoice",
                                "completed",
                                "confirmed"
                            ];
                            
                            const noLongerNeedsFieldTech = ![
                                "field tech review needed",
                                "scheduled awaiting field technician",
                                "scheduled- awaiting field"
                            ].includes(status);
                            
                            if (redirectStatuses.includes(status) || noLongerNeedsFieldTech) {
                                showToast("success", 4000);
                                setTimeout(() => {
                                    window.location.href = "index.html";
                                }, 4000);
                                return;
                            }
           }
        } catch (error) {
            console.error("❌ Error updating Airtable:", error);
        }
    });
    
function formatDateToISO(dateStr) {
        if (!dateStr) return ""; // If empty, return blank
    
        const dateObj = new Date(dateStr);
        if (isNaN(dateObj.getTime())) {
            console.error("❌ Invalid date format:", dateStr);
            return ""; // Return empty if invalid
        }
    
        return dateObj.toISOString().split("T")[0]; // Convert to 'YYYY-MM-DD'
    }
    
   // 🔹 Fetch Dropbox Token from Airtable
async function fetchDropboxToken() {
    try {
        const url = `https://api.airtable.com/v0/${airtableBaseId}/tbl6EeKPsNuEvt5yJ?maxRecords=1`;
        const response = await fetchWithRetry(url, {
            headers: { Authorization: `Bearer ${airtableApiKey}` }
        });

        if (!response.ok) {
            throw new Error(`❌ Error fetching Dropbox token: ${response.statusText}`);
        }

        const data = await response.json();
        const record = data.records[0];

        if (!record) {
            console.error("❌ No record found in Airtable view.");
            return null;
        }

        const fields = record.fields;

        dropboxAppKey = fields["Dropbox App Key"];
        dropboxAppSecret = fields["Dropbox App Secret"];
        const token = fields["Dropbox Token"];
        const refreshToken = fields["Dropbox Refresh Token"];
        dropboxRefreshToken = fields["Dropbox Refresh Token"]; 

        if (!dropboxAppKey || !dropboxAppSecret) {
            console.error("❌ Dropbox App Key or Secret is missing.");
            return null;
        }

        // 🛠 If access token is present, use it
        if (token) {
            dropboxAccessToken = token;
            return dropboxAccessToken;
        }

        // 🛠 If no token, try to refresh it
        if (refreshToken) {
            return await refreshDropboxAccessToken(refreshToken, dropboxAppKey, dropboxAppSecret);
        }

        return null;

    } catch (error) {
        console.error("❌ Error fetching Dropbox token:", error);
        return null;
    }
}
 
async function refreshDropboxAccessToken(refreshToken, dropboxAppKey, dropboxAppSecret) {
    const dropboxAuthUrl = "https://api.dropboxapi.com/oauth2/token";

    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", refreshToken);
    params.append("client_id", dropboxAppKey);
    params.append("client_secret", dropboxAppSecret);

    try {
        const response = await fetchWithRetry(dropboxAuthUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params
        });

        const data = await response.json();

        if (!response.ok) {
            console.error(`❌ Error refreshing Dropbox token:`, data);
            return null;
        }

        dropboxAccessToken = data.access_token;

        // ✅ Update Airtable with the new token
        const tokenUpdateUrl = `https://api.airtable.com/v0/${window.env.AIRTABLE_BASE_ID}/tbl6EeKPsNuEvt5yJ?maxRecords=1`;
        const tokenResponse = await fetch(tokenUpdateUrl, {
            headers: {
                Authorization: `Bearer ${window.env.AIRTABLE_API_KEY}`
            }
        });

        const tokenData = await tokenResponse.json();
        const recordId = tokenData.records?.[0]?.id;

        if (!recordId) {
            return dropboxAccessToken;
        }

        // Update Airtable record with the new token
        const patchUrl = `https://api.airtable.com/v0/${window.env.AIRTABLE_BASE_ID}/tbl6EeKPsNuEvt5yJ/${recordId}`;
        await fetch(patchUrl, {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${window.env.AIRTABLE_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                fields: {
                    "Dropbox Token": dropboxAccessToken
                }
            })
        });

        return dropboxAccessToken;

    } catch (error) {
        console.error("❌ Error refreshing Dropbox access token:", error);
        return null;
    }
}

function convertUTCToLocalInput(utcDateString) {
        if (!utcDateString) return "";
        const utcDate = new Date(utcDateString);
        const offsetMs = utcDate.getTimezoneOffset() * 60000;
        const localDate = new Date(utcDate.getTime() - offsetMs);
        return localDate.toISOString().slice(0, 16); // "YYYY-MM-DDTHH:MM"
    }
       
    // 🔹 Dropbox Image Upload
let uploadInProgress = false; // Global flag for unload warning

async function uploadToDropbox(files, targetField) {
    if (!dropboxAccessToken) {
        console.error("❌ Dropbox token is missing.");
        return;
    }

    uploadInProgress = true;

    const warrantyId = getWarrantyId();
    const existingImages = await fetchCurrentImagesFromAirtable(warrantyId, targetField) || [];
    const uploadedUrls = [...existingImages];
    const creds = { appKey: dropboxAppKey, appSecret: dropboxAppSecret, refreshToken: dropboxRefreshToken };

    // ⏳ Show and reset progress UI
    const progressContainer = document.getElementById("upload-progress-container");
    const progressBar = document.getElementById("upload-progress-bar");
    const progressLabel = document.getElementById("upload-progress-label");
    progressContainer.style.display = "block";
    progressBar.style.width = "0%";
    progressLabel.textContent = "Starting upload...";

    let completed = 0;
    const total = files.length;

  for (let index = 0; index < files.length; index++) {
  const file = files[index];
  try {
    progressLabel.textContent = `Compressing (${index + 1} of ${files.length})...`;
    const compressedFile = await compressImage(file);

    progressLabel.textContent = `Uploading (${index + 1} of ${files.length})...`;
    const dropboxUrl = await uploadFileToDropbox(compressedFile, dropboxAccessToken, creds);

    if (dropboxUrl) {
      const uploadedFile = {
        url: dropboxUrl,
        filename: file.name || "upload.png",
      };
      uploadedUrls.push(uploadedFile);

      await displayImages(
        [uploadedFile],
        targetField === "Completed  Pictures" ? "completed-pictures" : "issue-pictures",
        targetField
      );
    }

    const percent = Math.round(((index + 1) / files.length) * 100);
    progressBar.style.width = `${percent}%`;
  } catch (error) {
    console.error(`❌ Upload failed for ${file.name}:`, error);
    showToast(`❌ Failed to upload ${file.name}`, "error");
  }
}
   const latestFromAirtable = await fetchCurrentImagesFromAirtable(warrantyId, targetField);
const combinedList = [...latestFromAirtable];

// Add only unique new files (by URL)
for (const newFile of uploadedUrls) {
  if (!combinedList.some(f => f.url === newFile.url)) {
    combinedList.push(newFile);
  }
}

await updateAirtableRecord(window.env.AIRTABLE_TABLE_NAME, warrantyId, {
  [targetField]: combinedList
});

uploadInProgress = false;
checkAndHideDeleteButton();

progressBar.style.width = `100%`;
progressLabel.textContent = "✅ Upload complete!";
setTimeout(() => {
    progressContainer.style.display = "none";
}, 2000);

showToast("✅ All files uploaded successfully!", "success");

// ✅ Immediate refresh (may be too early if Airtable hasn’t propagated)
refreshImageContainers();

// ✅ Delayed refresh to catch full Airtable sync
setTimeout(() => {
    refreshImageContainers();
}, 3000);
}

async function compressImage(file) {
    const options = {
        maxSizeMB: 1,
        maxWidthOrHeight: 1600,
        useWebWorker: true
    };

    try {
        if (file.type.startsWith("image/")) {
            const compressed = await window.imageCompression(file, options);
            return compressed;
        } else {
            return file; // Skip non-image
        }
    } catch (err) {
        console.error("❌ Image compression failed:", err);
        return file;
    }
}

   // 🔹 Upload File to Dropbox
async function uploadFileToDropbox(file, token, creds = {}, attempt = 1) {
    if (!token) {
        console.error("❌ No Dropbox token provided.");
        return null;
    }

    const dropboxUploadUrl = "https://content.dropboxapi.com/2/files/upload";
    const path = `/uploads/${encodeURIComponent(file.name)}`;

    try {
        const response = await fetchWithRetry(dropboxUploadUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${token}`,
                "Dropbox-API-Arg": JSON.stringify({
                    path: path,
                    mode: "add",
                    autorename: true,
                    mute: false
                }),
                "Content-Type": "application/octet-stream"
            },
            body: file
        });

        if (response.status === 429) {
            const delayMs = Math.pow(2, attempt) * 1000; // exponential backoff

            if (attempt <= 5) {
                await new Promise(res => setTimeout(res, delayMs));
                return await uploadFileToDropbox(file, token, creds, attempt + 1);
            } else {
                console.error("❌ Max retry attempts reached for rate limiting.");
                return null;
            }
        }

        if (!response.ok) {
            const errorResponse = await response.json();
            console.error("❌ Dropbox Upload Error:", errorResponse);

            const tag = errorResponse?.error?.[".tag"];
            if (
                tag === "expired_access_token" ||
                errorResponse?.error_summary?.startsWith("expired_access_token")
            ) {
                // Refresh the token
                await refreshDropboxAccessToken(creds.refreshToken, creds.appKey, creds.appSecret);
                const newToken = await fetchDropboxToken();

                if (newToken) {
                    return await uploadFileToDropbox(file, newToken, creds); // Recursive retry
                }
            }

            return null;
        }

        const data = await response.json();
        return await getDropboxSharedLink(data.path_lower);

    } catch (error) {
        console.error("❌ Error during Dropbox upload:", error);
        return null;
    }
}

window.addEventListener("beforeunload", function (e) {
    if (uploadInProgress) {
        e.preventDefault();
        e.returnValue = "Uploads are still in progress. Are you sure you want to leave?";
        return "Uploads are still in progress. Are you sure you want to leave?";
    }

    if (formHasUnsavedChanges) {
        e.preventDefault();
        e.returnValue = "You have unsaved changes. Are you sure you want to leave?";
        return "You have unsaved changes. Are you sure you want to leave?";
    }
});
    // 🔹 Get Dropbox Shared Link
  async function getDropboxSharedLink(filePath) {
  const url = "https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings";

  try {
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dropboxAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        path: filePath,
        settings: {
          requested_visibility: "public"
        }
      })
    });

    if (response.status === 409) {
      return await getExistingDropboxLink(filePath); // 🧠 Fallback handler
    }

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Dropbox shared link error: ${errorData?.error_summary || response.statusText}`);
    }

    const data = await response.json();
    return convertToDirectLink(data.url);

  } catch (error) {
    console.error("Dropbox link error:", error);
    return null;
  }
}

function updateCalendarSpanWithDivision(division) {
  const span = document.getElementById('divisionNameSpan');
  const link = document.getElementById('calendarLink');

  if (!span || !link) return;


  if (division && division !== '__show_all__') {
    span.textContent = `${division}`; // ✅ no parentheses
    const encodedDivision = encodeURIComponent(division);
    link.href = `https://calendar.vanirinstalledsales.info/personal-calendars.html?division=${encodedDivision}`;
  } else {
    span.textContent = '';
    link.href = `https://calendar.vanirinstalledsales.info/personal-calendars.html`;
  }
}

async function fetchAndPopulateSubcontractors(resolvedRecordId) {
    
        const airtableBaseId = window.env.AIRTABLE_BASE_ID;
        const primaryTableId = "tbl6EeKPsNuEvt5yJ"; // Table where `b` and `Subcontractor` are stored
        const subcontractorTableId = "tbl9SgC5wUi2TQuF7"; // Subcontractor Table
    
        if (!resolvedRecordId) {
            console.error("❌ Record ID is missing.");
            return;
        }
    
        try {
            // 1️⃣ Fetch primary record
            const primaryUrl = `https://api.airtable.com/v0/${airtableBaseId}/${primaryTableId}/${resolvedRecordId}`;
    
            const primaryResponse = await fetch(primaryUrl, {
                headers: { Authorization: `Bearer ${window.env.AIRTABLE_API_KEY}` }
            });
    
            if (!primaryResponse.ok) {
                throw new Error(`❌ Error fetching primary record: ${primaryResponse.statusText}`);
            }
    
            const primaryData = await primaryResponse.json();
            const branchB = primaryData.fields?.b;
            updateCalendarSpanWithDivision(branchB); // ✅ Add this here

            const currentSubcontractor = primaryData.fields?.Subcontractor;
    
            if (!branchB) {
                return;
            }
        
            // 2️⃣ Fetch subcontractors for this branch
            let allSubcontractors = await fetchAllSubcontractors(airtableBaseId, subcontractorTableId, branchB);
    
            // 3️⃣ If the current subcontractor isn't in the list, add it manually
            const namesOnly = allSubcontractors.map(sub => sub.name);
            if (currentSubcontractor && !namesOnly.includes(currentSubcontractor)) {
                allSubcontractors.push({
                    name: currentSubcontractor,
                    vanirOffice: "Previously Selected"
                });
            }
    
// 4️⃣ Populate dropdown with updated list
populateSubcontractorDropdown(allSubcontractors, currentSubcontractor);

// ✅ Update the calendar span with division
    
        } catch (error) {
            console.error("❌ Error fetching subcontractors:", error);
        }
    }
    
    // 🔹 Function to fetch all subcontractors (Handles offsets)
async function fetchAllSubcontractors(baseId, tableId, branchB) {
        let allRecords = [];
        let offset = null;
    
        do {
            let url = `https://api.airtable.com/v0/${baseId}/${tableId}?filterByFormula=${encodeURIComponent(`{Vanir Branch} = '${branchB}'`)}&fields[]=Subcontractor Company Name&fields[]=Vanir Branch`;
            if (offset) {
                url += `&offset=${offset}`;
            }
        
            const response = await fetchWithRetry(url, {
                headers: { Authorization: `Bearer ${window.env.AIRTABLE_API_KEY}` }
            });
    
            if (!response.ok) {
                throw new Error(`❌ Error fetching subcontractors: ${response.statusText}`);
            }
    
            const data = await response.json();
            allRecords.push(...data.records);
    
            // If Airtable returns an offset, we need to fetch more records
            offset = data.offset || null;
    
        } while (offset);
        
        return allRecords.map(record => ({
            name: record.fields['Subcontractor Company Name'] || 'Unnamed Subcontractor',
            vanirOffice: record.fields['Vanir Branch'] || 'Unknown Branch'
        }));
    }
    
async function getExistingDropboxLink(filePath) {
  const url = "https://api.dropboxapi.com/2/sharing/list_shared_links";

  try {
    const response = await fetchWithRetry(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${dropboxAccessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        path: filePath,
        direct_only: true
      })
    });

    if (!response.ok) {
      throw new Error(`Error listing existing shared links: ${response.statusText}`);
    }

    const data = await response.json();
    if (data.links && data.links.length > 0) {
      return convertToDirectLink(data.links[0].url);
    } else {
      return null;
    }
  } catch (error) {
    console.error("❌ Error fetching existing Dropbox link:", error);
    return null;
  }
}

function convertToDirectLink(sharedUrl) {
        if (sharedUrl.includes("dropbox.com")) {
            return sharedUrl.replace("www.dropbox.com", "dl.dropboxusercontent.com").replace("?dl=0", "?raw=1");
        }
        return sharedUrl;
    }
    
    document.getElementById("subcontractor-dropdown").addEventListener("change", function () {
        const selectedValue = this.value.trim().toLowerCase();    
        const paymentContainer = document.getElementById("subcontractor-payment-container");
        const subNotNeededCheckbox = document.getElementById("sub-not-needed");
    
        if (selectedValue === "sub not needed") {
            // Only check box and hide payment if value is "Sub Not Needed"
            if (paymentContainer) paymentContainer.style.display = "none";
            if (subNotNeededCheckbox) subNotNeededCheckbox.checked = true;
        } else {
            // Uncheck the box and show payment input
            if (paymentContainer) paymentContainer.style.display = "";
            if (subNotNeededCheckbox) subNotNeededCheckbox.checked = false;
        }
    });
    
    function populateSubcontractorDropdown(subcontractors, currentSelection = "") {
    
        const existing = document.getElementById("subcontractor-dropdown");
    
        const parent = existing?.parentElement;
        if (!parent) {
            console.error("❌ Subcontractor dropdown element not found.");
            return;
        }

        // Create input field
        const input = document.createElement("input");
        input.setAttribute("list", "subcontractor-options");
        input.setAttribute("id", "subcontractor-dropdown");
        input.setAttribute("placeholder", "Select or type subcontractor...");
        input.setAttribute("data-field", "Subcontractor"); 

        input.style.width = "100%";
        input.style.padding = "10px";
        input.style.borderRadius = "5px";
        input.style.border = "1px solid #ccc";
        input.value = currentSelection;
    
        parent.replaceChild(input, existing);
    
        // Create datalist
        let dataList = document.getElementById("subcontractor-options");
        if (!dataList) {
            dataList = document.createElement("datalist");
            dataList.id = "subcontractor-options";
            document.body.appendChild(dataList);
        } else {
            dataList.innerHTML = ""; 
        }
    
        // Add "Sub Not Needed" at the top
        const subNotNeeded = document.createElement("option");
        subNotNeeded.value = "Sub Not Needed";
        subNotNeeded.label = "Sub Not Needed (Manual Entry)";
        dataList.appendChild(subNotNeeded);
    
        // Sort and fill datalist with unique options
        const added = new Set();
        const sortedSubs = subcontractors
            .filter(sub => sub.name && sub.name !== "Sub Not Needed")
            .sort((a, b) => a.name.localeCompare(b.name));
    
        sortedSubs.forEach(({ name, vanirOffice }) => {
            if (added.has(name)) return;
    
            const option = document.createElement("option");
            option.value = name;
            option.label = name === currentSelection
                ? `⭐ ${name} `
                : `${name} `;
    
            dataList.appendChild(option);
            added.add(name);
        });
    }
        
    // ✅ Call this function when the page loads
    document.addEventListener('DOMContentLoaded', populateSubcontractorDropdown);

    function setCheckboxValue(id, value) {
        const element = document.getElementById(id);
        if (element) {
            element.checked = Boolean(value);
        }
    }
});

let vendorIdMap = {};

async function fetchVendors() {
    const apiKey = 'patCnUsdz4bORwYNV.5c27cab8c99e7caf5b0dc05ce177182df1a9d60f4afc4a5d4b57802f44c65328';
    const baseId = 'appO21PVRA4Qa087I';
    const tableId = 'tblHZqptShyGhbP5B';
    const view = 'viwioQYJrw5ZhmfIN';
  
    const url = `https://api.airtable.com/v0/${baseId}/${tableId}?view=${view}`;
    const headers = { Authorization: `Bearer ${apiKey}` };
  
    try {
      const response = await fetchWithRetry(url, { headers });
      const data = await response.json();
  
      const dropdown = document.getElementById("vendor-dropdown");
      if (!dropdown) return;
  
      dropdown.innerHTML = '<option value="">Select a Vendor...</option>';
      vendorIdMap = {}; // reset
  
      data.records.forEach(record => {
        const name = record.fields["Name"];
        if (name) {
          vendorIdMap[name] = record.id;
  
          const option = document.createElement("option");
          option.value = name;
          option.textContent = name;
          dropdown.appendChild(option);
        }
      });
  
      return vendorIdMap;
    } catch (error) {
      console.error("❌ Error fetching vendors:", error);
    }
  }
  
async function populateVendorDropdownWithSelection(possibleId) {
  const dropdown = document.getElementById("vendor-dropdown");
  if (!dropdown) {
    console.error("❌ Vendor dropdown element not found!");
    return;
  }

  let recordId = String(possibleId || "").trim();

  if (!recordId) {
    console.error("❌ No record ID or Warranty ID provided.");
    return;
  }

  if (!recordId.startsWith("rec")) {
    recordId = await getRecordIdByWarrantyId(recordId);
    if (!recordId) {
      console.error("❌ Could not resolve Record ID from Warranty ID:", possibleId);
      return;
    }
  } else {
  }

  // 1. Fetch the current record to get the selected vendor (if any)
  const currentRecordUrl = `https://api.airtable.com/v0/${window.env.AIRTABLE_BASE_ID}/tbl6EeKPsNuEvt5yJ/${recordId}`;
  const headers = {
    Authorization: `Bearer ${window.env.AIRTABLE_API_KEY}`
  };

  let selectedVendorId = null;

  try {
    const response = await fetchWithRetry(currentRecordUrl, { headers });
    const data = await response.json();

    const vendorField = data.fields["Material Vendor"];
    if (Array.isArray(vendorField) && vendorField.length > 0) {
      selectedVendorId = vendorField[0]; // ID of linked vendor
    } else {
    }
  } catch (error) {
    console.error("❌ Failed to fetch current record:", error);
  }

  // 2. Fetch all vendors, handling pagination
  let allVendors = [];
  let offset = null;
  let fetchCount = 0;

  dropdown.innerHTML = `<option value="">Select a Vendor...</option>`;

  do {
    let url = `https://api.airtable.com/v0/${window.env.AIRTABLE_BASE_ID}/tblHZqptShyGhbP5B?view=viwioQYJrw5ZhmfIN`;
    if (offset) url += `&offset=${offset}`;
    try {
      const vendorResponse = await fetch(url, { headers });
      const vendorData = await vendorResponse.json();
      allVendors = allVendors.concat(vendorData.records);
      offset = vendorData.offset;
      fetchCount++;
    } catch (error) {
      console.error("❌ Failed to fetch vendor list:", error);
      break;
    }
  } while (offset);

  // 🔤 Sort vendors alphabetically by name (case-insensitive)
  allVendors.sort((a, b) => {
    const nameA = (a.fields["Name"] || "").toLowerCase();
    const nameB = (b.fields["Name"] || "").toLowerCase();
    return nameA.localeCompare(nameB);
  });

  // 3. Add all vendors to dropdown
  allVendors.forEach(vendor => {
    const option = document.createElement("option");
    option.value = vendor.id;
    option.textContent = vendor.fields["Name"] || "(No name)";
    if (vendor.id === selectedVendorId) {
      option.selected = true;
    } else {
    }
    dropdown.appendChild(option);
  });

  // Remove duplicate vendors by ID
const seen = new Set();
allVendors = allVendors.filter(vendor => {
  if (seen.has(vendor.id)) return false;
  seen.add(vendor.id);
  return true;
});

if (window.vendorChoices) {
  window.vendorChoices.destroy(); // Cleanup if already initialized
}
window.vendorChoices = new Choices('#vendor-dropdown', {
  searchEnabled: true,
  itemSelectText: '',
  shouldSort: false // Already sorted by your JS
});
}

window.vendorChoices = new Choices('#vendor-dropdown', {
  searchEnabled: true,
  itemSelectText: '',
  shouldSort: false
});

document.getElementById('vendor-dropdown').addEventListener('showDropdown', function() {
  // Focus the search input inside the Choices container
  setTimeout(() => {
    const input = document.querySelector('.choices__input--cloned');
    if (input) input.focus();
  }, 0);
});

  async function updateAirtableRecord(tableName, lotNameOrRecordId, fields) {

    const saveButton = document.getElementById("save-job");
    if (saveButton) saveButton.disabled = true;

    if (!navigator.onLine) {
        console.error("❌ No internet connection detected.");
        showToast("❌ You are offline. Please check your internet connection and try again.", "error");
        if (saveButton) saveButton.disabled = false;
        return;
    }

    try {
        let resolvedRecordId = lotNameOrRecordId;
        if (!resolvedRecordId.startsWith("rec")) {
            resolvedRecordId = await getRecordIdByWarrantyId(lotNameOrRecordId);
            if (!resolvedRecordId) {
                console.error("❌ Could not resolve Record ID for:", lotNameOrRecordId);
                return;
            }
        }

        const vendorDropdown = document.getElementById("vendor-dropdown");
        const selectedVendorId = vendorDropdown?.value?.trim();

        if (selectedVendorId && selectedVendorId.startsWith("rec")) {
            fields["Material Vendor"] = [selectedVendorId];
        }

        const url = `https://api.airtable.com/v0/${window.env.AIRTABLE_BASE_ID}/${tableName}/${resolvedRecordId}`;

        const sanitizedFields = Object.fromEntries(
            Object.entries(fields).filter(([key]) =>
                key !== "Warranty Record ID"
            )
        );

        const response = await fetchWithRetry(url, {
            method: "PATCH",
            headers: {
                Authorization: `Bearer ${window.env.AIRTABLE_API_KEY}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ fields: sanitizedFields })
        });

        if (!response.ok) {
            let errorDetails;
            try {
                errorDetails = await response.json();
            } catch (jsonErr) {
                console.error("❌ Failed to parse Airtable error JSON:", jsonErr);
                const text = await response.text();
                console.error("📄 Raw response body:", text);
                showToast("❌ Error updating Airtable: Unable to parse error response", "error");
                return;
            }
            showToast(`❌ Airtable error: ${errorDetails.error?.message || 'Unknown error'}`, "error");
            return;
        }

        showToast("✅ Record updated successfully!", "success");

    } catch (error) {
        console.error("❌ Error updating Airtable:", error);
    } finally {
        if (saveButton) saveButton.disabled = false;
    }
}

document.addEventListener("DOMContentLoaded", function () {
  const materialSelect = document.getElementById("material-needed-select");
  const materialsTextarea = document.getElementById("materials-needed");
  const textareaContainer = document.getElementById("materials-needed-container");

    // Show/hide textarea when user changes selection with confirmation
    materialSelect.addEventListener("change", function () {

    if (this.value === "Needs Materials") {
      textareaContainer.style.display = "block";
    } else if (this.value === "Do Not Need Materials") {
      if (materialsTextarea.value.trim() !== "") {
        const confirmed = confirm("⚠️ You have entered materials. Do you want to clear them?");
        if (confirmed) {
          materialsTextarea.value = "";
          textareaContainer.style.display = "none";
        } else {
          this.value = "Needs Materials";
          textareaContainer.style.display = "block"; // show again in case it was hidden
        }
      } else {
        textareaContainer.style.display = "none";
      }
    }
  });
});

    document.getElementById("trigger-issue-upload").addEventListener("click", () => {
      document.getElementById("upload-issue-picture").click();
    });
  
    document.getElementById("trigger-completed-upload").addEventListener("click", () => {
      document.getElementById("upload-completed-picture").click();
    });

    document.addEventListener("DOMContentLoaded", function () {
    const subcontractorPaymentInput = document.getElementById("subcontractor-payment");

    if (subcontractorPaymentInput) {
        subcontractorPaymentInput.addEventListener("input", function (e) {
            let value = e.target.value;

            // 🧹 Allow user to type $ but clean extra $ if multiple
            value = value.replace(/[^\d.]/g, ""); // remove everything except digits and decimal

            // 🛡 Prevent multiple decimals
            const parts = value.split(".");
            if (parts.length > 2) {
                value = parts[0] + "." + parts[1];
            }

            // 🌟 Always format with a single $
            e.target.value = value ? `$${value}` : "";
        });

        subcontractorPaymentInput.addEventListener("blur", function (e) {
            let value = e.target.value.replace(/[^\d.]/g, ""); // Remove $ and commas

            if (value) {
                value = parseFloat(value).toFixed(2);
                e.target.value = `$${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            } else {
                e.target.value = "";
            }
        });

        subcontractorPaymentInput.addEventListener("focus", function (e) {
            let value = e.target.value.replace(/[^\d.]/g, ""); // Remove $ when focusing
            e.target.value = value;
        });
    }
});

  document.addEventListener("DOMContentLoaded", function () {
          const jobNameElement = document.getElementById("field-tech");
          if (jobNameElement) {
            document.getElementById("field-tech").addEventListener("click", function () {
    const techName = document.getElementById("field-tech")?.value?.trim();
    if (!techName) {
        alert("⚠️ No field tech name available.");
        return;
    }
    const encodedName = encodeURIComponent(techName);
    window.location.href = `http://localhost:5501/index.html?techs=${encodedName}`;
});
          } else {
          }
      });
      
  async function fetchVendors() {
    const apiKey = 'patCnUsdz4bORwYNV.5c27cab8c99e7caf5b0dc05ce177182df1a9d60f4afc4a5d4b57802f44c65328';
    const baseId = 'appeNSp44fJ8QYeY5';
    const tableName = 'tblLEYdDi0hfD9fT3';
    const view = 'viw8m7cAu6Oao2WiK';

    const url = `https://api.airtable.com/v0/${baseId}/${tableName}?view=${view}`;
    const headers = {
        Authorization: `Bearer ${apiKey}`
    };

    try {
        const response = await fetchWithRetry(url, { headers });
        const data = await response.json();

        const dropdown = document.getElementById("vendor-dropdown");

        if (!dropdown) {
            console.warn("⚠️ vendor-dropdown not found.");
            return;
        }

        data.records.forEach(record => {
            const name = record.fields["Name"];
            if (name) {
                const option = document.createElement("option");
                option.value = name;
                option.textContent = name;
                dropdown.appendChild(option);
            }
        });
    } catch (error) {
        console.error("❌ Error fetching vendors:", error);
    }
}

document.addEventListener("DOMContentLoaded", fetchVendors);

let hasUnsavedChanges = false;

// Mark form as dirty if anything changes
document.getElementById('job-form').addEventListener('input', () => {
  hasUnsavedChanges = true;
});

// Swipe detection
let touchStartX = 0;
let touchEndX = 0;

document.addEventListener('touchstart', function (e) {
  touchStartX = e.changedTouches[0].screenX;
}, false);

document.addEventListener('touchend', function (e) {
  touchEndX = e.changedTouches[0].screenX;
  handleSwipeGesture();
}, false);


function handleSwipeGesture() {
  if (!globalSwipeEnabled) return; // 🚫 ignore if carousel is open
  const swipeThreshold = 100;
  if (touchStartX - touchEndX > swipeThreshold) {
    if (hasUnsavedChanges) {
      const confirmLeave = confirm('Swiped left, You have unsaved changes. Leave page?');
      if (!confirmLeave) return;
    }
    window.location.href = 'index.html';
  }
}

function handleHomeownerClick() {
  const number = document.getElementById("homeowner-number").value;
  if (number) {
    // Or open dialer:
    const sanitized = number.replace(/[^\d+]/g, ""); // Keep digits and +

     window.location.href = `tel:${number}`;
  }
}

 document.addEventListener('DOMContentLoaded', () => {
    const container = document.getElementById('job-completed-container');
    const checkbox = document.getElementById('job-completed-checkbox');

    container.addEventListener('click', (event) => {
      // Avoid toggling twice if user clicks the checkbox directly
      if (event.target.tagName.toLowerCase() !== 'input') {
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event('change')); // If you have any listeners on change
      }
    });
  });

    // For every trash icon inside .file-wrapper
document.querySelectorAll('.file-wrapper .trash-icon').forEach(icon => {
  icon.addEventListener('click', function(e) {
    e.stopPropagation();
    const wrapper = this.closest('.file-wrapper');
    const checkbox = wrapper.querySelector('.image-checkbox');
    checkbox.checked = !checkbox.checked;
    wrapper.classList.toggle('checked', checkbox.checked);
  });
});

window.nextImage = function () {
  if (!Array.isArray(currentCarouselFiles) || currentCarouselFiles.length === 0) return;

  currentCarouselIndex = (currentCarouselIndex + 1) % currentCarouselFiles.length;
  displayCarouselItem(currentCarouselIndex);
};

window.prevImage = function () {
  if (!Array.isArray(currentCarouselFiles) || currentCarouselFiles.length === 0) return;

  currentCarouselIndex = (currentCarouselIndex - 1 + currentCarouselFiles.length) % currentCarouselFiles.length;
  displayCarouselItem(currentCarouselIndex);
};

  // Auto-resize helper: sets the textarea height to match its content
    function autoResizeTextarea(el) {
      if (!el) return;
      // Reset height so scrollHeight is measured from natural content height
      el.style.height = 'auto';
      // Set to the full content height (includes padding due to border-box)
      el.style.height = el.scrollHeight + 'px';
    }

    // Call this right after you set the value from Airtable
    function setDescription(text) {
      const ta = document.getElementById('description');
      ta.value = text || '';
      autoResizeTextarea(ta);
    }

    // If there’s initial content server-side, size on load too
    window.addEventListener('load', () => {
      const ta = document.getElementById('description');
      autoResizeTextarea(ta);

      // Reflow if fonts load later (helps when using web fonts)
      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => autoResizeTextarea(ta)).catch(() => {});
      }

      // Recalculate on window resize (line wrapping can change)
      window.addEventListener('resize', () => autoResizeTextarea(ta));
    });
