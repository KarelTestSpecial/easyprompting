// Easy Prompting — background service worker.
//
// The pad has two shapes:
//   * a normal browser tab (DEFAULT) — sits in the tab strip, can be dragged
//     into any window, next to your AI chat.
//   * a floating popup window without toolbars (secondary) — slim, outside the
//     tab strip, for when you want it out of the way.
// Both shapes read and write the same chrome.storage.local data, so switching
// shape never loses a prompt. Only one instance may be alive at a time: every
// conversion closes the previous shape.

const PAD_PAGE = "pad.html";
const PAD_URL = chrome.runtime.getURL(PAD_PAGE);

// --- locating the pad -------------------------------------------------------

function withTimeout(promise, ms) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(null), ms))
    ]);
}

// Cheapest and permission-free: ask a live pad instance where it is.
async function pingPad() {
    try {
        const reply = await withTimeout(
            chrome.runtime.sendMessage({ type: "ep-where-are-you" }),
            400
        );
        if (reply && reply.tabId != null && reply.windowId != null) return reply;
    } catch (e) {
        // Nobody listening — fall through to the scan.
    }
    return null;
}

// Enumerate every open pad instance. The tab/window scan is authoritative
// because it sees all of them; the ping is the fallback for a browser that
// withholds tab.url from the scan.
async function allPads() {
    const found = [];
    try {
        const windows = await chrome.windows.getAll({ populate: true });
        for (const win of windows) {
            for (const tab of (win.tabs || [])) {
                if (tab.url === PAD_URL) {
                    found.push({ tabId: tab.id, windowId: win.id, windowType: win.type });
                }
            }
        }
    } catch (e) {
        // Ignore — fall back to the ping below.
    }
    if (found.length) return found;
    const pinged = await pingPad();
    return pinged ? [await withWindowType(pinged)] : [];
}

async function withWindowType(pad) {
    if (pad.windowType) return pad;
    try {
        const win = await chrome.windows.get(pad.windowId);
        pad.windowType = win.type;
    } catch (e) {
        // Window disappeared between the find and the lookup.
    }
    return pad;
}

async function findPad() {
    const pads = await allPads();
    return pads.length ? pads[0] : null;
}

async function removePad(pad) {
    try {
        if (pad.windowType === "popup") await chrome.windows.remove(pad.windowId);
        else await chrome.tabs.remove(pad.tabId);
    } catch (e) {
        // Already gone.
    }
}

// Exactly one live instance is allowed: two pads would fight over
// chrome.storage. Every open path ends here so a stray copy self-heals.
async function closePadsExcept(keepTabId) {
    const pads = await allPads();
    for (const pad of pads) {
        if (keepTabId != null && pad.tabId === keepTabId) continue;
        await removePad(pad);
    }
}

async function focusPad(pad) {
    try {
        await chrome.tabs.update(pad.tabId, { active: true });
        await chrome.windows.update(pad.windowId, { focused: true });
    } catch (e) {
        // Pad vanished mid-flight.
    }
}

async function activeTab() {
    try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        return tab || null;
    } catch (e) {
        return null;
    }
}

// A window a pad tab can live in: prefer the caller's window if it is a real
// browser window, otherwise any normal window.
async function targetNormalWindowId(preferredWindowId) {
    if (preferredWindowId != null) {
        try {
            const win = await chrome.windows.get(preferredWindowId);
            if (win.type === "normal") return win.id;
        } catch (e) {
            // Fall through to "any normal window".
        }
    }
    try {
        const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
        if (windows.length) return windows[0].id;
    } catch (e) {
        // Ignore.
    }
    return null;
}

// Moving the last tab out of a popup normally closes it; this is the belt-and-
// braces version for the rare window that lingers (and never closes a window
// that still holds other tabs).
async function discardIfEmpty(windowId) {
    try {
        const win = await chrome.windows.get(windowId, { populate: true });
        if (!win.tabs || win.tabs.length === 0) await chrome.windows.remove(windowId);
    } catch (e) {
        // Already gone — which is what we wanted.
    }
}

// --- opening ---------------------------------------------------------------

// DEFAULT: the pad as a real tab in a browser window.
async function openAsTab(sourceTab) {
    const sourceWindowId = sourceTab ? sourceTab.windowId : null;
    const pad = await findPad();

    if (!pad) {
        const tab = await chrome.tabs.create({
            url: PAD_URL,
            windowId: sourceWindowId != null ? sourceWindowId : undefined,
            index: sourceTab && sourceTab.index != null ? sourceTab.index + 1 : undefined
        });
        await closePadsExcept(tab.id);
        return;
    }

    if (pad.windowType === "popup") {
        // Pull the floating window back into the tab strip.
        const targetWindowId = await targetNormalWindowId(sourceWindowId);
        if (targetWindowId != null && targetWindowId !== pad.windowId) {
            try {
                await chrome.tabs.move(pad.tabId, { windowId: targetWindowId, index: -1 });
                await discardIfEmpty(pad.windowId);
                await closePadsExcept(pad.tabId);
                await focusPad({ tabId: pad.tabId, windowId: targetWindowId });
                return;
            } catch (e) {
                // Move failed — just focus what we have.
            }
        }
    }

    await closePadsExcept(pad.tabId);
    await focusPad(pad);
}

// Secondary: the pad as a slim floating window.
async function openAsPopup() {
    const pad = await findPad();

    if (pad && pad.windowType === "popup") {
        await closePadsExcept(pad.tabId);
        await focusPad(pad);
        return;
    }

    // Convert an existing tab (or open fresh): the floating window becomes the
    // single instance, so every other pad is closed right after.
    const win = await createPadWindow();
    const newTabId = win && win.tabs && win.tabs[0] ? win.tabs[0].id : null;
    if (newTabId != null) await closePadsExcept(newTabId);
}

async function createPadWindow() {
    const defaultWidth = 380;
    const defaultHeight = 460;
    const { windowWidth, windowHeight } = await chrome.storage.local.get({
        windowWidth: defaultWidth,
        windowHeight: defaultHeight
    });

    let left, top;
    try {
        const displays = await chrome.system.display.getInfo();
        const primary = displays.find(d => d.isPrimary) || displays[0];
        if (primary) {
            left = Math.max(0, primary.bounds.width - windowWidth - 20);
            top = Math.max(0, primary.bounds.height - windowHeight - 20);
        }
    } catch (e) {
        // system.display not available — let the browser place the window.
    }

    try {
        return await chrome.windows.create({
            url: chrome.runtime.getURL(PAD_PAGE),
            type: "popup",
            width: windowWidth,
            height: windowHeight,
            left,
            top,
            focused: true
        });
    } catch (e) {
        return null;
    }
}

async function closePad() {
    await closePadsExcept(null);
}

// --- entry points ------------------------------------------------------------

// Toolbar click: focus the pad if it is open, otherwise open it as a tab.
chrome.action.onClicked.addListener(async (tab) => {
    const pad = await findPad();
    if (pad) {
        await closePadsExcept(pad.tabId);
        await focusPad(pad);
    } else {
        await openAsTab(tab || null);
    }
});

// Right-click on the toolbar icon: explicit mode choice + close.
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: "ep-as-tab", title: "Open as a browser tab", contexts: ["action"] });
        chrome.contextMenus.create({ id: "ep-as-popup", title: "Open in a floating window", contexts: ["action"] });
        chrome.contextMenus.create({ id: "ep-close", title: "Close Easy Prompting", contexts: ["action"] });
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "ep-as-tab") await openAsTab(tab || (await activeTab()));
    else if (info.menuItemId === "ep-as-popup") await openAsPopup();
    else if (info.menuItemId === "ep-close") await closePad();
});

// The pad's own "Tab / Float" button asks for a conversion.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "ep-switch") return;
    const sourceTab = sender.tab || null;
    const respond = (payload) => { try { sendResponse(payload); } catch (e) { /* sender gone */ } };
    (async () => {
        try {
            if (msg.mode === "popup") await openAsPopup();
            else await openAsTab(sourceTab);
            respond({ ok: true });
        } catch (e) {
            respond({ ok: false, error: String(e && e.message || e) });
        }
    })();
    return true;
});

// Remember the window size the user picks in the floating window, so it
// reopens the same size. Normal browser windows are left alone.
chrome.windows.onBoundsChanged.addListener(async (win) => {
    if (win.type !== "popup" || !win.width || !win.height) return;
    const pad = await findPad();
    if (pad && pad.windowId === win.id) {
        chrome.storage.local.set({ windowWidth: win.width, windowHeight: win.height });
    }
});
