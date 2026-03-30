let activeTimers = {}; // tabId -> { site, timerEnd, timeLimit, alarmName }

let blockedSites = [];
let blockedState = {}; // { [siteUrl]: true } — persisted so refreshes stay blocked

chrome.storage.local.get(['blockedSites', 'blockedState'], (result) => {
  blockedSites = result.blockedSites || [];
  blockedState = result.blockedState || {};
  console.log('Loaded blocked sites:', blockedSites);
  console.log('Loaded blocked state:', blockedState);
});

// Listen for storage changes
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes.blockedSites) {
      blockedSites = changes.blockedSites.newValue || [];
      clearAllTimers();
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => checkTab(tab));
      });
    }
    if (changes.blockedState) {
      blockedState = changes.blockedState.newValue || {};
    }
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

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'closeTab') {
    const tabId = sender.tab.id;
    console.log(`Closing tab ${tabId}`);
    clearTimerForTab(tabId);
    chrome.tabs.remove(tabId);
    sendResponse({ success: true });
  }
});

function checkTab(tab) {
  if (!tab.url) return;
  try {
    const url = new URL(tab.url);
    const hostname = url.hostname;

    const siteEntry = blockedSites.find(s => hostname.includes(s.url.trim()));
    if (!siteEntry) {
      clearTimerForTab(tab.id);
      chrome.tabs.sendMessage(tab.id, { action: 'unblock' }).catch(() => {});
      return;
    }

    // If this site is persisted as blocked, re-block on every page load/refresh.
    // Use a short delay so the content script is fully ready after the page loads.
    if (blockedState[siteEntry.url]) {
      console.log(`Site ${siteEntry.url} is blocked, re-blocking tab ${tab.id}`);
      clearTimerForTab(tab.id);
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'block',
          message: 'Time limit exceeded! Take a break.'
        }).catch(() => {});
      }, 300);
      return;
    }

    // If timer already active for this tab + site, resume the countdown display
    if (activeTimers[tab.id] && activeTimers[tab.id].site === siteEntry.url) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'start_countdown',
        endTime: activeTimers[tab.id].timerEnd
      }).catch(() => {});
      return;
    }

    // New site or different site - start fresh
    if (activeTimers[tab.id]) {
      clearTimerForTab(tab.id);
    }

    // Check for bonus time (set when user extends the limit after it expired)
    // Only the difference is granted, not the full new limit
    const bonusKey = `bonusTime_${siteEntry.url}`;
    chrome.storage.local.get([bonusKey], (bonusResult) => {
      let timeLimitMinutes;
      if (bonusResult[bonusKey] !== undefined) {
        timeLimitMinutes = parseInt(bonusResult[bonusKey], 10);
        chrome.storage.local.remove(bonusKey); // consume it so it only applies once
        console.log(`Using bonus time of ${timeLimitMinutes} min for ${siteEntry.url}`);
      } else {
        timeLimitMinutes = parseInt(siteEntry.timeLimit, 10);
      }

      if (isNaN(timeLimitMinutes) || timeLimitMinutes <= 0) {
        console.warn(`Invalid time limit for ${siteEntry.url}, using default 5 minutes.`);
        timeLimitMinutes = 5;
      }

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
    });
  } catch (err) {
    console.error('Error in checkTab:', err);
  }
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

// When the alarm fires, read directly from storage + tab URL.
// This is critical: it handles service worker restarts where activeTimers is empty.
chrome.alarms.onAlarm.addListener((alarm) => {
  console.log('Alarm fired:', alarm.name);
  const tabIdMatch = alarm.name.match(/timer_(\d+)/);
  if (!tabIdMatch) return;

  const tabId = parseInt(tabIdMatch[1], 10);

  // Always fetch fresh data from storage in case the service worker was restarted
  // and activeTimers / blockedSites are empty in memory
  chrome.storage.local.get(['blockedSites', 'blockedState'], (result) => {
    const currentBlockedSites = result.blockedSites || [];
    const currentBlockedState = result.blockedState || {};

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || !tab.url) {
        console.log(`Tab ${tabId} no longer exists`);
        delete activeTimers[tabId];
        return;
      }

      try {
        const hostname = new URL(tab.url).hostname;
        const siteEntry = currentBlockedSites.find(s => hostname.includes(s.url.trim()));
        if (!siteEntry) {
          console.log(`No matching site entry for tab ${tabId}`);
          delete activeTimers[tabId];
          return;
        }

        // Persist the blocked state
        currentBlockedState[siteEntry.url] = true;
        blockedState = currentBlockedState;
        chrome.storage.local.set({ blockedState: currentBlockedState });

        console.log(`Sending block message to tab ${tabId}`);
        chrome.tabs.sendMessage(tabId, {
          action: 'block',
          message: 'Time limit exceeded! Take a break.'
        }).catch((err) => {
          console.error('Failed to send block message:', err);
        });

        delete activeTimers[tabId];
      } catch (err) {
        console.error('Error in alarm handler:', err);
      }
    });
  });
});