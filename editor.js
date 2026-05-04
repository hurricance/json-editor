"use strict";
// DOM elements
const leftEditor = document.getElementById('left-editor');
const rightEditor = document.getElementById('right-editor');
const leftLineNums = document.getElementById('left-linenums');
const rightLineNums = document.getElementById('right-linenums');
const leftStatus = document.getElementById('left-status');
const rightStatus = document.getElementById('right-status');
// Tracks which values in the original JSON were JSON strings,
// so we can collapse them back when syncing right-to-left.
let jsonStringPaths = [];
let syncingLeft = false;
let syncingRight = false;
// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function debounce(fn, ms) {
    let timer;
    return ((...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), ms);
    });
}
function updateStatus(el, text, cls) {
    el.textContent = text;
    el.className = `status ${cls}`;
}
// Recursively parse every string value that is itself valid JSON.
function deepParse(obj) {
    if (typeof obj === 'string') {
        try {
            return deepParse(JSON.parse(obj));
        }
        catch {
            return obj;
        }
    }
    if (Array.isArray(obj)) {
        return obj.map(deepParse);
    }
    if (obj !== null && typeof obj === 'object') {
        const result = {};
        for (const [k, v] of Object.entries(obj)) {
            result[k] = deepParse(v);
        }
        return result;
    }
    return obj;
}
// Collect paths to every string value that is valid JSON.
function collectJsonStringPaths(obj, path = []) {
    const out = [];
    if (typeof obj === 'string') {
        try {
            JSON.parse(obj);
            out.push([...path]);
        }
        catch { /* not JSON */ }
    }
    else if (Array.isArray(obj)) {
        for (let i = 0; i < obj.length; i++) {
            out.push(...collectJsonStringPaths(obj[i], [...path, String(i)]));
        }
    }
    else if (obj !== null && typeof obj === 'object') {
        for (const [k, v] of Object.entries(obj)) {
            out.push(...collectJsonStringPaths(v, [...path, k]));
        }
    }
    return out;
}
function getAtPath(obj, path) {
    let cur = obj;
    for (const seg of path) {
        if (cur === null || cur === undefined)
            return undefined;
        if (Array.isArray(cur)) {
            cur = cur[parseInt(seg, 10)];
        }
        else {
            cur = cur[seg];
        }
    }
    return cur;
}
function setAtPath(obj, path, value) {
    let cur = obj;
    for (let i = 0; i < path.length - 1; i++) {
        const seg = path[i];
        cur = Array.isArray(cur) ? cur[parseInt(seg, 10)] : cur[seg];
    }
    const last = path[path.length - 1];
    if (Array.isArray(cur)) {
        cur[parseInt(last, 10)] = value;
    }
    else {
        cur[last] = value;
    }
}
// Serialize expanded objects back into JSON strings at the tracked paths.
function collapseJsonStrings(expanded, paths) {
    const clone = JSON.parse(JSON.stringify(expanded));
    for (const p of paths) {
        const val = getAtPath(clone, p);
        if (val !== undefined && typeof val !== 'string') {
            setAtPath(clone, p, JSON.stringify(val));
        }
    }
    return clone;
}
// ---------------------------------------------------------------------------
// Line numbers
// ---------------------------------------------------------------------------
function updateLineNumbers(ta, gutter) {
    const lines = ta.value.split('\n').length;
    const current = gutter.children.length;
    if (lines > current) {
        const frag = document.createDocumentFragment();
        for (let i = current + 1; i <= lines; i++) {
            const span = document.createElement('span');
            span.textContent = String(i);
            frag.appendChild(span);
        }
        gutter.appendChild(frag);
    }
    else if (lines < current) {
        while (gutter.children.length > lines) {
            gutter.removeChild(gutter.lastChild);
        }
    }
    // Sync scroll
    gutter.scrollTop = ta.scrollTop;
}
function bindLineNumbers(ta, gutter) {
    updateLineNumbers(ta, gutter);
    ta.addEventListener('input', () => updateLineNumbers(ta, gutter));
    ta.addEventListener('scroll', () => {
        gutter.scrollTop = ta.scrollTop;
    });
    // Wheel on gutter also scrolls textarea
    gutter.addEventListener('wheel', (e) => {
        ta.scrollTop += e.deltaY;
        e.preventDefault();
    });
}
// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
function syncLeftToRight() {
    if (syncingRight)
        return;
    const raw = leftEditor.value.trim();
    if (!raw) {
        syncingLeft = true;
        rightEditor.value = '';
        syncingLeft = false;
        jsonStringPaths = [];
        updateLineNumbers(rightEditor, rightLineNums);
        updateStatus(rightStatus, '', '');
        return;
    }
    try {
        const parsed = JSON.parse(raw);
        jsonStringPaths = collectJsonStringPaths(parsed);
        const expanded = deepParse(parsed);
        syncingLeft = true;
        rightEditor.value = JSON.stringify(expanded, null, 2);
        syncingLeft = false;
        updateLineNumbers(rightEditor, rightLineNums);
        updateStatus(rightStatus, 'Valid JSON', 'success');
    }
    catch (err) {
        updateStatus(rightStatus, err.message, 'error');
    }
}
function syncRightToLeft() {
    if (syncingLeft)
        return;
    const raw = rightEditor.value.trim();
    if (!raw) {
        syncingRight = true;
        leftEditor.value = '';
        syncingRight = false;
        updateLineNumbers(leftEditor, leftLineNums);
        updateStatus(leftStatus, '', '');
        return;
    }
    try {
        const parsed = JSON.parse(raw);
        const collapsed = collapseJsonStrings(parsed, jsonStringPaths);
        syncingRight = true;
        leftEditor.value = JSON.stringify(collapsed, null, 2);
        syncingRight = false;
        updateLineNumbers(leftEditor, leftLineNums);
        updateStatus(leftStatus, 'Synced', 'success');
    }
    catch (err) {
        updateStatus(leftStatus, err.message, 'error');
    }
}
// ---------------------------------------------------------------------------
// Bind
// ---------------------------------------------------------------------------
bindLineNumbers(leftEditor, leftLineNums);
bindLineNumbers(rightEditor, rightLineNums);
leftEditor.addEventListener('input', debounce(syncLeftToRight, 200));
rightEditor.addEventListener('input', debounce(syncRightToLeft, 200));
// Allow Tab key to insert spaces in the textareas
for (const ta of [leftEditor, rightEditor]) {
    ta.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();
            const start = ta.selectionStart;
            const end = ta.selectionEnd;
            ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
            ta.selectionStart = ta.selectionEnd = start + 2;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
}
