/* The words a page shows, for the key points Chrome's Summarizer writes in SecondHand's side panel.
   Only the visible main text: form controls and their choices, SecondHand's own widget, scripts,
   styles, and anything hidden are left out, so a typed or saved answer is never part of it.
   No network or storage. */
(function (root) {
  'use strict';
  // The most one page sends (about 4,000 tokens). The side panel splits it to fit Chrome's summarizer.
  const MAX_CHARS = 16000;
  const WIDGETS = ['button', 'checkbox', 'radio', 'radiogroup', 'switch', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
    'spinbutton', 'slider', 'menu', 'menubar', 'menuitem', 'tablist', 'tab'];
  // Never read: code, media, embedded frames (each frame reads itself), SecondHand's widget, and form
  // controls with their choices, whose words can be an answer.
  const LEFT_OUT = ['script', 'style', 'noscript', 'template', 'head', 'svg', 'math', 'canvas', 'iframe', 'frame', 'object', 'embed', 'img', 'picture',
    'video', 'audio', 'input', 'select', 'textarea', 'button', 'option', 'optgroup', 'datalist', 'output', 'progress', 'meter',
    '[contenteditable]:not([contenteditable="false"])', '[data-secondhand-assistant]', ...WIDGETS.map(role => `[role="${role}"]`)].join(', ');
  // Site navigation, side notes, and the site's own header and footer are not what the page says.
  const AROUND = 'nav, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"], [role="search"]';
  const SECTION = 'main, article, section, form, [role="main"], [role="form"], [role="region"], [role="article"]';
  // Each of these starts a new line of the page's text.
  const BLOCK = ['address', 'article', 'blockquote', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer',
    'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'label', 'legend', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr',
    'ul', '[role="heading"]', '[role="listitem"]', '[role="paragraph"]'].join(', ');
  const CHOICE = 'input[type="radio"], input[type="checkbox"], [role="radio"], [role="checkbox"]';

  // A label that names one choice of a radio or checkbox question is part of the control.
  const choiceLabel = element => element.localName === 'label' && Boolean(element.control?.matches(CHOICE) || element.querySelector(CHOICE));
  const pageEdge = element => ['header', 'footer'].includes(element.localName) && !element.parentElement?.closest(SECTION);

  function leftOut(element, top) {
    return element !== top && (element.matches(LEFT_OUT) || element.matches(AROUND) || pageEdge(element) || choiceLabel(element));
  }

  // Shown on screen: not hidden by an attribute or a style here or above, and taking up room.
  function shown(element, seen) {
    if (!element || element.nodeType !== 1) return true;
    if (seen.has(element)) return seen.get(element);
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    const own = !element.hidden && !element.hasAttribute('inert') && element.getAttribute('aria-hidden') !== 'true' && style.display !== 'none' &&
      style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.opacity !== '0';
    const result = own && shown(element.parentElement, seen);
    seen.set(element, result);
    return result;
  }
  function takesRoom(element) {
    const rect = element.getBoundingClientRect();
    return element.getClientRects().length > 0 && rect.width > 0 && rect.height > 0;
  }

  // The page's main region when it marks one, else the whole body.
  function mainOf(doc, seen) {
    const main = doc.querySelector('main, [role="main"]');
    return main && shown(main, seen) ? main : doc.body;
  }

  function read(doc) {
    const seen = new Map();
    const top = mainOf(doc, seen);
    if (!top) return '';
    const win = doc.defaultView;
    const walker = doc.createTreeWalker(top, win.NodeFilter.SHOW_ELEMENT | win.NodeFilter.SHOW_TEXT, {
      acceptNode: node => node.nodeType === 3 ? win.NodeFilter.FILTER_ACCEPT : leftOut(node, top) ? win.NodeFilter.FILTER_REJECT : win.NodeFilter.FILTER_SKIP
    });
    const blocks = [];
    let block = null, words = '';
    const flush = () => {
      const text = words.replace(/\s+/g, ' ').trim();
      if (text && !blocks.includes(text)) blocks.push(text);
      words = '';
    };
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!node.data.trim() || !shown(parent, seen) || !takesRoom(parent)) continue;
      const owner = parent.closest(BLOCK) || top;
      if (owner !== block) { flush(); block = owner; }
      words += node.data;
    }
    flush();
    return cap(blocks);
  }

  // Whole blocks while they fit, then as much of the next as ends at a sentence (or a word).
  function cap(blocks, limit = MAX_CHARS) {
    let text = '';
    for (const block of blocks) {
      const joined = text ? `${text}\n${block}` : block;
      if (joined.length <= limit) { text = joined; continue; }
      const part = cut(block, limit - (text ? text.length + 1 : 0));
      if (part) text = text ? `${text}\n${part}` : part;
      break;
    }
    return text;
  }
  function cut(block, room) {
    if (room <= 0) return '';
    const part = block.slice(0, room + 1);
    const sentence = Math.max(...['. ', '? ', '! ', '。', '？', '！'].map(end => part.lastIndexOf(end)));
    if (sentence > 0) return part.slice(0, sentence + 1).trim();
    const word = part.lastIndexOf(' ');
    return (word > 0 ? part.slice(0, word) : block.slice(0, room)).trim();
  }

  const api = Object.freeze({ MAX_CHARS, read, cap });
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SecondHandPageText = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
