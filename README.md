# Advinhia 🎨🤖

Jogo de desenho estilo Skribbl.io, **single-player**: o jogo mostra um conceito,
você desenha num quadro branco e uma **IA de visão computacional roda localmente
no seu navegador** tentando adivinhar em tempo real. Quanto mais rápido ela
acertar, mais pontos você faz.

## A decisão de engenharia

O ponto central do desafio é **latência e banda**. Enviar o canvas em Base64 para
uma API externa (GPT-4 Vision etc.) a cada frame seria inviável: latência de rede,
custo por requisição e rate limits.

A solução aqui é **inferência 100% local no navegador** via **TensorFlow.js**:

- Nenhuma imagem sai do dispositivo do usuário.
- Zero latência de rede por inferência (roda na CPU/GPU local via WebGL).
- Zero custo por requisição e nenhum rate limit.
- O único tráfego de rede é o download único do modelo (~2.1 MB, cacheado
  de forma imutável).

### O modelo

Usamos o **doodleNet** — uma CNN treinada nas **345 categorias** do dataset
[Google "Quick, Draw!"](https://quickdraw.withgoogle.com/data). Entrada
`28×28×1` em tons de cinza. Os arquivos do modelo
(`model.json`, `group1-shard1of1.bin`, `class_names.txt`) ficam em
`public/model/` e são servidos como estáticos — a app é totalmente
auto-contida, sem depender de hosts externos em runtime.

O que a IA recebe (`src/drawing.ts` e `src/recognizer.ts`), nessa ordem:

1. **Traços vetoriais, não pixels.** O quadro grava o desenho como pontos
   normalizados. Para a IA ele é redesenhado sempre em **preto**, com espessura
   **proporcional ao tamanho do desenho** (6% do lado maior). Por isso o pincel e a
   cor que o jogador vê são só visuais e não mudam o reconhecimento.
2. **Recorte e centralização**: *bounding box* do traço, escalada para ocupar 26 dos
   28 px, centralizada e preservando a proporção (espelha o QuickDraw).
3. **Redução por média exata por área** até 28×28, invertida (`255 - v`) e
   normalizada para `[0, 1]`. Um `drawImage` direto pulava traços finos.

Medido em 1200 desenhos humanos reais do Quick, Draw! (`tests/benchmark.cjs`), o
acerto top-1 entre as 345 classes foi de 38% (pixels do quadro, 14px, `drawImage`)
para 83%. Fazer o traço fino ou grosso demais, ou reduzir o desenho sem média por
área, é o que mais atrapalha a IA.

## Conceitos do jogo

Os conceitos sorteados (`src/shared/prompts.ts`) foram escolhidos pelo acerto **medido**
da IA com desenhos humanos reais do Quick, Draw!, não por palpite: ficaram de fora
os que o modelo reconhece mal (cachorro, lápis e cobra, de 33% a 46% de acerto) e entraram
outros com 86% a 98%. Alguns conceitos têm **sinônimos** (`also`): o modelo tem as classes
`cup`, `mug` e `coffee_cup`, e quem desenha uma xícara não tem como saber qual delas a IA
prefere, então as três valem e suas probabilidades são somadas.

## Arquitetura do código

```
src/
  recognizer.ts  — carrega o modelo TF.js e roda inferência (top-K)
  board.ts       — quadro de desenho (mouse + touch)
  game.ts        — máquina de estados: rodadas, timer, pontuação por velocidade
  shared/prompts.ts — conceitos do jogo, curados pelo acerto medido da IA (rótulo EN p/ match + PT p/ exibir, + sinônimos)
  main.ts        — fiação da UI + loop de inferência (debounce ~250ms)
  style.css      — estilos
public/
  model/         — arquivos do modelo (estáticos)
  _headers       — cache imutável para /model/*
```

O loop de inferência roda a cada **250ms** (não por frame): é tempo real para
um humano desenhando, e evita trabalho desnecessário.

## Rodando localmente

```bash
npm install
npm run dev      # servidor de desenvolvimento (Vite)
```

## Build

```bash
npm run build    # typecheck (tsc) + bundle de produção em dist/
npm run preview  # serve o build localmente
```

## Deploy na Cloudflare

Site estático servido via **Cloudflare Workers static assets**
(configurado em `wrangler.jsonc`).

```bash
npx wrangler login   # uma vez
npm run deploy       # build + wrangler deploy
```

> `wrangler deploy --dry-run` valida a configuração sem publicar.

## Recursos

- **Inferência local** (TensorFlow.js) com os backends modulares
  `@tensorflow/tfjs-core` + `@tensorflow/tfjs-layers` + `tfjs-backend-webgl`
  (WebGL com fallback para CPU).
- **Suavização temporal**: média móvel das últimas inferências, deixando os
  palpites estáveis em vez de "tremer" frame a frame.
- **Visão da IA**: mini-canvas 28×28 mostrando exatamente a entrada que o
  modelo recebe.
- **Ferramentas de desenho**: 8 cores, 5 espessuras e *desfazer* (botão ou
  Ctrl/Cmd+Z). São só visuais: a IA sempre recebe o desenho redesenhado em preto
  com a espessura ideal. No multiplayer a galeria final mostra cada desenho com as
  cores que o jogador escolheu.
- **Dicas progressivas**: letras do nome são reveladas conforme o tempo passa.
- **Recorde local** persistido via `localStorage`.
- **Efeito de acerto** (confete) quando a IA crava o desenho.
- **PWA offline**: após o primeiro load, o jogo roda 100% sem rede
  (service worker cacheia app + modelo). Combina com a inferência local.

## Multiplayer

Todos na sala desenham os **mesmos conceitos**, com o **mesmo tempo** por desenho.
Os desenhos são privados enquanto são feitos. No fim, a IA (que continua rodando
no navegador de cada jogador) dá a cada desenho a porcentagem de certeza de que
ele é o conceito pedido. Vence quem somar mais.

- **Servidor**: um Durable Object por sala (`src/worker/game-room.ts`) é dono da
  partida: jogadores, conceitos sorteados, cronômetro sincronizado (via `alarm`),
  desenhos recebidos (SQLite) e ranking. O estado é salvo antes de ser anunciado,
  então sobrevive à hibernação e a reinícios.
- **Verificação cruzada das notas**: o servidor manda todos os desenhos a todos os
  jogadores; cada navegador avalia **todos** com a IA local e a nota final de um
  desenho é a **mediana** das avaliações (`src/shared/scoring.ts`). Um cliente
  adulterado não consegue inflar a própria nota nem derrubar a de outro com 3 ou
  mais jogadores. Com 2 jogadores não há desempate (vale a média), e diferenças
  acima de 10 pontos aparecem marcadas com `*` no resultado.
- **Reconexão**: cada jogador tem um token por aba; quem cai volta com a mesma
  identidade e o mesmo cronômetro, e o cliente reconecta sozinho.
- **Justiça**: a IA recebe todos os desenhos com a mesma espessura ideal, qualquer
  que seja o pincel, e uma rodada sem desenho vale 0% mesmo que alguém envie outra
  nota.

### Testes

Os testes ficam em `tests/` e precisam do servidor local (`npx wrangler dev --port 8787`
depois de `npm run build`) e, os de navegador, de um Chrome com
`--remote-debugging-port`. Cada arquivo tem as instruções no cabeçalho:

- `tests/aggregate.mjs`: regra da mediana (sem servidor: `node --experimental-strip-types tests/aggregate.mjs`).
- `tests/game-flow.cjs`: fluxo do servidor com 3 jogadores, um deles trapaceiro.
- `tests/mp-ui.cjs`: partida completa com 2 abas reais e a IA de verdade.
- `tests/mobile.cjs`: celular emulado (390px), desenho com toque e layout.
- `tests/scoring.cjs`: o pincel não muda a nota da IA e o arredondamento dos pontos é inofensivo.
- `tests/benchmark.cjs`: acerto da IA em desenhos humanos reais do Quick, Draw! (precisa de internet).
- `tests/concepts.mjs`: integridade da lista de conceitos e dos sinônimos (sem servidor: `node --experimental-strip-types tests/concepts.mjs`).
- `tests/load-8.cjs`: sala cheia (8 jogadores) com desenhos no limite de tamanho.

## Próximos passos possíveis

- Botão "terminei" para encerrar um desenho antes do tempo quando todos acabarem.
- Níveis de dificuldade (curar as 345 classes por facilidade de desenho).

## Créditos e licenças

- **Modelo de reconhecimento: [doodleNet](https://github.com/yining1023/doodleNet)**, de
  [@yining1023](https://github.com/yining1023): CNN para as 345 categorias do Quick, Draw!,
  usada aqui sem alterações (arquivos em `public/model/`, vindos de
  `demo/DoodleClassifier_345/model`). Segundo o próprio README do doodleNet, o treino
  se baseia no notebook *Sketcher* de [@zaidalyafeai](https://github.com/zaidalyafeai).
  > O repositório do doodleNet **não declara uma licença**. Os pesos estão neste projeto
  > sem uma permissão explícita de reuso; antes de divulgar amplamente ou usar de forma
  > comercial, confirme com o autor.
- **Dataset: [Quick, Draw!](https://github.com/googlecreativelab/quickdraw-dataset)**,
  disponibilizado pela Google, Inc. sob a licença
  [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
  É com ele que o doodleNet foi treinado.
- **[TensorFlow.js](https://www.tensorflow.org/js)** executa a inferência no navegador.
- **Cloudflare Workers e Durable Objects** hospedam o site e as salas multiplayer.
- **Fontes** Fraunces e Inter, carregadas do Google Fonts.
