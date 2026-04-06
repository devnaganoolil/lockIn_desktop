// activeTimers is now keyed by siteUrl, not tabId.
// One shared timer per site — all tabs of instagram.com share the same countdown.
let activeTimers = {}; // siteUrl -> { timerEnd, timeLimit, alarmName }

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
      // Re-check all tabs — checkTab handles cleanup naturally
      chrome.tabs.query({}, (tabs) => {
        tabs.forEach(tab => checkTab(tab));
      });
    }
    if (changes.blockedState) {
      blockedState = changes.blockedState.newValue || {};
    }
  }
});

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

// Timer belongs to the site, not the tab — nothing to do on tab close
chrome.tabs.onRemoved.addListener((tabId) => {});

// Messages from content scripts and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'closeTab') {
    const tabId = sender.tab.id;
    chrome.tabs.remove(tabId);
    sendResponse({ success: true });
  }

  if (message.action === 'unblockSite') {
    const { siteUrl, extraMinutes } = message;
    chrome.storage.local.get(['blockedState'], (result) => {
      const bs = result.blockedState || {};
      delete bs[siteUrl];
      blockedState = bs;

      // Clear the site-level timer so a fresh one starts with bonus time
      clearTimerForSite(siteUrl);

      const storageUpdate = { blockedState: bs };
      if (extraMinutes > 0) storageUpdate[`bonusTime_${siteUrl}`] = extraMinutes;

      chrome.storage.local.set(storageUpdate, () => {
        // Unblock and restart timer on all matching tabs
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            if (!tab.url) return;
            try {
              const hostname = new URL(tab.url).hostname;
              if (!hostname.includes(siteUrl.trim())) return;
              chrome.tabs.sendMessage(tab.id, { action: 'unblock' }).catch(() => {});
              checkTab(tab);
            } catch (e) {}
          });
        });
      });
    });
    sendResponse({ success: true });
  }

  if (message.action === 'restartTimer') {
    // User clicked "Continue" — clear blocked state and restart the site timer
    if (!sender.tab?.url) { sendResponse({ success: false }); return; }
    try {
      const hostname = new URL(sender.tab.url).hostname;
      const siteEntry = blockedSites.find(s => hostname.includes(s.url.trim()));
      if (siteEntry) {
        clearTimerForSite(siteEntry.url);
        delete blockedState[siteEntry.url];
        chrome.storage.local.set({ blockedState });
        // Re-check all matching tabs so they all get the new countdown
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            if (!tab.url) return;
            try {
              if (new URL(tab.url).hostname.includes(siteEntry.url.trim())) {
                checkTab(tab);
              }
            } catch (e) {}
          });
        });
      }
      sendResponse({ success: true });
    } catch (e) {
      console.error('restartTimer error:', e);
      sendResponse({ success: false });
    }
  }
});

function checkTab(tab) {
  if (!tab.url) return;
  try {
    const url = new URL(tab.url);
    const hostname = url.hostname;

    const siteEntry = blockedSites.find(s => hostname.includes(s.url.trim()));
    if (!siteEntry) {
      chrome.tabs.sendMessage(tab.id, { action: 'unblock' }).catch(() => {});
      return;
    }

    // Re-block immediately if this site is in the persisted blocked state
    if (blockedState[siteEntry.url]) {
      console.log(`Site ${siteEntry.url} is blocked, re-blocking tab ${tab.id}`);
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'block',
          message: 'Time limit exceeded! Take a break.'
        }).catch(() => {});
      }, 300);
      return;
    }

    // Check storage for a live site-level timer (handles SW restarts)
    const timerKey = `timerState_${siteEntry.url}`;
    chrome.storage.local.get([timerKey], (timerResult) => {
      const persisted = timerResult[timerKey];

      if (persisted && persisted.timerEnd > Date.now()) {
        console.log(`Resuming shared timer for ${siteEntry.url} on tab ${tab.id}`);
        if (!activeTimers[siteEntry.url]) {
          activeTimers[siteEntry.url] = persisted;
        }
        chrome.tabs.sendMessage(tab.id, {
          action: 'start_countdown',
          endTime: persisted.timerEnd
        }).catch(() => {});
        return;
      }

      // In-memory timer still live (same SW session)
      if (activeTimers[siteEntry.url] && activeTimers[siteEntry.url].timerEnd > Date.now()) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'start_countdown',
          endTime: activeTimers[siteEntry.url].timerEnd
        }).catch(() => {});
        return;
      }

      // No active timer — start a fresh one for this site
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
        const alarmName = `sitetimer_${siteEntry.url.replace(/\./g, '_')}`;

        chrome.alarms.clear(alarmName, () => {
          chrome.alarms.create(alarmName, { when: timerEnd });
        });

        const timerState = { siteUrl: siteEntry.url, timerEnd, timeLimit: timeLimitMinutes, alarmName };
        activeTimers[siteEntry.url] = timerState;
        chrome.storage.local.set({ [timerKey]: timerState });

        // Send countdown to ALL open tabs of this site at once
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(t => {
            if (!t.url) return;
            try {
              if (new URL(t.url).hostname.includes(siteEntry.url.trim())) {
                chrome.tabs.sendMessage(t.id, {
                  action: 'start_countdown',
                  endTime: timerEnd
                }).catch(() => {});
              }
            } catch (e) {}
          });
        });

        console.log(`Started shared timer for ${siteEntry.url}: ${timeLimitMinutes} min`);
      });
    });
  } catch (err) {
    console.error('Error in checkTab:', err);
  }
}

function clearTimerForSite(siteUrl) {
  if (activeTimers[siteUrl]) {
    chrome.alarms.clear(activeTimers[siteUrl].alarmName);
    delete activeTimers[siteUrl];
  }
  chrome.storage.local.remove(`timerState_${siteUrl}`);
}

// When the alarm fires, block ALL open tabs of that site
chrome.alarms.onAlarm.addListener((alarm) => {
  console.log('Alarm fired:', alarm.name);
  if (!alarm.name.startsWith('sitetimer_')) return;

  chrome.storage.local.get(['blockedSites', 'blockedState'], (result) => {
    const currentBlockedSites = result.blockedSites || [];
    const currentBlockedState = result.blockedState || {};

    // Match alarm name back to site entry
    const siteEntry = currentBlockedSites.find(s =>
      `sitetimer_${s.url.trim().replace(/\./g, '_')}` === alarm.name
    );

    if (!siteEntry) {
      console.log(`No site entry found for alarm ${alarm.name}`);
      return;
    }

    const siteUrl = siteEntry.url.trim();
    console.log(`Timer expired for site: ${siteUrl}`);

    // Persist blocked state and clean up timer
    currentBlockedState[siteUrl] = true;
    blockedState = currentBlockedState;
    chrome.storage.local.set({ blockedState: currentBlockedState });
    chrome.storage.local.remove(`timerState_${siteUrl}`);
    delete activeTimers[siteUrl];

    // Block every open tab of this site
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (!tab.url) return;
        try {
          if (new URL(tab.url).hostname.includes(siteUrl)) {
            chrome.tabs.sendMessage(tab.id, {
              action: 'block',
              message: 'Time limit exceeded! Take a break.'
            }).catch(() => {});
          }
        } catch (e) {}
      });
    });
  });
});