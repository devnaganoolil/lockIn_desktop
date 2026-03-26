let activeTimers = {}; // tabId -> { site, timerEnd, timeLimit, alarmName }

// Load sites from storage
let blockedSites = [];

chrome.storage.local.get(['blockedSites'], (result) => {
  blockedSites = result.blockedSites || [];
});

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.blockedSites) {
    blockedSites = changes.blockedSites.newValue || [];
    clearAllTimers();
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => checkTab(tab));
    });
  }
});

// Check when a tab is updated or activated
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    checkTab(tab);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    checkTab(tab);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTimerForTab(tabId);
});

// Listen for restart requests from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'restartTimer') {
    const tabId = sender.tab.id;
    clearTimerForTab(tabId);
    chrome.tabs.get(tabId, (tab) => {
      if (tab) checkTab(tab);
    });
    sendResponse({ success: true });
  }
});

function checkTab(tab) {
  if (!tab.url) return;
  const url = new URL(tab.url);
  const hostname = url.hostname;

  const siteEntry = blockedSites.find(s => hostname.includes(s.url.trim()));
  if (!siteEntry) {
    clearTimerForTab(tab.id);
    chrome.tabs.sendMessage(tab.id, { action: 'unblock' }).catch(() => {});
    return;
  }

  // If timer already exists for this tab and same site, just ensure countdown is shown
  if (activeTimers[tab.id] && activeTimers[tab.id].site === siteEntry.url) {
    chrome.tabs.sendMessage(tab.id, {
      action: 'start_countdown',
      endTime: activeTimers[tab.id].timerEnd
    }).catch(() => {});
    return;
  }

  // New site or different site → start fresh
  if (activeTimers[tab.id]) {
    clearTimerForTab(tab.id);
  }

  // ----- FIX: Validate time limit -----
  let timeLimitMinutes = parseInt(siteEntry.timeLimit, 10);
  if (isNaN(timeLimitMinutes) || timeLimitMinutes <= 0) {
    console.warn(`Invalid time limit for ${siteEntry.url}, using default 5 minutes.`);
    timeLimitMinutes = 5;
  }
  // -----------------------------------

  const timerEnd = Date.now() + timeLimitMinutes * 60 * 1000;
  const alarmName = `timer_${tab.id}`;
  chrome.alarms.create(alarmName, { when: timerEnd });
  activeTimers[tab.id] = {
    site: siteEntry.url,
    timerEnd,
    timeLimit: timeLimitMinutes,
    alarmName
  };

  chrome.tabs.sendMessage(tab.id, {
    action: 'start_countdown',
    endTime: timerEnd
  }).catch(() => {});

  console.log(`Started timer for tab ${tab.id} on ${hostname} for ${timeLimitMinutes} min`);
}

function clearTimerForTab(tabId) {
  if (activeTimers[tabId]) {
    chrome.alarms.clear(activeTimers[tabId].alarmName);
    delete activeTimers[tabId];
  }
}

function clearAllTimers() {
  Object.keys(activeTimers).forEach(tabId => {
    clearTimerForTab(parseInt(tabId, 10));
  });
}

// When alarm fires, block the tab
chrome.alarms.onAlarm.addListener((alarm) => {
  const tabIdMatch = alarm.name.match(/timer_(\d+)/);
  if (tabIdMatch) {
    const tabId = parseInt(tabIdMatch[1], 10);
    if (activeTimers[tabId]) {
      chrome.tabs.sendMessage(tabId, { action: 'block', message: 'Time limit exceeded! Take a break.' }).catch(() => {});
      delete activeTimers[tabId];
    }
  }
});