# Ben's Games

## Realtime prototype

This workspace is at the first implementation gate. The throwaway counter uses one SQLite-backed Durable Object and the hibernating WebSocket API. Its only purpose is to prove room synchronization, seat persistence, and hibernation before the game engine is built.

Run the local proof with Node.js 24 and Google Chrome installed.

```powershell
npm.cmd ci
npm.cmd run verify:realtime
```

The script launches three Chrome tabs in separate browser contexts, updates the shared counter, reloads a tab, restarts Wrangler, and checks that all three original seats and the counter survive. It uses port 18787 by default. Set `PROOF_PORT` to override it or `PROOF_BROWSER` to select another installed Chromium channel, such as `msedge`.

Local and deployed staging verification passed with Wrangler 4.160.0 on November 10, 2026. Staging verified three distinct seats, synchronized updates, same-seat refresh, and a new Durable Object instance after 45 seconds idle while the original WebSockets remained connected. The live prototype is https://bens-games-realtime-proof.bens-games.workers.dev. The shared engine and games remain to be implemented.

## Staging gate

Use a disposable Worker in the target Cloudflare staging account. Authenticate with `wrangler login` or a scoped deployment token. For a new Worker, the first deploy supplies its generated URL. Deploy again with the exact origin so the browser upgrade can succeed.

```powershell
node ./node_modules/wrangler/bin/wrangler.js deploy --config prototype/wrangler.toml
$env:PROOF_URL = 'https://bens-games-realtime-proof.YOUR-SUBDOMAIN.workers.dev'
node ./node_modules/wrangler/bin/wrangler.js deploy --config prototype/wrangler.toml --var "ALLOWED_ORIGIN:$env:PROOF_URL"
npm.cmd run verify:realtime
Remove-Item Env:PROOF_URL
```

The staging test leaves the three browser sockets idle for 45 seconds. It then verifies that a counter update reaches all three original sockets and reports a new Durable Object instance ID. Run the test alone against the disposable Worker so unrelated connections do not interfere. Once the staging gate passes, retire this prototype and start the shared engine.


