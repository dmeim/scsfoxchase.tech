export interface Minigame {
  id: string;
  name: string;
  description: string;
  glyph: string;
  image?: string;
}

export const minigames: Minigame[] = [
  {
    id: "dino-run",
    name: "Dino Run",
    description: "Jump, slam, and beat your best.",
    glyph: "DR",
  },
];
