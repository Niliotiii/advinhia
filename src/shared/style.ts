/**
 * Visual style of strokes: colours and widths the player can pick.
 *
 * It is purely cosmetic. The AI never sees these (it is always shown the drawing
 * re-rendered in black with a size-proportional width, see drawing.ts), so no
 * choice here can help or hurt recognition. Strokes carry INDICES into these
 * lists, which keeps drawings small and lets the server validate them.
 */

export const PALETTE = [
  { name: "Preto", hex: "#111111" },
  { name: "Vermelho", hex: "#d64545" },
  { name: "Laranja", hex: "#e8613c" },
  { name: "Amarelo", hex: "#f4b840" },
  { name: "Verde", hex: "#2f8f6b" },
  { name: "Azul", hex: "#2b6cb0" },
  { name: "Roxo", hex: "#7c4dff" },
  { name: "Marrom", hex: "#8a5a2b" },
] as const;

/** Brush widths in px on the 420px board. */
export const BRUSH_WIDTHS = [6, 10, 14, 20, 28] as const;

export const DEFAULT_COLOR = 0;
export const DEFAULT_WIDTH = 2;
