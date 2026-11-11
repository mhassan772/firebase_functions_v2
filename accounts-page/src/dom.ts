/// Small DOM builder so no user-controlled text ever goes through innerHTML.

type Attrs = Record<string, string | boolean | number | undefined | EventListener>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value === true) {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child);
  }
  return el;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/// A decorative inline icon, hidden from screen readers; the control next to it carries the name.
export function icon(viewBox: string, paths: readonly { d: string; fill?: string }[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("class", "glyph");
  for (const path of paths) {
    const element = document.createElementNS(SVG_NS, "path");
    element.setAttribute("d", path.d);
    element.setAttribute("fill", path.fill ?? "currentColor");
    svg.append(element);
  }
  return svg;
}

/// Wraps an address so its Latin characters keep their order inside Arabic text.
export function ltr(text: string): HTMLElement {
  return h("bdi", { dir: "ltr", class: "ltr" }, text);
}
