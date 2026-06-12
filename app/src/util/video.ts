// Resolve a configured video URL into an embed descriptor for the landing page.
export interface VideoEmbed {
  type: 'youtube' | 'file' | 'none';
  src: string;
  id?: string;
}

/**
 * Detects YouTube links (youtu.be/ID, youtube.com/watch?v=ID, /embed/ID,
 * /shorts/ID) and returns a privacy-enhanced nocookie embed URL. Anything else
 * non-empty is treated as a direct video file.
 */
export function parseVideoUrl(url?: string | null): VideoEmbed {
  if (!url) return { type: 'none', src: '' };
  const u = url.trim();
  const yt = u.match(
    /(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([A-Za-z0-9_-]{6,})/,
  );
  if (yt) {
    return {
      type: 'youtube',
      src: `https://www.youtube-nocookie.com/embed/${yt[1]}?rel=0&modestbranding=1`,
    };
  }
  return { type: 'file', src: u };
}
