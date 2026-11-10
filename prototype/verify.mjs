import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const staging = process.env.PROOF_URL;
const port = process.env.PROOF_PORT || "18787";
const base = staging ?? ("http://127.0.0.1:" + port);
let worker;
let browser;
let cleaningUp;

function cleanup() {
  cleaningUp ??= (async () => {
    try {
      await browser?.close();
    } finally {
      await stop();
    }
  })();
  return cleaningUp;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(130));
  });
}

const watchdog = setTimeout(() => {
  console.error("Prototype verification exceeded three minutes.");
  void cleanup().finally(() => process.exit(1));
}, 180_000);
watchdog.unref();

async function start() {
  worker = spawn(process.execPath, [
    "node_modules/wrangler/bin/wrangler.js", "dev", "--local",
    "--config", "prototype/wrangler.toml", "--port", port, "--ip", "127.0.0.1", "--var", "ALLOWED_ORIGIN:" + base,
    "--persist-to", ".wrangler/proof", "--show-interactive-dev-session=false",
  ], {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: resolve(".wrangler/config"),
      WRANGLER_SEND_METRICS: "false",
    },
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null) throw new Error("Wrangler exited before startup");
    try {
      if ((await fetch(base, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch (error) {
      if (attempt === 99) throw new Error("Wrangler health check failed", { cause: error });
      await sleep(250);
    }
  }
  throw new Error("Wrangler did not start");
}

async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const exited = once(worker, "exit");
  if (process.platform === "win32") {
    await once(spawn("taskkill.exe", ["/PID", String(worker.pid), "/T", "/F"]), "exit");
  } else {
    worker.kill();
  }
  await Promise.race([
    exited,
    sleep(5000, undefined, { ref: false }).then(() => { throw new Error("Wrangler did not stop"); }),
  ]);
}

const output = (page, id) => page.locator("#" + id).textContent();
const countIs = (page, count) =>
  page.waitForFunction(expected => document.querySelector("#count").textContent === expected, String(count));
const connected = page =>
  page.waitForFunction(() => document.querySelector("#status").textContent === "Connected");

try {
  if (!staging) await start();
  console.log("Server ready. Launching Chrome.");
  browser = await chromium.launch({ channel: process.env.PROOF_BROWSER || "chrome" });
  const pages = await Promise.all(Array.from({ length: 3 }, async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    page.on("pageerror", error => console.error("Browser error:", error.message));
    page.on("response", response => {
      if (response.status() >= 400) console.error("HTTP", response.status(), response.url());
    });
    await page.goto(base);
    await connected(page);
    return page;
  }));
  console.log("Three tabs connected.");
  const seats = await Promise.all(pages.map(page => output(page, "seat")));
  assert.equal(new Set(seats).size, 3);
  const initialCount = Number(await output(pages[0], "count"));
  await pages[0].locator("#add").click();
  await Promise.all(pages.map(page => countIs(page, initialCount + 1)));

  await pages[1].reload();
  await connected(pages[1]);
  assert.equal(await output(pages[1], "seat"), seats[1]);
  await countIs(pages[1], initialCount + 1);

  if (staging) {
    const before = await pages[0].locator("#count").getAttribute("data-instance");
    let replacementSockets = 0;
    for (const page of pages) page.on("websocket", () => replacementSockets++);
    await sleep(45_000);
    await pages[0].locator("#add").click();
    await Promise.all(pages.map(page => countIs(page, initialCount + 2)));
    assert.notEqual(await pages[0].locator("#count").getAttribute("data-instance"), before,
      "Expected the Durable Object to wake in a new instance with the original sockets attached");
    assert.equal(replacementSockets, 0, "The original sockets should remain open during hibernation");
  } else {
    console.log("Restarting Wrangler.");
    await stop();
    await start();
    for (const [index, page] of pages.entries()) {
      await page.reload();
      await connected(page);
      assert.equal(await output(page, "seat"), seats[index]);
      await countIs(page, initialCount + 1);
    }
    await pages[2].locator("#add").click();
    await Promise.all(pages.map(page => countIs(page, initialCount + 2)));
  }
  console.log("PASS: three browser tabs, state sync, same-seat refresh, and " +
    (staging ? "staging hibernation" : "local restart persistence"));
} finally {
  clearTimeout(watchdog);
  await cleanup();
}


