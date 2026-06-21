/* background.js — Service Worker: Message Hub + Side Panel.
 * Pattern giong Trancy/asbplayer: Port-based relay giua Side Panel va Content Script.
 * Side Panel connect voi name "sidepanel", Content Script connect voi name "content".
 * Background relay messages giua chung theo tabId. */

/* --- Side Panel behavior --- */
try {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
} catch (e) {}
chrome.runtime.onInstalled.addListener((details) => {
  try { chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {}); } catch (e) {}
  // Lần đầu cài extension -> đánh dấu để content script tự hiện hộp thoại xin quyền
  // micro NGAY trên trang YouTube/Netflix (origin của trang) ở lần mở đầu tiên.
  if (details && details.reason === 'install') {
    try { chrome.storage.local.set({ micOnboardPending: true }); } catch (e) {}
  }
});

/* --- Port Manager --- */
const ports = {
  sidepanel: null,       // port tu Side Panel (chi co 1)
  content: new Map(),    // tabId -> port tu Content Script
  spTabId: null,         // tabId ma Side Panel dang theo doi
};

function relayToSidePanel(msg) {
  try { if (ports.sidepanel) ports.sidepanel.postMessage(msg); } catch (e) {}
}
function relayToContent(tabId, msg) {
  const p = ports.content.get(tabId);
  try { if (p) p.postMessage(msg); } catch (e) {}
}

/* Khi Side Panel hoac Content Script connect */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'sidepanel') {
    ports.sidepanel = port;
    // Side Panel gui message -> chuyen tiep sang Content Script cua tab dang active
    port.onMessage.addListener(async (msg) => {
      // Dac biet: Side Panel yeu cau doi tab
      if (msg._setTab) { ports.spTabId = msg._setTab; return; }
      // Relay sang content script
      const tabId = ports.spTabId || msg._tabId;
      if (tabId) relayToContent(tabId, msg);
    });
    port.onDisconnect.addListener(() => {
      ports.sidepanel = null;
    });
    return;
  }

  if (port.name === 'content') {
    // Content script gui tabId qua port.sender
    const tabId = port.sender && port.sender.tab && port.sender.tab.id;
    if (!tabId) return;
    ports.content.set(tabId, port);
    // Content Script gui message -> chuyen tiep sang Side Panel
    port.onMessage.addListener((msg) => {
      // Danh dau tabId de Side Panel biet message tu tab nao
      msg._fromTab = tabId;
      relayToSidePanel(msg);
    });
    port.onDisconnect.addListener(() => {
      ports.content.delete(tabId);
    });
    return;
  }
});

/* --- Fallback: van ho tro sendMessage cho mic-service va legacy --- */
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Mic-service messages: relay truc tiep (chi can Side Panel gui/nhan)
  if (msg && msg.sd === 'mic-service') return; // xu ly boi mic-service.js trong Side Panel
  // Legacy evt messages tu content script (neu chua chuyen sang port)
  if (msg && msg.sd === 'evt') {
    relayToSidePanel(msg);
    return;
  }
});

/* --- Tab tracking: cap nhat spTabId khi user chuyen tab --- */
chrome.tabs.onActivated.addListener((info) => {
  ports.spTabId = info.tabId;
  relayToSidePanel({ _tabChanged: info.tabId });
});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'complete' && tabId === ports.spTabId) {
    relayToSidePanel({ _tabUpdated: tabId });
  }
});
