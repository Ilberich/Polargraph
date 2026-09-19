/** Small helpers for building DOM without a framework. */

/**
 * Create an element.
 *
 * Properties are assigned rather than set as attributes, so `value`, `checked`
 * and event handlers work the way they do on the element itself. `class`,
 * `dataset` and `style` are special-cased because they are what the shorthand
 * is actually for.
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;

    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else node[key] = value;
  }

  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  return node;
}

/** Elements that hold a caret and a soft keyboard. */
const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * Is this node one the user can type into?
 *
 * Used to avoid replacing an element mid-edit. Takes any object with a
 * `tagName`, so the rule can be tested without a DOM.
 */
export function isEditable(node) {
  if (!node) return false;
  return EDITABLE_TAGS.has(node.tagName) || node.isContentEditable === true;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

/** A labelled numeric field. `onCommit` fires on change, not on every keystroke. */
export function numberField({ label, value, min, max, step = 1, unit, onCommit }) {
  const input = el('input', {
    class: 'field__input',
    type: 'number',
    value: String(value),
    step: String(step),
    ...(min == null ? {} : { min: String(min) }),
    ...(max == null ? {} : { max: String(max) }),
    onchange: () => {
      const next = Number(input.value);
      if (Number.isFinite(next)) onCommit(next);
    },
  });

  return el('label', { class: 'field' }, [
    el('span', { class: 'field__label' }, label),
    el('span', { class: 'field__control' }, [
      input,
      unit && el('span', { class: 'field__unit' }, unit),
    ]),
  ]);
}

export function checkboxField({ label, checked, onChange }) {
  const input = el('input', {
    class: 'checkbox__input',
    type: 'checkbox',
    checked,
    onchange: () => onChange(input.checked),
  });

  return el('label', { class: 'checkbox' }, [input, el('span', {}, label)]);
}

export function button({ label, onClick, variant = '', title }) {
  return el('button', {
    class: `button ${variant}`.trim(),
    type: 'button',
    title: title ?? label,
    onclick: onClick,
  }, label);
}

export function card(title, children, actions = null) {
  // The slug makes cards addressable from tests and from the browser console
  // without depending on their order in the panel.
  return el('section', {
    class: 'card',
    dataset: { card: title.toLowerCase().replace(/\s+/g, '-') },
  }, [
    el('header', { class: 'card__header' }, [
      el('h3', { class: 'card__title' }, title),
      actions,
    ]),
    ...[].concat(children),
  ]);
}

/** Offer a generated file for download. */
export function downloadText(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = el('a', { href: url, download: filename });

  document.body.append(link);
  link.click();
  link.remove();

  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Read a chosen file as text, one file at a time. */
export function pickFiles({ accept, multiple = true }) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, multiple, style: { display: 'none' } });

    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      const read = await Promise.all(
        files.map(async (file) => ({ name: file.name, text: await file.text() }))
      );

      input.remove();
      resolve(read);
    };

    document.body.append(input);
    input.click();
  });
}
