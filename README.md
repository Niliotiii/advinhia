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

Pré-processamento (espelha a normalização do QuickDraw): encontra a
*bounding box* do traço no canvas, recorta, escala para preencher quase todo
o frame 28×28 (centralizado, preservando proporção), inverte (`255 - v`) e
normaliza para `[0, 1]`. Esse passo é crítico: reduzir o canvas inteiro direto
para 28×28 deixa o traço pequeno e descentralizado, fora da distribuição de
treino — e o modelo erra tudo.

## Arquitetura do código

```
src/
  recognizer.ts  — carrega o modelo TF.js e roda inferência (top-K)
  board.ts       — quadro de desenho (mouse + touch)
  game.ts        — máquina de estados: rodadas, timer, pontuação por velocidade
  prompts.ts     — subconjunto curado das 345 classes (rótulo EN p/ match + PT p/ exibir)
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
- **Dicas progressivas**: letras do nome são reveladas conforme o tempo passa.
- **Recorde local** persistido via `localStorage`.
- **Efeito de acerto** (confete) quando a IA crava o desenho.
- **PWA offline**: após o primeiro load, o jogo roda 100% sem rede
  (service worker cacheia app + modelo). Combina com a inferência local.

## Próximos passos possíveis

- Multiplayer via WebSocket (Durable Objects na Cloudflare).
- Níveis de dificuldade (curar as 345 classes por facilidade de desenho).
