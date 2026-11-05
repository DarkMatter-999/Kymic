import type { CanvasPayload } from '../../server/gateway/canvas';

/**
 * The iframe sandbox for agent-generated canvases. `allow-same-origin` must
 * never be combined with `allow-scripts`: it would let the canvas reach the
 * authenticated app (cookies, storage, parent DOM). Without it the frame has an
 * opaque origin, so it can read nothing from the app.
 */
export const CANVAS_SANDBOX =
  'allow-scripts allow-forms allow-popups allow-modals';

/**
 * Content-Security-Policy for the canvas document. It blocks every network
 * request (fetch, XHR, WebSocket, images, forms), so a canvas cannot send data
 * anywhere. Inline script and style, and data:/blob: media, still work.
 */
export const CANVAS_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

/** The only message the canvas frame honors from its parent. */
export const CANVAS_PRINT_MESSAGE = 'canvas:print';

// A closing tag in the content would end our wrapper element early.
const safeInline = (value: string, tag: 'script' | 'style') =>
  value.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');

export function buildCanvasDocument(canvas: CanvasPayload): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
${safeInline(canvas.css, 'style')}
    </style>
  </head>
  <body>
${canvas.html}
    <script>
      window.addEventListener('message', function (event) {
        if (event.source === window.parent && event.data === '${CANVAS_PRINT_MESSAGE}') window.print();
      });
      try {
${safeInline(canvas.js, 'script')}
      } catch (err) {
        console.error('Canvas JS Error:', err);
      }
    </script>
  </body>
</html>`;
}
