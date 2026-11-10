/**
 * Curated subset of the 345 doodleNet classes chosen because they are
 * easy to draw and recognize. Each prompt maps the model's English label
 * (used for matching the AI's guess) to a Portuguese label (shown to the
 * player). The `label` MUST exactly match an entry in class_names.txt.
 */
export interface Prompt {
  label: string; // model class name (English) — used for matching
  pt: string; // display name (Portuguese)
  /**
   * Other model classes that are the same thing to a player (e.g. the model has
   * separate "cup", "mug" and "coffee_cup" classes). They count as a correct
   * answer, and their probabilities are added to the concept's score.
   */
  also?: string[];
}

export const PROMPTS: Prompt[] = [
  { label: "apple", pt: "maçã" },
  { label: "banana", pt: "banana" },
  { label: "car", pt: "carro" },
  { label: "cat", pt: "gato" },
  { label: "fish", pt: "peixe" },
  { label: "house", pt: "casa" },
  { label: "tree", pt: "árvore" },
  { label: "star", pt: "estrela" },
  { label: "sun", pt: "sol" },
  { label: "moon", pt: "lua" },
  { label: "flower", pt: "flor" },
  { label: "clock", pt: "relógio" },
  { label: "key", pt: "chave" },
  { label: "umbrella", pt: "guarda-chuva" },
  { label: "bicycle", pt: "bicicleta" },
  { label: "airplane", pt: "avião" },
  { label: "boomerang", pt: "bumerangue" },
  { label: "candle", pt: "vela" },
  { label: "cloud", pt: "nuvem" },
  { label: "crown", pt: "coroa" },
  { label: "cup", pt: "xícara", also: ["mug", "coffee_cup"] },
  { label: "door", pt: "porta" },
  { label: "eye", pt: "olho" },
  { label: "hammer", pt: "martelo" },
  { label: "hat", pt: "chapéu" },
  { label: "ladder", pt: "escada" },
  { label: "leaf", pt: "folha" },
  { label: "lightning", pt: "raio" },
  { label: "mushroom", pt: "cogumelo" },
  { label: "pizza", pt: "pizza" },
  { label: "rainbow", pt: "arco-íris" },
  { label: "scissors", pt: "tesoura" },
  { label: "snowman", pt: "boneco de neve" },
  { label: "spider", pt: "aranha" },
  { label: "sword", pt: "espada" },
  { label: "t-shirt", pt: "camiseta" },
  { label: "wheel", pt: "roda" },
  { label: "fork", pt: "garfo" },
  { label: "ice_cream", pt: "sorvete" },
  { label: "envelope", pt: "envelope" },
  { label: "light_bulb", pt: "lâmpada" },
  { label: "mountain", pt: "montanha" },
  { label: "book", pt: "livro" },
  { label: "bread", pt: "pão" },
  { label: "donut", pt: "rosquinha" },
  { label: "sailboat", pt: "veleiro" },
  // Added after measuring 294 candidate classes on real Quick, Draw! drawings
  // (80 drawings each, top-1 accuracy 86%..98%).
  { label: "headphones", pt: "fones de ouvido" },
  { label: "eyeglasses", pt: "óculos" },
  { label: "teddy-bear", pt: "ursinho de pelúcia" },
  { label: "The_Eiffel_Tower", pt: "Torre Eiffel" },
  { label: "chair", pt: "cadeira" },
  { label: "camel", pt: "camelo" },
  { label: "butterfly", pt: "borboleta" },
  { label: "cactus", pt: "cacto" },
  { label: "hot_air_balloon", pt: "balão de ar quente" },
  { label: "popsicle", pt: "picolé" },
  { label: "helicopter", pt: "helicóptero" },
];

/** Every model class that counts as a correct answer for `label` (itself first). */
export function acceptedLabels(label: string): string[] {
  const p = PROMPTS.find((x) => x.label === label);
  return [label, ...(p?.also ?? [])];
}
