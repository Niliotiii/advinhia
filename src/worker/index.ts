import { GameRoom, type Env } from "./game-room";

export { GameRoom };

/** Room codes are short alphanumerics, e.g. /room/AB12. */
const ROOM_RE = /^\/room\/([A-Za-z0-9_-]{1,32})$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(ROOM_RE);

    if (match) {
      // WebSocket upgrade for a specific room → forward to its Durable Object.
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }
      const roomId = match[1].toLowerCase();
      const stub = env.GAME_ROOM.getByName(roomId);
      return stub.fetch(request);
    }

    // Everything else is a static asset (the SPA, the model, PWA files, …).
    return env.ASSETS.fetch(request);
  },
};
