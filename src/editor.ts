import { EditorView, lineNumbers, drawSelection, highlightActiveLine, keymap } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { json } from '@codemirror/lang-json';
import { foldGutter, foldKeymap, indentOnInput, bracketMatching } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';

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

const editorExtensions = [
  lineNumbers(),
  drawSelection(),
  highlightActiveLine(),
  history(),
  foldGutter(),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  json(),
  darkTheme,
  keymap.of([
    ...defaultKeymap,
    ...historyKeymap,
    ...foldKeymap,
    ...closeBracketsKeymap,
    indentWithTab,
  ]),
];

// ---------------------------------------------------------------------------
// JSON utilities
// ---------------------------------------------------------------------------

function deepParse(obj: unknown): unknown {
  if (typeof obj === 'string') {
    try { return deepParse(JSON.parse(obj)); } catch { return obj; }
  }
  if (Array.isArray(obj)) return obj.map(deepParse);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) result[k] = deepParse(v);
    return result;
  }
  return obj;
}

function collectJsonStringPaths(obj: unknown, path: string[] = []): string[][] {
  const out: string[][] = [];
  if (typeof obj === 'string') {
    try { JSON.parse(obj); out.push([...path]); } catch { /* */ }
  } else if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) out.push(...collectJsonStringPaths(obj[i], [...path, String(i)]));
  } else if (obj !== null && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) out.push(...collectJsonStringPaths(v, [...path, k]));
  }
  return out;
}

function getAtPath(obj: Record<string, unknown>, path: string[]): unknown {
  let cur: any = obj;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = Array.isArray(cur) ? cur[parseInt(seg, 10)] : cur[seg];
  }
  return cur;
}

function setAtPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur: any = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    cur = Array.isArray(cur) ? cur[parseInt(seg, 10)] : cur[seg];
  }
  const last = path[path.length - 1];
  if (Array.isArray(cur)) cur[parseInt(last, 10)] = value;
  else cur[last] = value;
}

function collapseJsonStrings(expanded: unknown, paths: string[][]): unknown {
  const clone = JSON.parse(JSON.stringify(expanded));
  for (const p of paths) {
    const val = getAtPath(clone, p);
    if (val !== undefined && typeof val !== 'string') setAtPath(clone, p, JSON.stringify(val));
  }
  return clone;
}

function getDoc(ed: EditorView): string {
  return ed.state.doc.toString();
}

function setDoc(ed: EditorView, text: string): void {
  if (getDoc(ed) === text) return;
  // Replace only the changed middle section so the cursor is mapped
  // through the change rather than being reset to 0.
  const cur = getDoc(ed);
  let p = 0;
  while (p < cur.length && p < text.length && cur[p] === text[p]) p++;
  let s = 0;
  const maxS = Math.min(cur.length - p, text.length - p);
  while (s < maxS && cur[cur.length - 1 - s] === text[text.length - 1 - s]) s++;
  ed.dispatch({
    changes: {
      from: p,
      to: cur.length - s,
      insert: text.slice(p, text.length - s),
    },
  });
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let jsonStringPaths: string[][] = [];
const leftStatus = document.getElementById('left-status')!;
const rightStatus = document.getElementById('right-status')!;

let leftEditor: EditorView;
let rightEditor: EditorView;

let suppressLeft = false;
let suppressRight = false;
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
  const raw = getDoc(leftEditor);
  if (!raw.trim()) return;
  try {
    const formatted = JSON.stringify(JSON.parse(raw), null, 2);
    if (getDoc(leftEditor) !== formatted) {
      suppressLeft = true;
      setDoc(leftEditor, formatted);
    }
  } catch { /* not valid JSON yet */ }
}

function syncLeftToRight(): void {
  const raw = getDoc(leftEditor).trim();
  if (!raw) {
    suppressRight = true;
    setDoc(rightEditor, '');
    jsonStringPaths = [];
    updateStatus(rightStatus, '', '');
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    jsonStringPaths = collectJsonStringPaths(parsed);
    const expanded = deepParse(parsed);
    suppressRight = true;
    setDoc(rightEditor, JSON.stringify(expanded, null, 2));
    updateStatus(rightStatus, 'Valid JSON', 'success');
  } catch (err) {
    updateStatus(rightStatus, (err as Error).message, 'error');
  }
}

function syncRightToLeft(): void {
  const raw = getDoc(rightEditor).trim();
  if (!raw) {
    suppressLeft = true;
    setDoc(leftEditor, '');
    updateStatus(leftStatus, '', '');
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    const collapsed = collapseJsonStrings(parsed, jsonStringPaths);
    suppressLeft = true;
    setDoc(leftEditor, JSON.stringify(collapsed, null, 2));
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
        if (update.docChanged) {
          if (suppressLeft) { suppressLeft = false; return; }
          // Format left in the same frame if JSON is already valid
          tryFormatLeft();
          // Debounce the heavier expand→right sync
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
        if (update.docChanged) {
          if (suppressRight) { suppressRight = false; return; }
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
