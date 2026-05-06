import { EditorView, ViewUpdate, lineNumbers, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { EditorState, Transaction, Annotation } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { codeFolding, foldGutter, foldKeymap, indentOnInput, bracketMatching, syntaxTree } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { parse as losslessParse, stringify as losslessStringify, isLosslessNumber } from 'lossless-json';

// ---------------------------------------------------------------------------
// Dark theme
// ---------------------------------------------------------------------------

const darkTheme = EditorView.theme(
  {
    '&': { backgroundColor: '#1a1a2e', height: '100%' },
    '.cm-scroller': {
      fontFamily: "'SF Mono','Fira Code','Cascadia Code','JetBrains Mono',Menlo,Monaco,monospace",
      fontSize: '13px',
      lineHeight: '1.6',
    },
    '.cm-gutters': {
      backgroundColor: '#16162a',
      color: '#555',
      border: 'none',
      borderRight: '1px solid #0f3460',
    },
    '.cm-activeLineGutter': { backgroundColor: '#16162a' },
    '.cm-activeLine': { backgroundColor: '#ffffff08' },
    '.cm-cursor': { borderLeftColor: '#e0e0e0' },
    '.cm-selectionBackground': { backgroundColor: '#ffffff22 !important' },
    '.cm-foldPlaceholder': {
      backgroundColor: '#ffffff11',
      color: '#888',
      border: '1px solid #333',
    },
    '.cm-matchingBracket': {
      backgroundColor: '#ffffff15',
      outline: '1px solid #555',
    },
  },
  { dark: true },
);

// ---------------------------------------------------------------------------
// Extensions
// ---------------------------------------------------------------------------

function foldLabel(state: EditorState, range: { from: number; to: number }): string | null {
  const tree = syntaxTree(state);
  const node = tree.resolveInner(range.from + 1, -1);
  if (!node) return null;
  if (node.name === 'Array') {
    let cnt = 0;
    const cur = node.cursor();
    if (cur.firstChild()) {
      do { if (cur.name !== '[' && cur.name !== ']' && cur.name !== ',') cnt++; } while (cur.nextSibling());
    }
    return `[... ${cnt}]`;
  }
  if (node.name === 'Object') {
    let cnt = 0;
    const cur = node.cursor();
    if (cur.firstChild()) {
      do { if (cur.name === 'Property') cnt++; } while (cur.nextSibling());
    }
    return `{... ${cnt}}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Manual format keybinding — Shift-Alt-F / Ctrl-Shift-I
// ---------------------------------------------------------------------------

const formatKeymap = keymap.of([
  // Option-Shift-F on macOS, Alt-Shift-F elsewhere (same as VS Code default)
  { key: 'Alt-Shift-f', run: formatActive },
  // Cmd-Option-F on macOS, Ctrl-Alt-F elsewhere
  { key: 'Mod-Alt-f', run: formatActive },
]);

function formatActive(view: EditorView): boolean {
  const oldDoc = view.state.doc.toString();
  try {
    const text = losslessStringify(losslessParse(oldDoc), null, 2)!;
    if (oldDoc === text) return true;

    const pos = view.state.selection.main.head;
    const oldLine = view.state.doc.lineAt(pos);
    const col = pos - oldLine.from;
    let lineStart = 0;
    for (let i = 1; i < oldLine.number && lineStart < text.length; i++) {
      const nx = text.indexOf('\n', lineStart);
      if (nx === -1) break;
      lineStart = nx + 1;
    }
    const lineEnd = text.indexOf('\n', lineStart);
    const lineLen = (lineEnd === -1 ? text.length : lineEnd) - lineStart;
    const newPos = lineStart + Math.min(col, lineLen);

    view.dispatch({
      changes: { from: 0, to: oldDoc.length, insert: text },
      selection: { anchor: newPos },
      annotations: syncAnnotation.of(true),
    });
  } catch {
    /* not valid JSON, ignore */
  }
  return true;
}

const editorExtensions = [
  lineNumbers(),
  drawSelection(),
  highlightActiveLine(),
  history(),
  codeFolding({
    preparePlaceholder(state, range) {
      return foldLabel(state, range);
    },
    placeholderDOM(_view, onclick, prepared: string | null) {
      const span = document.createElement('span');
      span.className = 'cm-foldPlaceholder';
      span.textContent = prepared ?? '…';
      span.onclick = onclick;
      return span;
    },
  }),
  foldGutter(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  json(),
  darkTheme,
  formatKeymap,
  keymap.of([
    ...defaultKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...closeBracketsKeymap,
    indentWithTab,
  ]),
];

// ---------------------------------------------------------------------------
// Transaction annotation — marks programmatic updates so listeners can
// skip them instead of relying on fragile boolean flags.
// ---------------------------------------------------------------------------

const syncAnnotation = Annotation.define<boolean>();

function isSync(update: ViewUpdate): boolean {
  return update.transactions.some((tr: Transaction) => tr.annotation(syncAnnotation));
}

// ---------------------------------------------------------------------------
// JSON utilities — deepParse and collectJsonStringPaths are merged into
// a single tree walk so we avoid parsing the same JSON twice.
// ---------------------------------------------------------------------------

function expandAndTrack(obj: unknown): {
  expanded: unknown;
  paths: string[][];
  originals: Map<string, string>;
} {
  const paths: string[][] = [];
  const originals = new Map<string, string>();
  const expanded = walk(obj, []);
  return { expanded, paths, originals };

  function walk(val: unknown, path: string[]): unknown {
    if (typeof val === 'string') {
      try {
        const inner = losslessParse(val);
        originals.set(JSON.stringify(path), val);
        paths.push([...path]);
        return walk(inner, path);
      } catch {
        return val;
      }
    }
    if (Array.isArray(val)) {
      return val.map((item, i) => walk(item, [...path, String(i)]));
    }
    if (val !== null && typeof val === 'object' && !isLosslessNumber(val)) {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val)) {
        result[k] = walk(v, [...path, k]);
      }
      return result;
    }
    return val;
  }
}

function getAtPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: any = obj;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) ? cur[+seg] : cur[seg];
  }
  return cur;
}

function setAtPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: any = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    cur = Array.isArray(cur) ? cur[+seg] : cur[seg];
  }
  const last = path[path.length - 1];
  if (Array.isArray(cur)) cur[+last] = value;
  else cur[last] = value;
}

function collapseJsonStrings(expanded: unknown, paths: string[][], originals: Map<string, string>): unknown {
  // Deepest first so nested JSON strings collapse correctly.
  // Also clone via stringify→parse so isLosslessNumber checks work.
  const clone = losslessParse(losslessStringify(expanded)!) as Record<string, unknown>;
  const sorted = [...paths].sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    // Verify every intermediate segment is still an object (not a string from a prior collapse).
    let reachable = true;
    let cur: any = clone;
    for (const seg of p) {
      if (cur === null || typeof cur !== 'object' || typeof cur[seg] === 'undefined') { reachable = false; break; }
      cur = cur[seg];
    }
    if (!reachable) continue;
    const val = cur;
    if (typeof val !== 'string' && !isLosslessNumber(val)) {
      const newStr = losslessStringify(val)!;
      const pathKey = JSON.stringify(p);
      const original = originals.get(pathKey);
      // Preserve original formatting when the structure matches.
      if (original && losslessStringify(losslessParse(original)!) === newStr) {
        setAtPath(clone, p, original);
      } else {
        setAtPath(clone, p, newStr);
      }
    }
  }
  return clone;
}

// ---------------------------------------------------------------------------
// Doc helpers
// ---------------------------------------------------------------------------

function getDoc(ed: EditorView): string {
  return ed.state.doc.toString();
}

function setDoc(ed: EditorView, text: string): void {
  const cur = getDoc(ed);
  if (cur === text) return;

  let p = 0;
  while (p < cur.length && p < text.length && cur[p] === text[p]) p++;

  let s = 0;
  const maxS = Math.min(cur.length - p, text.length - p);
  while (s < maxS && cur[cur.length - 1 - s] === text[text.length - 1 - s]) s++;

  ed.dispatch({
    changes: { from: p, to: cur.length - s, insert: text.slice(p, text.length - s) },
    annotations: syncAnnotation.of(true),
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let jsonStringPaths: string[][] = [];
let jsonStringOriginals = new Map<string, string>();
const leftStatus = document.getElementById('left-status')!;
const rightStatus = document.getElementById('right-status')!;

let leftEditor: EditorView;
let rightEditor: EditorView;

let leftTimer: ReturnType<typeof setTimeout> | undefined;
let rightTimer: ReturnType<typeof setTimeout> | undefined;

function updateStatus(el: HTMLElement, text: string, cls: string): void {
  el.textContent = text;
  el.className = `status ${cls}`;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function tryFormatLeft(): void {
  const raw = getDoc(leftEditor).trim();
  if (!raw) return;
  try {
    setDoc(leftEditor, losslessStringify(losslessParse(raw), null, 2)!);
  } catch {
    /* not valid JSON yet */
  }
}

function syncLeftToRight(): void {
  clearTimeout(rightTimer);
  const raw = getDoc(leftEditor).trim();
  if (!raw) {
    setDoc(rightEditor, '');
    jsonStringPaths = [];
    jsonStringOriginals = new Map<string, string>();
    updateStatus(rightStatus, '', '');
    return;
  }
  try {
    const parsed = losslessParse(raw);
    const { expanded, paths, originals } = expandAndTrack(parsed);
    jsonStringPaths = paths;
    jsonStringOriginals = originals;
    setDoc(rightEditor, losslessStringify(expanded, null, 2)!);
    updateStatus(rightStatus, 'Valid JSON', 'success');
  } catch (err) {
    updateStatus(rightStatus, (err as Error).message, 'error');
  }
}

function syncRightToLeft(): void {
  clearTimeout(leftTimer);
  const raw = getDoc(rightEditor).trim();
  if (!raw) {
    setDoc(leftEditor, '');
    updateStatus(leftStatus, '', '');
    return;
  }
  try {
    const parsed = losslessParse(raw);
    const collapsed = collapseJsonStrings(parsed, jsonStringPaths, jsonStringOriginals);
    setDoc(leftEditor, losslessStringify(collapsed, null, 2)!);
    updateStatus(leftStatus, 'Synced', 'success');
  } catch (err) {
    updateStatus(leftStatus, (err as Error).message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Create editors
// ---------------------------------------------------------------------------

leftEditor = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      editorExtensions,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isSync(update)) {
          tryFormatLeft();
          clearTimeout(leftTimer);
          leftTimer = setTimeout(syncLeftToRight, 200);
        }
      }),
    ],
  }),
  parent: document.getElementById('left-editor')!,
});

rightEditor = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      editorExtensions,
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !isSync(update)) {
          clearTimeout(rightTimer);
          rightTimer = setTimeout(syncRightToLeft, 200);
        }
      }),
    ],
  }),
  parent: document.getElementById('right-editor')!,
});

// ---------------------------------------------------------------------------
// Draggable divider
// ---------------------------------------------------------------------------

const divider = document.getElementById('divider')!;
const main = document.querySelector('main')!;
const leftPanel = document.getElementById('left-panel')!;
const rightPanel = document.getElementById('right-panel')!;
let leftRatio = 0.5;

function applyRatio(): void {
  (leftPanel as HTMLElement).style.flex = `${leftRatio} 1 0px`;
  (rightPanel as HTMLElement).style.flex = `${1 - leftRatio} 1 0px`;
}
applyRatio();

divider.addEventListener('mousedown', (e) => {
  e.preventDefault();
  let startX = e.clientX;
  divider.classList.add('active');
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';

  const onMove = (ev: MouseEvent) => {
    const dx = ev.clientX - startX;
    const total = main.offsetWidth;
    if (total > 0) {
      leftRatio = Math.max(0.15, Math.min(0.85, leftRatio + dx / total));
      applyRatio();
    }
    startX = ev.clientX;
  };

  const onUp = () => {
    divider.classList.remove('active');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
});
