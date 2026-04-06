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
  if (area !== 'local') return;

  if (changes.blockedSites) {
    const oldSites = changes.blockedSites.oldValue || [];
    const newSites = changes.blockedSites.newValue || [];
    blockedSites = newSites;

    // Find sites whose timeLimit changed or were removed.
    // Their persisted timerState_<tabId> must be wiped so checkTab
    // doesn't resume the old countdown with the wrong duration.
    const changedUrls = new Set();
    oldSites.forEach(oldSite => {
      const newSite = newSites.find(s => s.url === oldSite.url);
      if (!newSite || String(newSite.timeLimit) !== String(oldSite.timeLimit)) {
        changedUrls.add(oldSite.url.trim());
      }
    });

    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (!tab.url || changedUrls.size === 0) return;
        try {
          const hostname = new URL(tab.url).hostname;
          changedUrls.forEach(siteUrl => {
            if (hostname.includes(siteUrl)) {
              clearTimerForTab(tab.id); // wipes memory + timerState_<tabId> from storage
            }
          });
        } catch (e) {}
      });
      // Re-check all tabs — they'll now start fresh with the correct limit
      tabs.forEach(tab => checkTab(tab));
    });
  }

  if (changes.blockedState) {
    blockedState = changes.blockedState.newValue || {};
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

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'closeTab') {
    const tabId = sender.tab.id;
    console.log(`Closing tab ${tabId}`);
    clearTimerForTab(tabId);
    chrome.tabs.remove(tabId);
    sendResponse({ success: true });
  }

  if (message.action === 'unblockSite') {
    const { siteUrl, extraMinutes } = message;
    chrome.storage.local.get(['blockedState'], (result) => {
      const bs = result.blockedState || {};
      delete bs[siteUrl];
      blockedState = bs;
      const storageUpdate = { blockedState: bs };
      if (extraMinutes > 0) storageUpdate[`bonusTime_${siteUrl}`] = extraMinutes;
      chrome.storage.local.set(storageUpdate, () => {
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            if (!tab.url) return;
            try {
              const hostname = new URL(tab.url).hostname;
              if (!hostname.includes(siteUrl.trim())) return;
              clearTimerForTab(tab.id);
              chrome.tabs.sendMessage(tab.id, { action: 'unblock' }).catch(() => {});
              checkTab(tab);
            } catch (e) {}
          });
        });
      });
    });
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

    // Key fix: check persisted timer state in storage, not just in-memory activeTimers.
    // This handles same-site navigation AND service worker restarts — both wipe activeTimers.
    const timerKey = `timerState_${tab.id}`;
    chrome.storage.local.get([timerKey], (timerResult) => {
      const persisted = timerResult[timerKey];

      // If there's a live persisted timer for this tab+site, just resume the countdown.
      // Do NOT start a new timer — this is the core fix for navigation resets.
      if (persisted && persisted.site === siteEntry.url && persisted.timerEnd > Date.now()) {
        console.log(`Resuming existing timer for tab ${tab.id} on ${siteEntry.url}`);

        // Restore into memory so alarm handler still works
        if (!activeTimers[tab.id]) {
          activeTimers[tab.id] = persisted;
        }

        chrome.tabs.sendMessage(tab.id, {
          action: 'start_countdown',
          endTime: persisted.timerEnd
        }).catch(() => {});
        return;
      }

      // No live timer — check if one is already in memory (fast path, same session)
      if (activeTimers[tab.id] && activeTimers[tab.id].site === siteEntry.url) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'start_countdown',
          endTime: activeTimers[tab.id].timerEnd
        }).catch(() => {});
        return;
      }

      // Genuinely new — start a fresh timer
      if (activeTimers[tab.id]) {
        clearTimerForTab(tab.id);
      }

      const bonusKey = `bonusTime_${siteEntry.url}`;
      chrome.storage.local.get([bonusKey], (bonusResult) => {
        let timeLimitMinutes;
        if (bonusResult[bonusKey] !== undefined) {
          timeLimitMinutes = parseInt(bonusResult[bonusKey], 10);
          chrome.storage.local.remove(bonusKey);
          console.log(`Using bonus time of ${timeLimitMinutes} min for ${siteEntry.url}`);
        } else {
          timeLimitMinutes = parseInt(siteEntry.timeLimit, 10);
        }

        if (isNaN(timeLimitMinutes) || timeLimitMinutes <= 0) {
          console.warn(`Invalid time limit for ${siteEntry.url}, using default 5 min.`);
          timeLimitMinutes = 5;
        }

        const timerEnd = Date.now() + timeLimitMinutes * 60 * 1000;
        const alarmName = `timer_${tab.id}`;
        chrome.alarms.create(alarmName, { when: timerEnd });

        const timerState = { site: siteEntry.url, timerEnd, timeLimit: timeLimitMinutes, alarmName };
        activeTimers[tab.id] = timerState;

        // Persist so same-site navigation and service worker restarts can resume it
        chrome.storage.local.set({ [timerKey]: timerState });

        chrome.tabs.sendMessage(tab.id, {
          action: 'start_countdown',
          endTime: timerEnd
        }).catch(() => {});

        console.log(`Started timer for tab ${tab.id} on ${hostname} for ${timeLimitMinutes} min`);
      });
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
  // Also clear persisted timer state so a fresh visit starts a new timer
  chrome.storage.local.remove(`timerState_${tabId}`);
}

function clearAllTimers() {
  Object.keys(activeTimers).forEach(tabId => {
    clearTimerForTab(parseInt(tabId, 10));
  });
}

// When the alarm fires, read directly from storage + tab URL.
chrome.alarms.onAlarm.addListener((alarm) => {
  console.log('Alarm fired:', alarm.name);
  const tabIdMatch = alarm.name.match(/timer_(\d+)/);
  if (!tabIdMatch) return;

  const tabId = parseInt(tabIdMatch[1], 10);

  chrome.storage.local.get(['blockedSites', 'blockedState'], (result) => {
    const currentBlockedSites = result.blockedSites || [];
    const currentBlockedState = result.blockedState || {};

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab || !tab.url) {
        console.log(`Tab ${tabId} no longer exists`);
        delete activeTimers[tabId];
        chrome.storage.local.remove(`timerState_${tabId}`);
        return;
      }

      try {
        const hostname = new URL(tab.url).hostname;
        const siteEntry = currentBlockedSites.find(s => hostname.includes(s.url.trim()));
        if (!siteEntry) {
          console.log(`No matching site entry for tab ${tabId}`);
          delete activeTimers[tabId];
          chrome.storage.local.remove(`timerState_${tabId}`);
          return;
        }

        // Persist the blocked state
        currentBlockedState[siteEntry.url] = true;
        blockedState = currentBlockedState;
        chrome.storage.local.set({ blockedState: currentBlockedState });
        chrome.storage.local.remove(`timerState_${tabId}`);

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