let sites = [];

const MAX_EXTENSIONS_PER_DAY = 2;

// Returns today's date string e.g. "2026-04-08"
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// Returns the storage key for a site's extension record
function extKey(siteUrl) {
  return `extCount_${siteUrl}`;
}

// Reads the extension record for a site, resets it if it's from a previous day.
// Calls back with { count, date }.
function getExtRecord(siteUrl, cb) {
  chrome.storage.local.get([extKey(siteUrl)], (result) => {
    const rec = result[extKey(siteUrl)] || { count: 0, date: todayStr() };
    // New day — reset automatically
    if (rec.date !== todayStr()) {
      const fresh = { count: 0, date: todayStr() };
      chrome.storage.local.set({ [extKey(siteUrl)]: fresh }, () => cb(fresh));
    } else {
      cb(rec);
    }
  });
}

// Increments the extension count for a site and calls back with the new record.
function incrementExtCount(siteUrl, cb) {
  getExtRecord(siteUrl, (rec) => {
    const updated = { count: rec.count + 1, date: todayStr() };
    chrome.storage.local.set({ [extKey(siteUrl)]: updated }, () => cb(updated));
  });
}

chrome.storage.local.get(['blockedSites', 'blockedState'], (result) => {
  sites = result.blockedSites || [];
  renderSites(result.blockedState || {});
});

function renderSites(blockedStateOverride) {
  const container = document.getElementById('sites-container');
  container.innerHTML = '';

  if (sites.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🌐</div>
        <p>No sites added yet.<br>Click <strong>Add Website</strong> to get started.</p>
      </div>`;
    return;
  }

  const render = (blockedState, extCounts) => {
    container.innerHTML = '';
    sites.forEach((site, index) => {
      const isBlocked   = !!(site.url && blockedState[site.url]);
      const extsUsed    = extCounts[site.url] || 0;
      const extsLeft    = Math.max(0, MAX_EXTENSIONS_PER_DAY - extsUsed);
      const maxedOut    = site.url && extsLeft === 0;

      const card = document.createElement('div');
      card.className = 'site-card';
      card.innerHTML = `
        <div class="card-row">
          <div class="field-wrap">
            <label>Website</label>
            <input type="text" placeholder="e.g. facebook.com"
              value="${site.url}" data-index="${index}" data-field="url">
          </div>
          <div class="field-wrap time-wrap">
            <label>Minutes</label>
            <input type="number" placeholder="5" min="1"
              value="${site.timeLimit}" data-index="${index}" data-field="timeLimit"
              ${maxedOut ? 'disabled title="Extension limit reached for today"' : ''}>
          </div>
          <button class="remove-btn" data-index="${index}" title="Remove">✕</button>
        </div>
        ${site.url ? `
        <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px;">
          <span class="status-badge ${isBlocked ? 'blocked' : ''}">
            ${isBlocked ? 'Blocked' : 'Active'}
          </span>
          <span style="font-size:10px;color:${maxedOut ? 'var(--danger)' : 'var(--muted)'}">
            ${maxedOut
              ? '🔒 No extensions left today'
              : isBlocked
                ? `Extend to unblock &middot; ${extsLeft}/${MAX_EXTENSIONS_PER_DAY} left today`
                : extsUsed > 0
                  ? `${extsLeft}/${MAX_EXTENSIONS_PER_DAY} extensions left today`
                  : ''}
          </span>
        </div>` : ''}
      `;
      container.appendChild(card);
    });

    document.querySelectorAll('.site-card input').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx      = parseInt(e.target.dataset.index);
        const field    = e.target.dataset.field;
        const oldValue = sites[idx][field];
        sites[idx][field] = e.target.value;

        if (field === 'timeLimit') {
          const newMinutes = parseInt(e.target.value, 10);
          const oldMinutes = parseInt(oldValue, 10);

          if (!isNaN(newMinutes) && !isNaN(oldMinutes) && newMinutes > oldMinutes) {
            const siteUrl = sites[idx].url;

            // Check extension limit before allowing an increase
            getExtRecord(siteUrl, (rec) => {
              if (rec.count >= MAX_EXTENSIONS_PER_DAY) {
                // Revert the input and show a message
                sites[idx][field] = oldValue;
                showStatus(`🔒 Max ${MAX_EXTENSIONS_PER_DAY} extensions per day reached`, true);
                renderSites();
                return;
              }

              // Consume one extension slot
              incrementExtCount(siteUrl, () => {
                const extraMinutes = newMinutes - oldMinutes;
                chrome.storage.local.get(['blockedState'], (result) => {
                  const bs = result.blockedState || {};
                  if (bs[siteUrl]) {
                    chrome.runtime.sendMessage(
                      { action: 'unblockSite', siteUrl, extraMinutes },
                      () => saveSites(true)
                    );
                    return;
                  }
                  saveSites(true);
                });
              });
            });
            return;
          }
        }

        saveSites(true);
      });
    });

    document.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx     = parseInt(e.target.dataset.index);
        const siteUrl = sites[idx].url;
        sites.splice(idx, 1);
        chrome.storage.local.get(['blockedState'], (result) => {
          const bs = result.blockedState || {};
          if (siteUrl && bs[siteUrl]) {
            delete bs[siteUrl];
            chrome.storage.local.set({ blockedState: bs });
          }
        });
        saveSites(true);
      });
    });
  };

  // Gather extension counts for all sites with URLs
  const siteUrls     = sites.filter(s => s.url).map(s => s.url);
  const extKeys      = siteUrls.map(extKey);

  const fetchAndRender = (blockedState) => {
    if (extKeys.length === 0) { render(blockedState, {}); return; }
    chrome.storage.local.get(extKeys, (extResult) => {
      const extCounts = {};
      siteUrls.forEach(url => {
        const rec = extResult[extKey(url)];
        // Only count if record is from today; otherwise treat as 0
        extCounts[url] = (rec && rec.date === todayStr()) ? rec.count : 0;
      });
      render(blockedState, extCounts);
    });
  };

  if (blockedStateOverride !== undefined) {
    fetchAndRender(blockedStateOverride);
  } else {
    chrome.storage.local.get(['blockedState'], (r) => fetchAndRender(r.blockedState || {}));
  }
}

document.getElementById('add-site').addEventListener('click', () => {
  sites.push({ url: '', timeLimit: 5 });
  renderSites();
});

function saveSites(rerender = true) {
  chrome.storage.local.set({ blockedSites: sites }, () => {
    showStatus('Saved ✓');
    if (rerender) renderSites();
  });
}

function showStatus(msg, isError = false) {
  const status = document.getElementById('status');
  status.textContent = msg;
  status.style.color = isError ? 'var(--danger)' : 'var(--green)';
  status.classList.add('visible');
  setTimeout(() => {
    status.classList.remove('visible');
    status.textContent = 'Saved ✓';
    status.style.color = 'var(--green)';
  }, 2500);
}