let overlay = null;
let countdownInterval = null;
let countdownElement = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'block') {
    showBlockOverlay(message.message);
    removeCountdown();
  } else if (message.action === 'unblock') {
    removeBlockOverlay();
    removeCountdown();
  } else if (message.action === 'start_countdown') {
    startCountdown(message.endTime);
  }
});

function startCountdown(endTimeMs) {
  removeCountdown();

  countdownElement = document.createElement('div');
  countdownElement.id = 'site-blocker-countdown';
  countdownElement.style.position = 'fixed';
  countdownElement.style.bottom = '10px';
  countdownElement.style.right = '10px';
  countdownElement.style.backgroundColor = 'rgba(0,0,0,0.7)';
  countdownElement.style.color = 'white';
  countdownElement.style.padding = '8px 12px';
  countdownElement.style.borderRadius = '8px';
  countdownElement.style.fontFamily = 'monospace';
  countdownElement.style.fontSize = '14px';
  countdownElement.style.zIndex = '999998';
  countdownElement.style.fontWeight = 'bold';
  countdownElement.style.boxShadow = '0 2px 5px rgba(0,0,0,0.2)';
  document.body.appendChild(countdownElement);

  countdownInterval = setInterval(() => {
    const now = Date.now();
    const remainingMs = endTimeMs - now;
    if (remainingMs <= 0) {
      countdownElement.textContent = '00:00';
      clearInterval(countdownInterval);
      countdownInterval = null;
    } else {
      const totalSeconds = Math.floor(remainingMs / 1000);
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      countdownElement.textContent = `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
  }, 1000);
}

function removeCountdown() {
  if (countdownInterval) {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }
  if (countdownElement) {
    countdownElement.remove();
    countdownElement = null;
  }
}

function showBlockOverlay(msg) {
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'site-blocker-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '0';
  overlay.style.left = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.backgroundColor = 'rgba(0,0,0,0.9)';
  overlay.style.zIndex = '999999';
  overlay.style.display = 'flex';
  overlay.style.justifyContent = 'center';
  overlay.style.alignItems = 'center';
  overlay.style.flexDirection = 'column';
  overlay.style.color = 'white';
  overlay.style.fontFamily = 'Arial, sans-serif';
  overlay.style.textAlign = 'center';

  const messageDiv = document.createElement('div');
  messageDiv.innerHTML = `
    <h1>🚫 Access Blocked</h1>
    <p>${msg}</p>
    <button id="unblock-btn" style="padding:10px 20px; margin-top:20px; background:#4CAF50; color:white; border:none; cursor:pointer;">Close and Continue</button>
  `;
  overlay.appendChild(messageDiv);
  document.body.appendChild(overlay);

  // ---------- MODIFIED: Send restart message to background ----------
  document.getElementById('unblock-btn').addEventListener('click', () => {
    removeBlockOverlay();
    // Tell the background to restart the timer for this tab
    chrome.runtime.sendMessage({ action: 'restartTimer' });
  });
  // ----------------------------------------------------------------
}

function removeBlockOverlay() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
}