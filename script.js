document.addEventListener('DOMContentLoaded', async () => {
  const env = window.env || {};
  const airtableApiKey = env.AIRTABLE_API_KEY;
  const airtableBaseId = env.AIRTABLE_BASE_ID;
  const airtableTableName = env.AIRTABLE_TABLE_NAME;

  if (!airtableApiKey || !airtableBaseId || !airtableTableName) {
    console.error('❌ Airtable credentials are missing');
    return;
  }

  const mainContent = document.getElementById('main-content');
  const secondaryContent = document.getElementById('secoundary-content');

  setupFilterMenu();
  setupSearchInput();
  setupJumpLinkObserver();
  setupClearFilters();
  fetchDataAndInitialize();

  function setupFilterMenu() {
    const urlParams = new URLSearchParams(window.location.search);
    const urlTechs = urlParams.get('techs');

    // ✅ Accept URL-provided filters (already URL-decoded by URLSearchParams)
    // ✅ Never store "All" and never store empty strings
    if (urlTechs) {
      const techArray = urlTechs
        .split(',')
        .map(t => t.trim())
        .filter(t => t && t.toLowerCase() !== 'all');
      localStorage.setItem("selectedFilters", JSON.stringify(techArray));
    } else {
      // If URL has no techs param, treat as "All" (show everything)
      localStorage.setItem("selectedFilters", JSON.stringify([])); // empty = All
    }

    const menuToggle = document.getElementById('menu-toggle');
    const checkboxContainer = document.getElementById('checkbox-container');

    // 🔄 Toggle visibility on button click
    menuToggle.addEventListener('click', () => {
      checkboxContainer.classList.toggle('show');
    });

    // ❌ Close on click outside
    document.addEventListener('click', (event) => {
      if (!checkboxContainer.contains(event.target) && !menuToggle.contains(event.target)) {
        checkboxContainer.classList.remove('show');
      }
    });

    // ❌ Close on scroll
    window.addEventListener('scroll', () => {
      if (checkboxContainer.classList.contains('show')) {
        checkboxContainer.classList.remove('show');
      }
    });
  }

  function setupSearchInput() {
    const input = document.getElementById('search-input');
    input.addEventListener('input', () => {
      const searchValue = input.value.toLowerCase();
      const isSearching = searchValue.trim() !== '';

      ['#airtable-data', '#feild-data'].forEach(tableSelector => {
        const rows = document.querySelectorAll(`${tableSelector} tbody tr`);
        let visibleCount = 0;

        rows.forEach(row => {
          const warrantyId = row.getAttribute('data-warranty-id')?.toLowerCase() || '';
          const cellMatch = Array.from(row.cells).some(cell =>
            cell.textContent.toLowerCase().includes(searchValue)
          );
          const match = cellMatch || warrantyId.includes(searchValue);
          row.style.display = match ? '' : 'none';

          // Unmerge: show all cells individually
          const firstCell = row.cells[0];
          if (firstCell) {
            firstCell.style.display = '';
            firstCell.removeAttribute('rowspan');
          }

          if (match) visibleCount++;
        });

        // ✅ Hide entire content section if no visible rows
        const section = tableSelector === '#airtable-data'
          ? document.getElementById('main-content')
          : document.getElementById('secoundary-content');
        section.style.display = visibleCount > 0 ? 'block' : 'none';

        // ✅ Restore merged cells only if not searching
        if (!isSearching) {
          mergeTableCells(tableSelector, 0);
        }
      });
    });
  }

  function setupJumpLinkObserver() {
    const secondaryContent = document.getElementById("secoundary-content");
    const jumpLink = document.querySelector(".jump-link");
    const toggleJumpLinkVisibility = () => {
      const isHidden = !secondaryContent.offsetParent;
      jumpLink.style.display = isHidden ? "none" : "inline";
    };

    toggleJumpLinkVisibility();

    if (secondaryContent) {
      new MutationObserver(toggleJumpLinkVisibility).observe(secondaryContent, {
        attributes: true,
        attributeFilter: ['style', 'class']
      });
    }
  }

  function setupClearFilters() {
    const btn = document.getElementById('clear-filters');
    btn.addEventListener('click', () => {
      // ✅ Clearing goes back to "All"
      localStorage.setItem('selectedFilters', JSON.stringify([]));
      document.querySelectorAll('.filter-checkbox').forEach(cb => cb.checked = false);
      const allCheckbox = document.querySelector('.filter-checkbox[value="All"]');
      if (allCheckbox) allCheckbox.checked = true;
      updateURLWithFilters([]); // will remove techs param
      applyFilters();
    });
  }

  async function fetchDataAndInitialize() {
    showLoader();
    mainContent.style.display = 'none';
    secondaryContent.style.display = 'none';

    const allRecords = await fetchAllRecords();
    if (!allRecords.length) return hideLoader();

    const techs = extractFieldTechs(allRecords);
    generateCheckboxes(techs);

    const primaryRecords = allRecords.filter(r => r.fields['Status'] === 'Field Tech Review Needed');
    const secondaryRecords = allRecords.filter(r => r.fields['Status'] === 'Scheduled- Awaiting Field');

    await Promise.all([
      displayRecords(primaryRecords, '#airtable-data'),
      displayRecords(secondaryRecords, '#feild-data')
    ]);

    mergeTableCells('#airtable-data', 0);
    mergeTableCells('#feild-data', 0);
    applyFilters();
    hideLoader();

    mainContent.style.display = 'block';
    secondaryContent.style.display = 'block';
    setTimeout(() => {
      mainContent.style.opacity = '1';
      secondaryContent.style.opacity = '1';
    }, 10);
  }

  function extractFieldTechs(records) {
    const set = new Set();
    records.forEach(r => {
      const val = r.fields['field tech'];
      if (val) val.split(',').map(n => n.trim()).forEach(n => set.add(n));
    });
    return Array.from(set).sort();
  }

  function generateCheckboxes(techs) {
    const container = document.getElementById('filter-branch');
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'checkbox-row';

    const allLabel = document.createElement('label');
    allLabel.innerHTML = `<input type="checkbox" class="filter-checkbox" value="All"> <span>All</span>`;
    wrapper.appendChild(allLabel);

    techs.forEach(name => {
      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox" class="filter-checkbox" value="${name}"> <span>${name}</span>`;
      wrapper.appendChild(label);
    });

    container.appendChild(wrapper);
    attachCheckboxListeners();
    loadFiltersFromLocalStorage();
  }

  function attachCheckboxListeners() {
    document.querySelectorAll('.filter-checkbox').forEach(cb => {
      cb.addEventListener('change', (e) => {
        const isAll = e.target.value === 'All';
        const allCheckbox = document.querySelector('.filter-checkbox[value="All"]');

        if (isAll) {
          // ✅ ALL handling: when All is checked, uncheck all others
          if (e.target.checked) {
            document.querySelectorAll('.filter-checkbox').forEach(other => {
              if (other.value !== 'All') other.checked = false;
            });
          }
        } else {
          // ✅ Non-All changed: if any non-All is checked, uncheck All
          if (e.target.checked && allCheckbox) {
            allCheckbox.checked = false;
          }
        }

        // Build selected list excluding "All"
        const selected = Array
          .from(document.querySelectorAll('.filter-checkbox:checked'))
          .map(cb => cb.value)
          .filter(v => v.toLowerCase() !== 'all');

        // Save without "All"
        localStorage.setItem('selectedFilters', JSON.stringify(selected));

        // Update URL & apply filters
        updateURLWithFilters(selected); // ✅ never writes "All" to URL
        applyFilters();
      });
    });
  }

  function loadFiltersFromLocalStorage() {
    const saved = JSON.parse(localStorage.getItem('selectedFilters') || '[]');

    // ✅ Set checkboxes based on saved (never includes "All")
    document.querySelectorAll('.filter-checkbox').forEach(cb => {
      if (cb.value === 'All') return; // don't check here
      cb.checked = saved.includes(cb.value);
    });

    // ✅ If none saved, default to "All" (means show everything)
    const allCheckbox = document.querySelector('.filter-checkbox[value="All"]');
    if (allCheckbox) {
      allCheckbox.checked = saved.length === 0;
    }
  }

  function applyFilters() {
    // Read from checkboxes (not storage) to reflect current UI
    let selected = Array
      .from(document.querySelectorAll('.filter-checkbox:checked'))
      .map(cb => cb.value);

    // ✅ Treat "All" as empty selection internally
    const isAllSelected = selected.includes('All');
    if (isAllSelected) selected = [];

    const isAll = selected.length === 0;

    ['#airtable-data', '#feild-data'].forEach(selector => {
      const table = document.querySelector(selector);
      const rows = table.querySelectorAll('tbody tr');
      const thead = table.querySelector('thead');
      const h2 = table.closest('.scrollable-div')?.previousElementSibling;

      let visibleCount = 0;

      rows.forEach(row => {
        const tech = row.cells[0]?.textContent.trim() || '';
        const techNames = tech.split(',').map(n => n.trim());
        const shouldShow = isAll || selected.some(name => techNames.includes(name));
        row.style.display = shouldShow ? '' : 'none';
        if (shouldShow) visibleCount++;
      });

      // Hide table/h2/thead if no visible rows
      if (visibleCount === 0) {
        table.style.display = 'none';
        if (thead) thead.style.display = 'none';
        if (h2) h2.style.display = 'none';
      } else {
        table.style.display = 'table';
        if (thead) thead.style.display = 'table-header-group';
        if (h2) h2.style.display = 'block';
      }
    });
  }

  function updateURLWithFilters(selectedRaw) {
    // ✅ Never include "All" in URL; drop empties
    const selected = (selectedRaw || []).filter(v => v && v.toLowerCase() !== 'all');

    const params = new URLSearchParams(window.location.search);
    if (selected.length > 0) {
      params.set('techs', selected.join(',')); // commas → %2C; spaces → +
    } else {
      params.delete('techs'); // ✅ All/none → remove param
    }

    const qs = params.toString();

    if (location.hostname === 'localhost') {
      // ✅ Force the exact localhost format you wanted
      const newURL = `${location.protocol}//${location.host}/index.html${qs ? `?${qs}` : ''}`;
      history.replaceState(null, '', newURL);
    } else {
      // ✅ Keep current path on prod
      const newURL = `${location.pathname}${qs ? `?${qs}` : ''}`;
      history.replaceState(null, '', newURL);
    }
  }

  async function fetchAllRecords(offset = null, collected = []) {
    const viewName = 'viw6ak9NqjR7r0A4g'; // 👈 REPLACE with your actual view name
    const encodedView = encodeURIComponent(viewName);
    const url = `https://api.airtable.com/v0/${airtableBaseId}/${airtableTableName}?view=${encodedView}${offset ? `&offset=${offset}` : ''}`;

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${airtableApiKey}` }
      });

      const data = await response.json();
      const records = collected.concat(data.records);
      if (data.offset) return fetchAllRecords(data.offset, records);
      return records;
    } catch (err) {
      console.error("❌ Error fetching records:", err);
      return collected;
    }
  }

  function applyAlternatingColors(selector) {
    const table = document.querySelector(selector);
    if (!table) {
      console.warn(`⚠️ No table found for selector: ${selector}`);
      return;
    }

    const rows = table.querySelectorAll('tbody tr');
    console.log(`🎯 Found ${rows.length} rows in ${selector}`);

    let colorToggle = false;
    const evenColor = '#ffffff';
    const oddColor = '#ffffff';

    rows.forEach((row) => {
      const firstCell = row.cells[0];
      const isMerged = !firstCell || firstCell.style.display === 'none';
      const color = colorToggle ? evenColor : oddColor;

      if (isMerged) {
        row.style.setProperty('background-color', color, 'important');
      } else {
        colorToggle = !colorToggle;
        const toggleColor = colorToggle ? evenColor : oddColor;
        row.style.setProperty('background-color', toggleColor, 'important');
      }
    });
  }

  async function displayRecords(records, tableSelector) {
    const table = document.querySelector(tableSelector);
    const tbody = table.querySelector('tbody');
    const thead = table.querySelector('thead');
    const h2 = table.closest('.scrollable-div')?.previousElementSibling;

    tbody.innerHTML = '';

    if (!records.length) {
      if (thead) thead.style.display = 'none';
      if (table) table.style.display = 'none';
      if (h2) h2.style.display = 'none';
      return;
    }

    // 🔤 Sort by 'field tech' alphabetically (case-insensitive)
    records.sort((a, b) => {
      const nameA = (a.fields['field tech'] || '').toLowerCase();
      const nameB = (b.fields['field tech'] || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });

    records.forEach(record => {
      const row = document.createElement('tr');
      const tech = record.fields['field tech'] || 'N/A';
      const lot = record.fields['Lot Number and Community/Neighborhood'] || record.fields['Street Address'] || 'N/A';
      const warrantyId = record.fields['Warranty Record ID'] || '';

      row.setAttribute('data-warranty-id', warrantyId);

      row.innerHTML = `
        <td data-field="field tech">${tech}</td>
        <td data-field="Lot Number and Community/Neighborhood" style="cursor:pointer;color:blue;text-decoration:underline">${lot}</td>
        <td data-field="b" style="display:none">${record.fields['b'] || ''}</td>
      `;

      // CLICK HANDLER for job → details URL
      row.querySelector('[data-field="Lot Number and Community/Neighborhood"]').addEventListener('click', () => {
        const id = record.fields['Warranty Record ID'];
        if (!id) return;

        localStorage.setItem("selectedJobId", id);

        if (location.hostname === 'localhost') {
          window.location.href = `${location.protocol}//${location.host}/job-details.html?id=${encodeURIComponent(id)}`;
        } else {
          window.location.href = `https://warranty-updates.vanirinstalledsales.info/job-details.html?id=${encodeURIComponent(id)}`;
        }
      });

      tbody.appendChild(row);
    });

    // Merge sorted duplicate values in column 0
    mergeTableCells(tableSelector, 0);
    applyAlternatingColors(tableSelector);

    if (thead) thead.style.display = 'table-header-group';
    if (table) table.style.display = 'table';
    if (h2) h2.style.display = 'block';
  }
// Force anchor jumps to work even when hash is unchanged,
// and also reset inner scroll containers.
(function () {
  function forceJump(id) {
    const target = document.getElementById(id);
    if (!target) return;

    // If target or any parent is hidden, unhide so the browser can scroll to it
    let node = target;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (style.display === "none") node.style.display = "block";
      node = node.parentElement;
    }

    // Reset any nested scroll areas so the content starts at the top
    document.querySelectorAll(".scrollable-div").forEach(el => { el.scrollTop = 0; });

    // If the current hash already equals the target, clear it so the jump re-triggers
    if (location.hash === "#" + id) {
      history.replaceState(null, "", location.pathname + location.search);
    }

    // Smoothly scroll the page to the target
    target.scrollIntoView({ behavior: "smooth", block: "start" });

    // Restore the hash (optional, keeps back/forward semantics)
    history.replaceState(null, "", "#" + id);
  }

  document.addEventListener("click", (e) => {
    const a = e.target.closest('a.jump-link[href^="#"]');
    if (!a) return;
    e.preventDefault();
    const id = a.getAttribute("href").slice(1);
    forceJump(id);
  });
})();

  function mergeTableCells(selector, columnIndex) {
    const table = document.querySelector(selector);
    if (!table) return;
    const rows = table.querySelectorAll('tbody tr');

    let prevText = '', prevCell = null, rowspan = 1;
    rows.forEach((row) => {
      const cell = row.cells[columnIndex];
      const text = cell?.textContent.trim();
      if (text === prevText) {
        rowspan++;
        prevCell.rowSpan = rowspan;
        cell.style.display = 'none';
      } else {
        prevText = text;
        prevCell = cell;
        rowspan = 1;
      }
    });
  }

  function showLoader() {
    const loader = document.getElementById('loader');
    if (loader) loader.style.display = 'flex';
  }

  function hideLoader() {
    const loader = document.getElementById('loader');
    if (loader) loader.style.display = 'none';
  }
});