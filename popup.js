let sites = [];

// Load saved sites when popup opens
chrome.storage.local.get(['blockedSites'], (result) => {
  if (result.blockedSites) {
    sites = result.blockedSites;
    renderSites();
  } else {
    renderSites(); // empty list
  }
});

function renderSites() {
  const container = document.getElementById('sites-container');
  container.innerHTML = '';
  sites.forEach((site, index) => {
    const row = document.createElement('div');
    row.className = 'site-row';
    row.innerHTML = `
      <input type="text" placeholder="e.g., facebook.com" value="${site.url}" data-index="${index}" data-field="url">
      <input type="number" placeholder="Minutes" value="${site.timeLimit}" data-index="${index}" data-field="timeLimit" min="1">
      <button class="remove-btn" data-index="${index}">X</button>
    `;
    container.appendChild(row);
  });

  // Attach event listeners to inputs and buttons
  document.querySelectorAll('.site-row input').forEach(input => {
    input.addEventListener('change', (e) => {
      const idx = e.target.dataset.index;
      const field = e.target.dataset.field;
      sites[idx][field] = e.target.value;
      saveSites();
    });
  });

  document.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = e.target.dataset.index;
      sites.splice(idx, 1);
      renderSites();
      saveSites();
    });
  });
}

document.getElementById('add-site').addEventListener('click', () => {
  sites.push({ url: '', timeLimit: 5 });
  renderSites();
});

function saveSites() {
  chrome.storage.local.set({ blockedSites: sites }, () => {
    const status = document.getElementById('status');
    status.textContent = 'Saved!';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });
}