import { acceptCompletion, autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { MySQL, sql } from '@codemirror/lang-sql';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { Compartment, EditorState, Prec } from '@codemirror/state';
import { drawSelection, EditorView, keymap, placeholder as placeholderText } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

/**
 * The SQL runner's editor (CodeMirror 6, loaded only with the SQL view):
 * MySQL's keywords coloured and suggested, the database's own tables as you
 * type and a table's columns after "table.". Tab takes a suggestion or
 * indents; Escape then Tab leaves the editor; Ctrl+Enter runs.
 */
export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  /** Table names with their columns, from the database. */
  schema?: Record<string, string[]>;
  label: string;
  placeholder?: string;
}

// Colours come from the theme's tokens, so the editor follows light and dark like the rest of the panel.
const theme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--card)',
    color: 'var(--foreground)',
    border: '1px solid var(--input)',
    borderRadius: 'calc(var(--radius) - 2px)',
    fontSize: '13px',
  },
  '&.cm-focused': { outline: 'none', borderColor: 'var(--ring)', boxShadow: '0 0 0 3px color-mix(in oklch, var(--ring) 25%, transparent)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6', maxHeight: '22rem', overflow: 'auto' },
  '.cm-content': { padding: '8px 0', minHeight: '9rem', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 22%, transparent) !important',
  },
  '.cm-placeholder': { color: 'var(--muted-foreground)' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in oklch, var(--primary) 18%, transparent)', outline: 'none' },
  '.cm-tooltip': { backgroundColor: 'var(--card)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 'calc(var(--radius) - 2px)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px', maxHeight: '16rem' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' },
  '.cm-completionDetail': { color: 'inherit', opacity: '0.7', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-completionIcon': { display: 'none' },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier], color: 'var(--code-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.standard(tags.name)], color: 'var(--code-keyword)' },
]);

const language = (schema: SqlEditorProps['schema']) => sql({ dialect: MySQL, upperCaseKeywords: true, ...(schema ? { schema } : {}) });

export default function SqlEditor({ value, onChange, onRun, schema, label, placeholder }: SqlEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const lang = useRef(new Compartment());
  // The newest callbacks, without making the editor again.
  const run = useRef(onRun);
  const change = useRef(onChange);
  run.current = onRun;
  change.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => (run.current(), true) }, { key: 'Tab', run: acceptCompletion }])),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion({ activateOnTyping: true, icons: false }),
          keymap.of([...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
          lang.current.of(language(schema)),
          syntaxHighlighting(highlight),
          theme,
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
          ...(placeholder ? [placeholderText(placeholder)] : []),
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
    // Made once; value, schema and callbacks follow through the effects and refs below.
  }, []);

  // The tables arrive after the editor: its suggestions take them in then.
  useEffect(() => {
    view.current?.dispatch({ effects: lang.current.reconfigure(language(schema)) });
  }, [schema]);

  // A statement picked from the history replaces what is typed.
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} />;
}
