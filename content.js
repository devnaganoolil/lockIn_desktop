let overlay = null;
let countdownInterval = null;
let countdownElement = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Content script received message:', message);
  if (message.action === 'block') {
    console.log('Blocking overlay triggered');
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
  countdownElement.style.zIndex = '2147483647'; // max possible
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
  console.log('showBlockOverlay called with message:', msg);
  if (overlay) {
    console.log('Overlay already exists, returning');
    return;
  }

  // Wait for body to be ready (in case script runs before body exists)
  const ensureBody = () => {
    if (!document.body) {
      setTimeout(ensureBody, 50);
      return;
    }

    overlay = document.createElement('div');
    overlay.id = 'site-blocker-overlay';
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.9)';
    overlay.style.zIndex = '2147483647'; // max possible
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

    const btn = document.getElementById('unblock-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        removeBlockOverlay();
        chrome.runtime.sendMessage({ action: 'closeTab' });
      });
    } else {
      console.error('Unblock button not found in overlay');
    }
    console.log('Overlay appended to body');
  };

  ensureBody();
}

function removeBlockOverlay() {
  if (overlay) {
    overlay.remove();
    overlay = null;
    console.log('Overlay removed');
  }
}