/**
 * Known status values in canonical order.
 *
 * @type {Array<'open'|'in_progress'|'closed'>}
 */
export const STATUSES = ['open', 'in_progress', 'closed'];

/**
 * Map canonical status to display label.
 *
 * @param {string | null | undefined} status
 * @returns {string}
 */
export function statusLabel(status) {
  switch ((status || '').toString()) {
    case 'open':
      return 'Open';
    case 'in_progress':
      return 'In progress';
    case 'closed':
      return 'Closed';
    default:
      return (status || '').toString() || 'Open';
  }
}

/**
 * Humanize an arbitrary status name into a display label.
 * Known canonical statuses use {@link statusLabel}; others are derived from the
 * raw name (snake/kebab → Title Case), so custom statuses configured in bd
 * render sensibly without a hardcoded mapping.
 *
 * @param {string | null | undefined} status
 * @returns {string}
 */
export function humanizeStatus(status) {
  const raw = (status || '').toString().trim();
  if (raw.length === 0) {
    return 'Open';
  }
  if (raw === 'open' || raw === 'in_progress' || raw === 'closed') {
    return statusLabel(raw);
  }
  return raw
    .split(/[_\-\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
