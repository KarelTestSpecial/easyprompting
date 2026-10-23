// Easy Prompting — pad logic.
// Data model mirrors the trusted "Clock & Notepad" notepad: an array of
// { id, title, content } plus an activeNoteId, autosaved to chrome.storage.local.
// Everything clock-related is gone; copy / counter / size controls are added.

const DEFAULTS = {
    notes: null,            // filled in on load with a localized title
    activeNoteId: null,
    fontSize: 1.0,          // em
    undoStack: []
};

let notes = [];
let activeNoteId = null;
let undoStack = [];

// --- DOM refs ---
let padArea, tabsList, addTabBtn, copyBtn, clearBtn, undoBtn, counterEl;
let fontSmaller, fontBigger, helpBtn, statusEl, statusTextEl, statusUndoBtn;
let helpModal, helpClose, modeBtn;
let isFloating = false;
let statusTimeout = null;

// --- Where do I live? -------------------------------------------------------
// The background service worker asks this to find the pad without needing the
// "tabs" permission: the pad knows its own tab and window.
async function describeSelf() {
    try {
        const tab = await chrome.tabs.getCurrent();
        const win = await chrome.windows.getCurrent();
        return {
            tabId: tab ? tab.id : null,
            windowId: win ? win.id : null,
            windowType: win ? win.type : null
        };
    } catch (e) {
        return null;
    }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== "ep-where-are-you") return;
    describeSelf().then(sendResponse);
    return true;
});

async function refreshModeButton() {
    const self = await describeSelf();
    isFloating = !!(self && self.windowType === "popup");
    modeBtn.textContent = isFloating ? "Tab" : "Float";
    modeBtn.title = isFloating
        ? "Move this pad into a browser tab"
        : "Open this pad in a floating window without toolbars";
}

async function switchMode() {
    const mode = isFloating ? "tab" : "popup";
    showStatus(isFloating ? "Moving to a tab…" : "Opening floating window…");
    try {
        await chrome.runtime.sendMessage({ type: "ep-switch", mode });
    } catch (e) {
        showStatus("Could not switch.");
        return;
    }
    await refreshModeButton();
}

// Removed t() function
document.addEventListener('DOMContentLoaded', init);

async function init() {
    cacheDom();
    await loadState();
    renderTabs();
    loadActiveIntoPad();
    applyFontSize();
    updateCounter();
    wireEvents();
    refreshModeButton();
    padArea.focus();
}

function cacheDom() {
    padArea = document.getElementById('pad-area');
    tabsList = document.getElementById('tabs-list');
    addTabBtn = document.getElementById('add-tab-btn');
    copyBtn = document.getElementById('copy-btn');
    clearBtn = document.getElementById('clear-btn');
    undoBtn = document.getElementById('undo-btn');
    counterEl = document.getElementById('counter');
    fontSmaller = document.getElementById('font-smaller');
    fontBigger = document.getElementById('font-bigger');
    helpBtn = document.getElementById('help-btn');
    statusEl = document.getElementById('status-message');
    statusTextEl = document.getElementById('status-text');
    statusUndoBtn = document.getElementById('status-undo-btn');
    helpModal = document.getElementById('help-modal');
    helpClose = document.getElementById('help-close');
    modeBtn = document.getElementById('mode-btn');
}

// localizeStatic removed
async function loadState() {
    const stored = await chrome.storage.local.get(DEFAULTS);
    notes = Array.isArray(stored.notes) ? stored.notes : null;
    activeNoteId = stored.activeNoteId;
    undoStack = Array.isArray(stored.undoStack) ? stored.undoStack : [];

    if (!notes || notes.length === 0) {
        notes = [{ id: 'default', title: 'Prompt 1', content: '' }];
        activeNoteId = 'default';
        await persist();
    }
    if (!notes.find(n => n.id === activeNoteId)) {
        activeNoteId = notes[0].id;
    }

    DEFAULTS.fontSize = stored.fontSize || 1.0;
    updateUndoButton();
}

async function persist() {
    try {
        await chrome.storage.local.set({ notes, activeNoteId, undoStack });
    } catch (e) {
        showStatus('Storage limit reached!');
    }
}

// --- Undo Stack ---
function pushUndo(action) {
    undoStack.push(action);
    if (undoStack.length > 30) {
        undoStack = undoStack.slice(-30);
    }
    updateUndoButton();
}

function updateUndoButton() {
    if (!undoBtn) return;
    if (!undoStack || undoStack.length === 0) {
        undoBtn.disabled = true;
        undoBtn.title = 'Nothing to undo (Alt+Z)';
    } else {
        undoBtn.disabled = false;
        const last = undoStack[undoStack.length - 1];
        undoBtn.title = `Undo: ${last.description || 'last action'} (Alt+Z)`;
    }
}

async function undoLast() {
    if (!undoStack || undoStack.length === 0) {
        showStatus('Nothing to undo');
        return;
    }
    syncActiveFromPad();
    const action = undoStack.pop();

    if (action.type === 'delete-tab') {
        const { note, index } = action;
        let restoredId = note.id;
        if (notes.some(n => n.id === restoredId)) {
            restoredId = Date.now().toString();
        }
        const restoredNote = { ...note, id: restoredId };
        const insertIndex = Math.min(Math.max(0, index), notes.length);
        notes.splice(insertIndex, 0, restoredNote);
        activeNoteId = restoredId;
        loadActiveIntoPad();
        renderTabs();
        updateCounter();
        updateUndoButton();
        await persist();
        showStatus(`Restored tab "${restoredNote.title || 'Prompt'}"`);
        padArea.focus();
    } else if (action.type === 'clear-tab') {
        const { noteId, previousContent } = action;
        let note = notes.find(n => n.id === noteId);
        if (!note) {
            const newNote = { id: noteId, title: action.noteTitle || 'Prompt', content: previousContent };
            notes.push(newNote);
            activeNoteId = newNote.id;
        } else {
            note.content = previousContent;
            activeNoteId = noteId;
        }
        loadActiveIntoPad();
        renderTabs();
        updateCounter();
        updateUndoButton();
        await persist();
        showStatus(`Restored text in "${note ? note.title : 'Prompt'}"`);
        padArea.focus();
    }
}

// --- Tabs ---
function renderTabs() {
    tabsList.innerHTML = '';
    notes.forEach(note => {
        const tab = document.createElement('div');
        tab.className = `tab${note.id === activeNoteId ? ' active' : ''}`;
        tab.dataset.id = note.id;

        const title = document.createElement('span');
        title.className = 'tab-title';
        title.textContent = note.title || 'Prompt';
        tab.appendChild(title);

        const del = document.createElement('span');
        del.className = 'delete-tab';
        del.innerHTML = '&times;';
        del.title = 'Delete tab';
        del.onclick = (e) => { e.stopPropagation(); deleteTab(note.id); };
        tab.appendChild(del);

        tab.onclick = () => switchTab(note.id);
        tab.ondblclick = () => renameTab(note.id);
        tabsList.appendChild(tab);
    });
}

function loadActiveIntoPad() {
    const note = notes.find(n => n.id === activeNoteId);
    padArea.value = note ? note.content : '';
}

function syncActiveFromPad() {
    const note = notes.find(n => n.id === activeNoteId);
    if (note) note.content = padArea.value;
}

async function switchTab(id) {
    if (id === activeNoteId) return;
    syncActiveFromPad();
    activeNoteId = id;
    loadActiveIntoPad();
    renderTabs();
    updateCounter();
    await persist();
    padArea.focus();
    padArea.setSelectionRange(padArea.value.length, padArea.value.length);
}

async function addTab() {
    syncActiveFromPad();
    const id = Date.now().toString();
    notes.push({ id, title: `Prompt ${notes.length + 1}`, content: '' });
    activeNoteId = id;
    loadActiveIntoPad();
    renderTabs();
    updateCounter();
    await persist();
    padArea.focus();
}

async function deleteTab(id) {
    if (notes.length <= 1) {
        showStatus('Cannot delete the last tab.');
        return;
    }
    syncActiveFromPad();
    const index = notes.findIndex(n => n.id === id);
    if (index === -1) return;
    const deletedNote = { ...notes[index] };

    if (!confirm(`Delete tab "${deletedNote.title || 'Prompt'}"?`)) return;

    notes.splice(index, 1);
    pushUndo({
        type: 'delete-tab',
        note: deletedNote,
        index: index,
        description: `Deleted tab "${deletedNote.title || 'Prompt'}"`
    });

    if (activeNoteId === id) {
        const newIndex = Math.min(index, notes.length - 1);
        activeNoteId = notes[newIndex].id;
        loadActiveIntoPad();
    }
    renderTabs();
    updateCounter();
    await persist();
    showStatus(`Deleted tab "${deletedNote.title || 'Prompt'}"`, true);
}

function renameTab(id) {
    const note = notes.find(n => n.id === id);
    if (!note) return;
    const title = prompt('Enter new title:', note.title);
    if (title !== null && title.trim() !== '') {
        note.title = title.trim();
        renderTabs();
        persist();
    }
}

// --- Autosave ---
async function onInput() {
    syncActiveFromPad();
    updateCounter();
    await persist();
}

// --- Copy / Clear ---
async function copyCurrent() {
    try {
        await navigator.clipboard.writeText(padArea.value);
        showStatus('Copied!');
    } catch (e) {
        // Fallback for environments without async clipboard.
        padArea.select();
        document.execCommand('copy');
        padArea.setSelectionRange(padArea.value.length, padArea.value.length);
        showStatus('Copied!');
    }
    padArea.focus();
}

async function clearCurrent() {
    syncActiveFromPad();
    const note = notes.find(n => n.id === activeNoteId);
    if (!note || !padArea.value) return;
    if (!confirm('Clear all text in this tab?')) return;

    const previousContent = padArea.value;
    pushUndo({
        type: 'clear-tab',
        noteId: note.id,
        noteTitle: note.title,
        previousContent: previousContent,
        description: `Cleared tab "${note.title || 'Prompt'}"`
    });

    padArea.value = '';
    syncActiveFromPad();
    updateCounter();
    await persist();
    padArea.focus();
    showStatus(`Cleared tab "${note.title || 'Prompt'}"`, true);
}

// --- Counter ---
function updateCounter() {
    const text = padArea.value;
    const chars = text.length;
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    counterEl.textContent = `${words} words · ${chars} chars`;
}

// --- Font size ---
function applyFontSize() {
    if (padArea) padArea.style.fontSize = `${DEFAULTS.fontSize}em`;
}
async function changeFont(delta) {
    DEFAULTS.fontSize = Math.min(2.5, Math.max(0.7, +(DEFAULTS.fontSize + delta).toFixed(2)));
    applyFontSize();
    await chrome.storage.local.set({ fontSize: DEFAULTS.fontSize });
}

// --- Status toast ---
function showStatus(msg, allowUndo = false) {
    if (statusTimeout) clearTimeout(statusTimeout);
    if (statusTextEl) {
        statusTextEl.textContent = msg;
    } else {
        statusEl.textContent = msg;
    }
    if (statusUndoBtn) {
        if (allowUndo && undoStack && undoStack.length > 0) {
            statusUndoBtn.classList.remove('hidden');
        } else {
            statusUndoBtn.classList.add('hidden');
        }
    }
    statusEl.classList.add('visible');
    const delay = allowUndo ? 6000 : 1800;
    statusTimeout = setTimeout(() => {
        statusEl.classList.remove('visible');
        if (statusUndoBtn) statusUndoBtn.classList.add('hidden');
    }, delay);
}

// --- Keyboard navigation & shortcuts ---
function onKeyDown(e) {
    const isAltZ = e.altKey && e.key.toLowerCase() === 'z';
    const isCtrlShiftZ = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z';
    if (isAltZ || isCtrlShiftZ) {
        e.preventDefault();
        undoLast();
        return;
    }

    if (!notes || notes.length <= 1) return;
    const idx = notes.findIndex(n => n.id === activeNoteId);
    if (idx === -1) return;
    let next = -1;

    if (e.altKey && ['e', 'r'].includes(e.key.toLowerCase())) {
        e.preventDefault();
        next = e.key.toLowerCase() === 'e'
            ? (idx - 1 + notes.length) % notes.length
            : (idx + 1) % notes.length;
    } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        next = e.key === 'ArrowLeft'
            ? (idx - 1 + notes.length) % notes.length
            : (idx + 1) % notes.length;
    } else if (e.ctrlKey && (e.key === '[' || e.key === ']')) {
        e.preventDefault();
        next = e.key === '['
            ? (idx - 1 + notes.length) % notes.length
            : (idx + 1) % notes.length;
    } else if (e.altKey && e.key >= '1' && e.key <= '9') {
        const target = parseInt(e.key, 10) - 1;
        if (target < notes.length) { e.preventDefault(); next = target; }
    }

    if (next !== -1) switchTab(notes[next].id);
}

function wireEvents() {
    padArea.addEventListener('input', onInput);
    padArea.addEventListener('keydown', onKeyDown);
    addTabBtn.addEventListener('click', addTab);
    copyBtn.addEventListener('click', copyCurrent);
    clearBtn.addEventListener('click', clearCurrent);
    undoBtn.addEventListener('click', undoLast);
    statusUndoBtn.addEventListener('click', () => {
        undoLast();
        statusEl.classList.remove('visible');
        statusUndoBtn.classList.add('hidden');
    });
    fontSmaller.addEventListener('click', () => changeFont(-0.1));
    fontBigger.addEventListener('click', () => changeFont(0.1));
    modeBtn.addEventListener('click', switchMode);
    helpBtn.addEventListener('click', () => helpModal.classList.remove('hidden'));
    helpClose.addEventListener('click', () => helpModal.classList.add('hidden'));
    helpModal.addEventListener('click', (e) => {
        if (e.target === helpModal) helpModal.classList.add('hidden');
    });

    // Global listener so shortcuts like Alt+Z and Ctrl+Shift+Z work anywhere in the window
    window.addEventListener('keydown', (e) => {
        const isAltZ = e.altKey && e.key.toLowerCase() === 'z';
        const isCtrlShiftZ = (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z';
        const isCtrlZOutsidePad = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z' && document.activeElement !== padArea;

        if (isAltZ || isCtrlShiftZ || isCtrlZOutsidePad) {
            e.preventDefault();
            undoLast();
        }
    });
}
