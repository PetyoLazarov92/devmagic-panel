/**
 * The SQL runner's editor, CodeMirror, in a chunk of its own. One loader for
 * the runner's lazy() and for a page that opens the runner next (a slow
 * query's Explain), which starts it early; the browser fetches it once.
 */
export const loadSqlEditor = () => import('../components/sql-editor');
