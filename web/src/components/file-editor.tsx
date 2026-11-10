import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { php } from '@codemirror/lang-php';
import { MySQL, sql } from '@codemirror/lang-sql';
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension, Prec } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

/**
 * The Files tab's editor (CodeMirror 6, loaded only when you press Edit):
 * line numbers, the file's language coloured by its ending, Ctrl+F to find
 * and Ctrl+S to save. Tab indents; Escape then Tab leaves the editor.
 */
export interface FileEditorProps {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  /** The file's name: its ending picks the language. */
  name: string;
  label: string;
  /** The line to start on. */
  line?: number | undefined;
}

const theme = EditorView.theme({
  '&': { maxHeight: '70vh', backgroundColor: 'var(--card)', color: 'var(--foreground)', fontSize: '12px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65', overflow: 'auto' },
  '.cm-content': { padding: '8px 0', caretColor: 'var(--foreground)' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': { backgroundColor: 'var(--card)', color: 'var(--muted-foreground)', borderRight: '1px solid var(--border)' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '3ch' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--muted) 60%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'color-mix(in oklch, var(--muted) 60%, transparent)', color: 'var(--foreground)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--foreground)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in oklch, var(--primary) 22%, transparent) !important',
  },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in oklch, var(--primary) 18%, transparent)', outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in oklch, var(--primary) 12%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklch, var(--warning) 30%, transparent)', outline: 'none' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklch, var(--warning) 60%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--card)', color: 'var(--foreground)', borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panel.cm-search': { padding: '8px 12px', fontFamily: 'var(--font-sans)', fontSize: '12px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px' },
  '.cm-panel.cm-search br': { display: 'none' },
  '.cm-panel.cm-search label': { display: 'inline-flex', alignItems: 'center', gap: '4px', margin: '0', color: 'var(--muted-foreground)' },
  '.cm-textfield': { backgroundColor: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--input)', borderRadius: 'calc(var(--radius) - 4px)', padding: '3px 8px', margin: '0', fontSize: '12px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 'calc(var(--radius) - 4px)', padding: '3px 8px', margin: '0', fontSize: '12px', cursor: 'pointer' },
  '.cm-button:hover': { backgroundColor: 'var(--muted)' },
  '.cm-panel.cm-search [name=close]': { color: 'var(--muted-foreground)', fontSize: '18px', cursor: 'pointer', padding: '0 4px' },
});

const highlight = HighlightStyle.define([
  { tag: [tags.keyword, tags.operatorKeyword, tags.modifier, tags.controlKeyword, tags.definitionKeyword, tags.moduleKeyword], color: 'var(--code-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp, tags.attributeValue], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom, tags.unit, tags.color], color: 'var(--code-number)' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment, tags.docComment, tags.meta], color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [tags.typeName, tags.className, tags.tagName, tags.namespace, tags.standard(tags.name)], color: 'var(--code-keyword)' },
  { tag: [tags.propertyName, tags.attributeName, tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--code-number)' },
]);

/** The language of a file by its ending; a file of another kind is plain text. */
export function languageOf(name: string): Extension[] {
  const ext = name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '';
  switch (ext) {
    case 'php': case 'inc': case 'module': case 'phtml':
      return [php()];
    case 'js': case 'mjs': case 'cjs':
      return [javascript()];
    case 'jsx':
      return [javascript({ jsx: true })];
    case 'ts':
      return [javascript({ typescript: true })];
    case 'tsx':
      return [javascript({ typescript: true, jsx: true })];
    case 'css': case 'scss': case 'less':
      return [css()];
    case 'html': case 'htm': case 'twig': case 'svg': case 'xml':
      return [html()];
    case 'json': case 'map': case 'lock':
      return [json()];
    case 'sql':
      return [sql({ dialect: MySQL })];
    default:
      return [];
  }
}

export default function FileEditor({ value, onChange, onSave, name, label, line }: FileEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The newest callbacks, without making the editor again.
  const save = useRef(onSave);
  const change = useRef(onChange);
  save.current = onSave;
  change.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          Prec.highest(keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => (save.current(), true) }])),
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          search({ top: true }),
          highlightSelectionMatches(),
          // The file's own indent: tabs when it has them (WordPress's style), two spaces otherwise.
          indentUnit.of(/^\t/m.test(value) || !/^ {2,}\S/m.test(value) ? '\t' : /^ {2}\S/m.test(value) ? '  ' : '    '),
          EditorState.tabSize.of(4),
          keymap.of([...closeBracketsKeymap, ...searchKeymap, ...historyKeymap, indentWithTab, ...defaultKeymap]),
          ...languageOf(name),
          syntaxHighlighting(highlight),
          theme,
          EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) change.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    if (line && line >= 1 && line <= editor.state.doc.lines) {
      const at = editor.state.doc.line(line).from;
      editor.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) });
    }
    editor.focus();
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Made once per file; the value and callbacks follow through the effect and refs below.
  }, [name]);

  // Discard, or the file read again from disk, replaces what is typed.
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={host} />;
}
