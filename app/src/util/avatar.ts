// Deterministic "initials avatar" used as a default contestant thumbnail when
// no photo is uploaded. Returns an inline SVG string (CSP-safe, no external
// assets), coloured from a fixed palette by a seed.

const PALETTE = [
  '#2f6df4', '#1f9d57', '#e8590c', '#9c36b5',
  '#0c8599', '#c2255c', '#5f3dc4', '#2b8a3e',
];

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

function initials(label: string): string {
  const words = (label || '?').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Inline SVG avatar. `cls` is the CSS class (sizing) applied to the <svg>. */
export function avatarSvg(label: string, seed: number | string, cls = 'option-thumb'): string {
  let h = 0;
  for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const color = PALETTE[h % PALETTE.length];
  const text = escapeXml(initials(label));
  return (
    `<svg class="${cls} avatar" viewBox="0 0 64 64" role="img" aria-label="${escapeXml(label)}">` +
    `<circle cx="32" cy="32" r="32" fill="${color}"/>` +
    `<text x="32" y="33" dy=".35em" font-size="26" font-family="system-ui,Arial,sans-serif" ` +
    `font-weight="700" fill="#ffffff" text-anchor="middle">${text}</text></svg>`
  );
}
