import type { DrawingBoard } from "./board";
import { BRUSH_WIDTHS, DEFAULT_COLOR, DEFAULT_WIDTH, PALETTE } from "./shared/style";

export interface Tools {
  setColor(index: number): void;
  setWidth(index: number): void;
  /** Enable/disable every control; `undoAllowed` lets undo be off while the rest is on. */
  setEnabled(on: boolean, undoAllowed?: boolean): void;
}

const UNDO_ICON =
  '<svg class="icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 7 4 12l5 5M5 12h9a5 5 0 0 1 0 10h-2" transform="translate(0 -3)" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Colour palette, brush width and undo for a DrawingBoard. All purely cosmetic:
 * the AI gets the strokes re-rendered in black with an ideal width.
 */
export function mountTools(
  host: HTMLElement,
  board: DrawingBoard,
  opts: { onUndo?: () => void } = {},
): Tools {
  host.classList.add("tools");
  host.replaceChildren();

  let enabled = true;
  let undoAllowed = true;

  // A radio group built from buttons (arrow keys move the selection).
  function radioGroup(
    label: string,
    count: number,
    build: (btn: HTMLButtonElement, i: number) => void,
    onPick: (i: number) => void,
  ) {
    const group = document.createElement("div");
    group.className = "tools__group";
    group.setAttribute("role", "radiogroup");
    group.setAttribute("aria-label", label);
    const buttons: HTMLButtonElement[] = [];
    for (let i = 0; i < count; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      build(b, i);
      b.addEventListener("click", () => onPick(i));
      b.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        const next = (i + (e.key === "ArrowRight" ? 1 : count - 1)) % count;
        onPick(next);
        buttons[next].focus();
      });
      buttons.push(b);
      group.append(b);
    }
    host.append(group);
    const mark = (selected: number): void =>
      buttons.forEach((b, i) => {
        b.setAttribute("aria-checked", String(i === selected));
        b.tabIndex = i === selected ? 0 : -1; // roving tabindex
      });
    return { buttons, mark };
  }

  const colors = radioGroup(
    "Cor do traço",
    PALETTE.length,
    (b, i) => {
      b.className = "swatch";
      b.style.setProperty("--c", PALETTE[i].hex);
      b.title = PALETTE[i].name;
      b.setAttribute("aria-label", PALETTE[i].name);
    },
    (i) => tools.setColor(i),
  );

  const sizes = radioGroup(
    "Espessura do traço",
    BRUSH_WIDTHS.length,
    (b, i) => {
      b.className = "size";
      const dot = document.createElement("span");
      dot.className = "size__dot";
      const d = Math.round(4 + (BRUSH_WIDTHS[i] / BRUSH_WIDTHS[BRUSH_WIDTHS.length - 1]) * 16);
      dot.style.width = dot.style.height = `${d}px`;
      b.append(dot);
      b.title = `Espessura ${i + 1} de ${BRUSH_WIDTHS.length}`;
      b.setAttribute("aria-label", b.title);
    },
    (i) => tools.setWidth(i),
  );

  const undoBtn = document.createElement("button");
  undoBtn.type = "button";
  undoBtn.className = "btn btn--ghost btn--sm tools__undo";
  undoBtn.innerHTML = `${UNDO_ICON}Desfazer`;
  undoBtn.title = "Desfazer o último traço (Ctrl/Cmd+Z)";
  host.append(undoBtn);

  function undo(): void {
    if (!enabled || !undoAllowed) return;
    if (board.undo()) opts.onUndo?.();
  }
  undoBtn.addEventListener("click", undo);
  document.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return; // let text fields undo themselves
    e.preventDefault();
    undo();
  });

  const tools: Tools = {
    setColor(i) {
      board.setStyle({ color: i });
      colors.mark(board.getStyle().color);
    },
    setWidth(i) {
      board.setStyle({ width: i });
      sizes.mark(board.getStyle().width);
    },
    setEnabled(on, allowUndo = true) {
      enabled = on;
      undoAllowed = allowUndo;
      for (const b of [...colors.buttons, ...sizes.buttons]) b.disabled = !on;
      undoBtn.disabled = !(on && allowUndo);
    },
  };

  tools.setColor(DEFAULT_COLOR);
  tools.setWidth(DEFAULT_WIDTH);
  return tools;
}
