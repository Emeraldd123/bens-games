import { DurableObject } from "cloudflare:workers";

interface Env {
  PROOF_ROOM: DurableObjectNamespace<ProofRoom>;
  ALLOWED_ORIGIN: string;
}

const page = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Realtime proof</title>
<h1>Realtime proof</h1><p id="status" role="status">Connecting</p>
<p>Seat <output id="seat"></output> · Count <output id="count"></output></p>
<button id="add" disabled>Add one</button><script>
const status = document.querySelector("#status");
const add = document.querySelector("#add");
const key = "bens-games-proof-credential";
let credential = localStorage.getItem(key);
if (!credential) {
  credential = crypto.randomUUID();
  localStorage.setItem(key, credential);
}
let socket;
let retry = 250;
function connect() {
  socket = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/socket");
  socket.onopen = () => socket.send(JSON.stringify({type:"join", credential}));
  socket.onmessage = ({data}) => {
    const message = JSON.parse(data);
    if (message.type === "joined") {
      document.querySelector("#seat").textContent = message.seat;
      status.textContent = "Connected";
      add.disabled = false;
      retry = 250;
    }
    if (message.type === "state") {
      const count = document.querySelector("#count");
      count.textContent = message.count;
      count.dataset.instance = message.instance;
    }
  };
  socket.onclose = ({code}) => {
    add.disabled = true;
    status.textContent = code === 4001 ? "Seat open in another tab" : "Reconnecting";
    if (code !== 4001) {
      setTimeout(connect, retry);
      retry = Math.min(retry * 2, 4000);
    }
  };
}
add.onclick = () => {
  if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"increment"}');
};
connect();
</script></html>`;

export default {
  fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") {
      return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (pathname !== "/socket") return new Response("Not found", { status: 404 });
    if (request.headers.get("Origin") !== env.ALLOWED_ORIGIN) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }
    return env.PROOF_ROOM.getByName("prototype").fetch(request);
  },
} satisfies ExportedHandler<Env>;

export class ProofRoom extends DurableObject<Env> {
  private readonly instance = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS seats (credential TEXT PRIMARY KEY, seat TEXT NOT NULL)");
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counter (id INTEGER PRIMARY KEY, count INTEGER NOT NULL)");
    ctx.storage.sql.exec("INSERT OR IGNORE INTO counter VALUES (1, 0)");
  }

  fetch(): Response {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): void {
    if (typeof raw !== "string" || raw.length > 256) {
      socket.close(1008, "Invalid frame");
      return;
    }

    let message: { type?: unknown; credential?: unknown } | null;
    try {
      message = JSON.parse(raw);
    } catch {
      socket.close(1008, "Invalid JSON");
      return;
    }

    const sql = this.ctx.storage.sql;
    const seat = socket.deserializeAttachment() as string | null;
    if (!seat && message?.type === "join" && typeof message.credential === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.credential)) {
      sql.exec("INSERT OR IGNORE INTO seats VALUES (?, ?)", message.credential, crypto.randomUUID());
      const joinedSeat = sql.exec<{ seat: string }>("SELECT seat FROM seats WHERE credential = ?", message.credential).one().seat;
      for (const peer of this.ctx.getWebSockets()) {
        if (peer.deserializeAttachment() === joinedSeat) peer.close(4001, "Seat replaced");
      }
      socket.serializeAttachment(joinedSeat);
      socket.send(JSON.stringify({ type: "joined", seat: joinedSeat }));
      socket.send(this.state());
      return;
    }
    if (!seat || message?.type !== "increment") {
      socket.close(1008, "Invalid action");
      return;
    }

    sql.exec("UPDATE counter SET count = count + 1 WHERE id = 1");
    const state = this.state();
    for (const peer of this.ctx.getWebSockets()) {
      if (peer.readyState === WebSocket.OPEN && peer.deserializeAttachment()) peer.send(state);
    }
  }

  private state(): string {
    const { count } = this.ctx.storage.sql.exec<{ count: number }>("SELECT count FROM counter WHERE id = 1").one();
    return JSON.stringify({ type: "state", count, instance: this.instance });
  }
}

