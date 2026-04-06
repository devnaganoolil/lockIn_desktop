let sites = [];

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

  const render = (blockedState) => {
    container.innerHTML = '';
    sites.forEach((site, index) => {
      const isBlocked = !!(site.url && blockedState[site.url]);

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
              value="${site.timeLimit}" data-index="${index}" data-field="timeLimit">
          </div>
          <button class="remove-btn" data-index="${index}" title="Remove">✕</button>
        </div>
        ${site.url ? `
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="status-badge ${isBlocked ? 'blocked' : ''}">
            ${isBlocked ? 'Blocked' : 'Active'}
          </span>
          ${isBlocked ? '<span style="font-size:10px;color:var(--muted)">Extend time limit to unblock</span>' : ''}
        </div>` : ''}
      `;
      container.appendChild(card);
    });

    document.querySelectorAll('.site-card input').forEach(input => {
      input.addEventListener('change', (e) => {
        const idx = parseInt(e.target.dataset.index);
        const field = e.target.dataset.field;
        const oldValue = sites[idx][field];
        sites[idx][field] = e.target.value;

        if (field === 'timeLimit') {
          const newMinutes = parseInt(e.target.value, 10);
          const oldMinutes = parseInt(oldValue, 10);
          if (!isNaN(newMinutes) && !isNaN(oldMinutes) && newMinutes > oldMinutes) {
            const siteUrl = sites[idx].url;
            const extraMinutes = newMinutes - oldMinutes;
            chrome.storage.local.get(['blockedState'], (result) => {
              const bs = result.blockedState || {};
              if (bs[siteUrl]) {
                // Tell background to unblock the site live on any open tabs
                // and start the difference countdown automatically
                chrome.runtime.sendMessage(
                  { action: 'unblockSite', siteUrl, extraMinutes },
                  () => saveSites(true)
                );
                return;
              }
              saveSites(true);
            });
            return;
          }
        }

        saveSites(true);
      });
    });

    document.querySelectorAll('.remove-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.target.dataset.index);
        const siteUrl = sites[idx].url;
        sites.splice(idx, 1);
        chrome.storage.local.get(['blockedState'], (result) => {
          const bs = result.blockedState || {};
          if (siteUrl && bs[siteUrl]) {
            delete bs[siteUrl];
            chrome.storage.local.set({ blockedState: bs });
          }
        });
        saveSites(false);
      });
    });
  };

  if (blockedStateOverride !== undefined) {
    render(blockedStateOverride);
  } else {
    chrome.storage.local.get(['blockedState'], (r) => render(r.blockedState || {}));
  }
}

document.getElementById('add-site').addEventListener('click', () => {
  sites.push({ url: '', timeLimit: 5 });
  renderSites();
});

function saveSites(rerender = true) {
  chrome.storage.local.set({ blockedSites: sites }, () => {
    const status = document.getElementById('status');
    status.classList.add('visible');
    setTimeout(() => status.classList.remove('visible'), 1800);
    if (rerender) renderSites();
  });
}