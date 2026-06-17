// apps/_shared/markdown.entry.js
//
// v0.3.1.18: Browser entry for Markdown rendering.
// Bundled by esbuild into apps/_shared/markdown.bundle.js.
// Exposes window.marked.render(text) for chat/dashboard bubbles.
//
// Decision 2: Stream-as-plain-text, render after session_done (see §5.6.x.1).
// Decision 3: Register only 5 languages (js / ts / python / bash / json) to keep bundle small.

import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';

// Register only the 5 languages decided in §9.14.0.
// Other languages fall back to 'plaintext' (no highlight, no error).
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);

const renderer = marked.use(markedHighlight({
  langPrefix: 'hljs language-',
  highlight(code, lang) {
    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
    return hljs.highlight(code, { language }).value;
  },
}));

// Expose a small, well-defined API on window for the chat/dashboard pages.
window.marked = {
  /**
   * Render markdown text to HTML.
   * - Default-escapes raw HTML (XSS-safe per §5.6.x.4)
   * - GFM enabled (tables, strikethrough, task lists)
   * - breaks: false (don't convert \n to <br>; preserve markdown semantics)
   * - headerIds: false, mangle: false (no id injection)
   *
   * @param {string} text - Markdown source
   * @returns {string} HTML string
   */
  render(text) {
    return renderer.parse(text || '', {
      breaks: false,
      gfm: true,
      headerIds: false,
      mangle: false,
    });
  },
};

// Optional: a tiny "ready" marker so pages can wait for marked before rendering.
window.marked.ready = true;
