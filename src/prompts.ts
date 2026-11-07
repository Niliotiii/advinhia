/**
 * Curated subset of the 345 doodleNet classes chosen because they are
 * easy to draw and recognize. Each prompt maps the model's English label
 * (used for matching the AI's guess) to a Portuguese label (shown to the
 * player). The `label` MUST exactly match an entry in class_names.txt.
 */
export interface Prompt {
  label: string; // model class name (English) — used for matching
  pt: string; // display name (Portuguese)
}

export const PROMPTS: Prompt[] = [
  { label: "apple", pt: "maçã" },
  { label: "banana", pt: "banana" },
  { label: "car", pt: "carro" },
  { label: "cat", pt: "gato" },
  { label: "dog", pt: "cachorro" },
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
  { label: "cup", pt: "xícara" },
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
  { label: "snake", pt: "cobra" },
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
  { label: "pencil", pt: "lápis" },
  { label: "book", pt: "livro" },
  { label: "bread", pt: "pão" },
  { label: "donut", pt: "rosquinha" },
  { label: "ladder", pt: "escada" },
  { label: "sailboat", pt: "veleiro" },
];
