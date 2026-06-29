/**
 * Build a canonical issue hash that retains the view.
 *
 * @param {'issues'|'epics'|'board'|'timeline'} view
 * @param {string} id
 */
export function issueHashFor(view, id) {
  const v =
    view === 'epics' || view === 'board' || view === 'timeline'
      ? view
      : 'issues';
  return `#/${v}?issue=${encodeURIComponent(id)}`;
}
