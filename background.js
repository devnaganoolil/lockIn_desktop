// activeTimers keyed by SITE URL.
// { remainingMs, timerEnd (null = paused), alarmName }
let activeTimers = {};

let blockedSites = [];
let blockedState = {};
let sitesLoaded  = false;
let focusedWindowId    = null;
let activeTabByWindow  = {}; // windowId -> tabId

// ── Init ──────────────────────────────────────────────────────────────────────
chrome.storage.local.get(['blockedSites', 'blockedState'], (result) => {
  blockedSites = result.blockedSites || [];
  blockedState = result.blockedState || {};
  sitesLoaded  = true;
});

// Seed focused window + active tab on service-worker start
chrome.windows.getLastFocused({}, (win) => {
  if (chrome.runtime.lastError || !win) return;
  if (win.focused) {
    focusedWindowId = win.id;
    chrome.tabs.query({ active: true, windowId: win.id }, (tabs) => {
      if (tabs[0]) activeTabByWindow[win.id] = tabs[0].id;
    });
  }
});

// ── Storage changes ───────────────────────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.blockedSites) {
    const oldSites = changes.blockedSites.oldValue || [];
    const newSites = changes.blockedSites.newValue || [];
    blockedSites = newSites;
    sitesLoaded  = true;

    // Clear timers only when a site is removed or its time limit DECREASES.
    // If the limit increased (user extended), leave the timer alone — the
    // unblockSite handler already started it with the bonus time.
    const changedUrls = new Set();
    oldSites.forEach(old => {
      const updated = newSites.find(s => s.url === old.url);
      const oldLimit = parseInt(old.timeLimit, 10);
      const newLimit = updated ? parseInt(updated.timeLimit, 10) : 0;
      if (!updated || newLimit < oldLimit) {
        changedUrls.add(old.url.trim());
      }
    });
    changedUrls.forEach(siteUrl => clearTimerForSite(siteUrl));

    chrome.tabs.query({}, (tabs) => tabs.forEach(tab => dispatchTab(tab)));
  }
  if (changes.blockedState) {
    blockedState = changes.blockedState.newValue || {};
  }
});

// ── Tab events ────────────────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') dispatchTab(tab);
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  const prevTabId = activeTabByWindow[windowId];
  activeTabByWindow[windowId] = tabId;

  // Resume the newly active tab. If focusedWindowId is null (SW just restarted
  // and hasn't seeded yet) treat the activating window as focused.
  const doResume = () => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (focusedWindowId === null || windowId === focusedWindowId) {
        startOrResumeTabSite(tab);
      } else {
        applyPassiveState(tab);
      }
    });
  };

  // Pause the previous tab FIRST, then resume in the callback — prevents the
  // race where resume runs before pause and pause then nulls out timerEnd again.
  if (prevTabId && prevTabId !== tabId) {
    chrome.tabs.get(prevTabId, (prevTab) => {
      if (!chrome.runtime.lastError) pauseTabSite(prevTab);
      doResume();
    });
  } else {
    doResume();
  }
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // Browser lost focus entirely — pause whatever was running, then clear
    if (focusedWindowId !== null && activeTabByWindow[focusedWindowId]) {
      chrome.tabs.get(activeTabByWindow[focusedWindowId], (tab) => {
        if (!chrome.runtime.lastError) pauseTabSite(tab);
      });
    }
    focusedWindowId = null;
    return;
  }

  // Ignore extension popup windows — they must never corrupt focusedWindowId
  chrome.windows.get(windowId, (win) => {
    if (chrome.runtime.lastError || !win) return;
    if (win.type === 'popup') return;

    const prevWindowId = focusedWindowId;
    focusedWindowId = windowId;

    // Resume the newly focused window's active tab.
    const doResume = () => {
      const knownTabId = activeTabByWindow[windowId];
      if (knownTabId) {
        chrome.tabs.get(knownTabId, (tab) => {
          if (!chrome.runtime.lastError) startOrResumeTabSite(tab);
        });
      } else {
        chrome.tabs.query({ active: true, windowId }, (tabs) => {
          if (!tabs[0]) return;
          activeTabByWindow[windowId] = tabs[0].id;
          startOrResumeTabSite(tabs[0]);
        });
      }
    };

    // Pause old window's active tab FIRST, then resume new window's tab.
    if (prevWindowId !== null && prevWindowId !== windowId && activeTabByWindow[prevWindowId]) {
      chrome.tabs.get(activeTabByWindow[prevWindowId], (tab) => {
        if (!chrome.runtime.lastError) pauseTabSite(tab);
        doResume();
      });
    } else {
      doResume();
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (activeTabByWindow[removeInfo.windowId] === tabId) {
    delete activeTabByWindow[removeInfo.windowId];
  }
});

// ── Messages ──────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.action === 'closeTab') {
    chrome.tabs.remove(sender.tab.id);
    sendResponse({ success: true });
    return;
  }

  if (message.action === 'unblockSite') {
    const { siteUrl, extraMinutes } = message;

    // ── 1. Clear blocked state in memory IMMEDIATELY ─────────────────────────
    // This must happen before any async work so that any concurrent
    // dispatchTab / startOrResumeTabSite calls see the site as unblocked.
    delete blockedState[siteUrl];

    // ── 2. Set up the fresh timer SYNCHRONOUSLY right now ────────────────────
    // By populating activeTimers before we do ANY async storage work, we
    // guarantee that when saveSites() triggers storage.onChanged → dispatchTab
    // → startOrResumeTabSite, it finds the timer already in memory and simply
    // sends start_countdown — it never falls through to the blocked-state check.
    clearTimerForSite(siteUrl);
    const timeLimitMinutes = (extraMinutes > 0) ? extraMinutes : 5;
    const freshMs   = timeLimitMinutes * 60 * 1000;
    const timerEnd  = Date.now() + freshMs;
    const alarmName = `siteAlarm_${siteUrl}`;
    chrome.alarms.create(alarmName, { when: timerEnd });
    activeTimers[siteUrl] = { remainingMs: freshMs, timerEnd, alarmName };
    saveTimerState(siteUrl, freshMs, timerEnd);

    // ── 3. Persist the cleared blocked state, then notify tabs ───────────────
    chrome.storage.local.get(['blockedState'], (result) => {
      const bs = result.blockedState || {};
      delete bs[siteUrl];
      blockedState = bs;

      chrome.storage.local.set({ blockedState: bs }, () => {
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            if (!tab.url) return;
            try {
              const hostname = new URL(tab.url).hostname;
              if (!hostname.includes(siteUrl.trim())) return;
              // Remove the block overlay
              chrome.tabs.sendMessage(tab.id, { action: 'unblock' }).catch(() => {});
              // Send the countdown directly — timer is already set in activeTimers
              chrome.tabs.sendMessage(tab.id, { action: 'start_countdown', endTime: timerEnd }).catch(() => {});
            } catch (e) {}
          });
          // Respond only after tabs are messaged, so popup's saveSites fires
          // after the overlay is already removed and countdown is running.
          sendResponse({ success: true });
        });
      });
    });
    return true; // keep channel open for async sendResponse
  }
});

// ── Dispatch helper ───────────────────────────────────────────────────────────
// Routes a tab to the right handler. Checks window focus dynamically so a
// stale focusedWindowId (e.g. after popup interaction) never silently fails.
function dispatchTab(tab) {
  if (!tab.active) { applyPassiveState(tab); return; }
  chrome.windows.get(tab.windowId, (win) => {
    if (chrome.runtime.lastError || !win) { applyPassiveState(tab); return; }
    if (win.focused && win.type !== 'popup') {
      startOrResumeTabSite(tab);
    } else {
      applyPassiveState(tab);
    }
  });
}

// ── startOrResumeTabSite ──────────────────────────────────────────────────────
// Called when a tab IS the active, focused tab.
// Starts a fresh timer or resumes a paused one.
function startOrResumeTabSite(tab) {
  if (!sitesLoaded) {
    chrome.storage.local.get(['blockedSites', 'blockedState'], (result) => {
      blockedSites = result.blockedSites || [];
      blockedState = result.blockedState || {};
      sitesLoaded  = true;
      startOrResumeTabSite(tab);
    });
    return;
  }

  if (!tab.url) return;

  try {
    const hostname  = new URL(tab.url).hostname;
    const siteEntry = blockedSites.find(s => hostname.includes(s.url.trim()));

    if (!siteEntry) {
      chrome.tabs.sendMessage(tab.id, { action: 'unblock' }).catch(() => {});
      return;
    }

    if (blockedState[siteEntry.url]) {
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'block',
          message: 'Time limit exceeded! Take a break.'
        }).catch(() => {});
      }, 300);
      return;
    }

    const mem = activeTimers[siteEntry.url];

    if (mem) {
      if (!mem.timerEnd) {
        // Timer exists but is paused — resume it
        const timerEnd  = Date.now() + mem.remainingMs;
        const alarmName = `siteAlarm_${siteEntry.url}`;
        chrome.alarms.create(alarmName, { when: timerEnd });
        mem.timerEnd  = timerEnd;
        mem.alarmName = alarmName;
        saveTimerState(siteEntry.url, mem.remainingMs, timerEnd);
        console.log(`Resumed timer for ${siteEntry.url}: ${Math.round(mem.remainingMs / 1000)}s left`);
      }
      chrome.tabs.sendMessage(tab.id, {
        action: 'start_countdown',
        endTime: mem.timerEnd
      }).catch(() => {});
      return;
    }

    // No in-memory timer — check persisted state (handles service-worker restarts)
    const timerKey = `timerState_${siteEntry.url}`;
    chrome.storage.local.get([timerKey], (timerResult) => {
      const persisted = timerResult[timerKey];

      let remainingMs = 0;
      if (persisted) {
        if (persisted.timerEnd && persisted.timerEnd > Date.now()) {
          // Timer was running when SW died — timerEnd still valid
          remainingMs = persisted.timerEnd - Date.now();
          console.log(`Restoring running timer for ${siteEntry.url}: ${Math.round(remainingMs / 1000)}s left`);
        } else if (persisted.remainingMs > 0) {
          // Timer was paused
          remainingMs = persisted.remainingMs;
          console.log(`Restoring paused timer for ${siteEntry.url}: ${Math.round(remainingMs / 1000)}s left`);
        }
      }

      if (remainingMs > 0) {
        // Restore and resume immediately (tab is active+focused right now)
        const timerEnd  = Date.now() + remainingMs;
        const alarmName = `siteAlarm_${siteEntry.url}`;
        chrome.alarms.create(alarmName, { when: timerEnd });
        activeTimers[siteEntry.url] = { remainingMs, timerEnd, alarmName };
        saveTimerState(siteEntry.url, remainingMs, timerEnd);
        chrome.tabs.sendMessage(tab.id, { action: 'start_countdown', endTime: timerEnd }).catch(() => {});
        return;
      }

      // No prior timer — start fresh using the site's current time limit
      let timeLimitMinutes = parseInt(siteEntry.timeLimit, 10);
      if (isNaN(timeLimitMinutes) || timeLimitMinutes <= 0) timeLimitMinutes = 5;

      const freshMs   = timeLimitMinutes * 60 * 1000;
      const timerEnd  = Date.now() + freshMs;
      const alarmName = `siteAlarm_${siteEntry.url}`;
      chrome.alarms.create(alarmName, { when: timerEnd });
      activeTimers[siteEntry.url] = { remainingMs: freshMs, timerEnd, alarmName };
      saveTimerState(siteEntry.url, freshMs, timerEnd);
      chrome.tabs.sendMessage(tab.id, { action: 'start_countdown', endTime: timerEnd }).catch(() => {});
      console.log(`Started fresh timer for ${siteEntry.url}: ${timeLimitMinutes} min`);
    });
  } catch (err) {
    console.error('Error in startOrResumeTabSite:', err);
  }
}

// ── applyPassiveState ─────────────────────────────────────────────────────────
// Called when a tab is NOT the active+focused tab.
// Shows the block overlay, or the ⏸ paused countdown — never runs the clock.
function applyPassiveState(tab) {
  if (!tab.url || !sitesLoaded) return;
  try {
    const hostname  = new URL(tab.url).hostname;
    const siteEntry = blockedSites.find(s => hostname.includes(s.url.trim()));

    if (!siteEntry) {
      chrome.tabs.sendMessage(tab.id, { action: 'unblock' }).catch(() => {});
      return;
    }

    if (blockedState[siteEntry.url]) {
      setTimeout(() => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'block',
          message: 'Time limit exceeded! Take a break.'
        }).catch(() => {});
      }, 300);
      return;
    }

    const mem = activeTimers[siteEntry.url];
    if (mem) {
      const remaining = mem.timerEnd
        ? Math.max(0, mem.timerEnd - Date.now())
        : mem.remainingMs;
      chrome.tabs.sendMessage(tab.id, { action: 'show_paused', remainingMs: remaining }).catch(() => {});
    }
  } catch (e) {}
}

// ── pauseTabSite ──────────────────────────────────────────────────────────────
// Freezes the running timer for a tab that just lost active/focused status.
function pauseTabSite(tab) {
  if (!tab.url || !sitesLoaded) return;
  try {
    const hostname  = new URL(tab.url).hostname;
    const siteEntry = blockedSites.find(s => hostname.includes(s.url.trim()));
    if (!siteEntry) return;

    const mem = activeTimers[siteEntry.url];
    if (!mem || !mem.timerEnd) return; // nothing running

    const remainingMs = Math.max(0, mem.timerEnd - Date.now());
    mem.remainingMs = remainingMs;
    mem.timerEnd    = null; // mark as paused
    if (mem.alarmName) chrome.alarms.clear(mem.alarmName);

    // Persist paused state (no timerEnd = paused)
    saveTimerState(siteEntry.url, remainingMs, null);
    console.log(`Paused timer for ${siteEntry.url}: ${Math.round(remainingMs / 1000)}s left`);

    // Tell every tab on this site to show the paused badge
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(t => {
        if (!t.url) return;
        try {
          if (new URL(t.url).hostname.includes(siteEntry.url.trim())) {
            chrome.tabs.sendMessage(t.id, { action: 'show_paused', remainingMs }).catch(() => {});
          }
        } catch (e) {}
      });
    });
  } catch (e) {}
}

// ── Timer helpers ─────────────────────────────────────────────────────────────

function saveTimerState(siteUrl, remainingMs, timerEnd) {
  const state = { remainingMs };
  if (timerEnd) state.timerEnd = timerEnd;
  chrome.storage.local.set({ [`timerState_${siteUrl}`]: state });
}

function clearTimerForSite(siteUrl) {
  const timer = activeTimers[siteUrl];
  if (timer) {
    if (timer.alarmName) chrome.alarms.clear(timer.alarmName);
    delete activeTimers[siteUrl];
  }
  chrome.storage.local.remove(`timerState_${siteUrl}`);
}

// ── Alarm handler ─────────────────────────────────────────────────────────────
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith('siteAlarm_')) return;
  const siteUrl = alarm.name.slice('siteAlarm_'.length);

  console.log(`Alarm fired for site: ${siteUrl}`);

  chrome.storage.local.get(['blockedSites', 'blockedState'], (result) => {
    const currentBlockedSites = result.blockedSites  || [];
    const currentBlockedState = result.blockedState || {};

    const siteEntry = currentBlockedSites.find(s => s.url.trim() === siteUrl);
    if (!siteEntry) {
      delete activeTimers[siteUrl];
      chrome.storage.local.remove(`timerState_${siteUrl}`);
      return;
    }

    currentBlockedState[siteUrl] = true;
    blockedState = currentBlockedState;
    chrome.storage.local.set({ blockedState: currentBlockedState });
    chrome.storage.local.remove(`timerState_${siteUrl}`);
    delete activeTimers[siteUrl];

    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        if (!tab.url) return;
        try {
          const hostname = new URL(tab.url).hostname;
          if (!hostname.includes(siteUrl)) return;
          chrome.tabs.sendMessage(tab.id, {
            action: 'block',
            message: 'Time limit exceeded! Take a break.'
          }).catch(() => {});
        } catch (e) {}
      });
    });
  });
});