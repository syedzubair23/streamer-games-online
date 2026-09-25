/**
 * The authoring CLI's preview palette (a warm "cozy table" dev look). Only used by the track
 * tools under `test/`; the Stage and controllers pass palettes built from `@sg/ui` tokens.
 */
import type { PreviewPalette } from "../src/preview/track-preview.ts";

export const DEV_PALETTE: PreviewPalette = {
  background: "#cfe3ee",
  board: "#d9b98c",
  holes: "#b8956a",
  pieces: {
    pencil: ["#f2c230", "#e8804a", "#6fae5c", "#5b8fd6", "#c86cc2"],
    ruler: ["#e9dcc0", "#c9d7c3"],
    book: ["#b5473a", "#3f6fa8", "#4f8a52", "#c79a3b", "#7a4f8c"],
    cup: ["#f4f1ea", "#e7c9c3", "#c9dbe7"],
    deflector: ["#8a6b4a"],
    frame: ["#7a5638"],
    dowel: ["#8a6440"],
  },
  gate: "#2f6f8f",
  trapdoor: "#9b6a3c",
  finish: "#222222",
  boost: "#7b4fd6",
  centerline: "#ffffff",
  tray: "#ffffff",
  train: "#5a5a5a",
  decor: "#f7e7a1",
  marbles: ["#e4574c", "#f0a53a", "#f3d33c", "#5cb85c", "#3fa7d6", "#5a6fd6", "#a45ad6", "#e46aa8"],
  alert: "#d11a2a",
  text: "#2b2118",
};
