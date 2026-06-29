/**
 * Show a transient global toast message anchored to the viewport.
 *
 * Visual styling lives in app/styles/17-dialogs.css (`.toast` + variants).
 * Positioning is applied inline so toasts layer above all content regardless
 * of stacking context.
 *
 * @param {string} text - Message text.
 * @param {'info'|'success'|'error'} [variant] - Visual variant.
 * @param {number} [duration_ms] - Auto-dismiss delay in milliseconds.
 */
export function showToast(text, variant = 'info', duration_ms = 2800) {
  const host = document.body || document.documentElement;

  const variant_class =
    variant === 'success'
      ? 'toast--success'
      : variant === 'error'
        ? 'toast--error'
        : 'toast--info';

  const el = document.createElement('div');
  el.className = `toast ${variant_class}`;
  el.setAttribute('role', variant === 'error' ? 'alert' : 'status');
  el.textContent = text;

  // Stack multiple toasts so they don't overlap.
  const existing = host.querySelectorAll('.toast').length;
  el.style.position = 'fixed';
  el.style.right = '12px';
  el.style.bottom = `${12 + existing * 48}px`;
  el.style.zIndex = '1000';

  host.appendChild(el);

  // Enter animation: flip to the visible state on the next frame.
  const reveal = () => el.classList.add('toast--visible');
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(reveal);
  } else {
    setTimeout(reveal, 0);
  }

  const remove = () => {
    try {
      el.remove();
    } catch {
      /* ignore */
    }
  };

  setTimeout(() => {
    el.classList.add('toast--leaving');
    setTimeout(remove, 200);
  }, duration_ms);
}
