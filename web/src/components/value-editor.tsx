import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { drawSelection, EditorView, highlightSpecialChars, keymap } from '@codemirror/view';
import { useEffect, useRef } from 'react';

/**
 * A row value's editor for text a plain text box would change or hide
 * (CodeMirror 6, loaded only when such a value is edited). Control characters
 * show as PHP writes them, `\0` for a NUL byte, and stay in the value as the
 * real character; only `\n` breaks a line, so a carriage return stays too.
 * Copy and paste keep them, as CodeMirror copies from its own text.
 */
export interface ValueEditorProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
}

const theme = EditorView.theme({
  '&': {
    maxHeight: '15rem',
    backgroundColor: 'transparent',
    color: 'var(--foreground)',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.5', overflow: 'auto' },
  '.cm-content': { padding: '6px 0', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0 10px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 22%, transparent) !important',
  },
  '.cm-dmp-control': {
    margin: '0 1px',
    padding: '0 2px',
    borderRadius: '3px',
    backgroundColor: 'color-mix(in oklch, var(--foreground) 10%, transparent)',
    color: 'var(--muted-foreground)',
  },
});

/** A control character's name the way PHP writes it. */
function label(code: number): string {
  if (code === 0) return '\\0';
  if (code === 13) return '\\r';
  if (code < 0x80) return `\\x${code.toString(16).toUpperCase().padStart(2, '0')}`;
  return `\\u{${code.toString(16).toUpperCase()}}`;
}

const controls = highlightSpecialChars({
  render(code) {
    const el = document.createElement('span');
    el.className = 'cm-dmp-control';
    el.textContent = label(code);
    el.title = code === 0 ? 'A NUL byte' : code === 13 ? 'A carriage return' : 'A control character';
    return el;
  },
});

export default function ValueEditor({ id, value, onChange }: ValueEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const change = useRef(onChange);
  change.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          // Only \n breaks a line, and joins them again: a \r stays in the value as it was.
          EditorState.lineSeparator.of('\n'),
          history(),
          drawSelection(),
          controls,
          keymap.of([...historyKeymap, ...defaultKeymap]),
          theme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ id, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) change.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Made once; a value set from outside (Count the lengths again) follows below.
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  return (
    <div
      ref={host}
      className="w-full min-w-0 rounded-md border border-input bg-card shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25"
    />
  );
}
