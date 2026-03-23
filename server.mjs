import crypto from "node:crypto";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { URL } from "node:url";
import ngrok from "@ngrok/ngrok";
import QRCode from "qrcode";

const execFileAsync = promisify(execFile);

const adminToken = crypto.randomBytes(24).toString("hex");
const createdAt = new Date().toISOString();
const defaultWorkingDirectory = process.argv[2] || process.cwd();
const detachedSessionPrefix =
  process.env.REMOTE_TMUX_SESSION_PREFIX || "qr-remote";
const literalEnterDelayMs = Math.max(
  0,
  Number.parseInt(process.env.REMOTE_TERMINAL_SEND_ENTER_DELAY_MS || "180", 10) || 180,
);
const legacySessionTarget = process.env.REMOTE_TMUX_SESSION || "";
const explicitTargetList = [
  ...splitCsvTargets(process.env.REMOTE_TMUX_TARGETS || ""),
  ...splitCsvTargets(process.env.REMOTE_TMUX_TARGET || ""),
  ...splitCsvTargets(legacySessionTarget),
];

const state = {
  createdAt,
  adminToken,
  serverPort: null,
  publicUrl: null,
  tunnelPid: null,
  ngrokListener: null,
  server: null,
  error: null,
  revoked: false,
  shuttingDown: false,
  defaultWorkingDirectory,
  invocationPaneId: process.env.TMUX_PANE || null,
  remotes: new Map(),
  remoteOrder: [],
  remoteCounter: 1,
  detachedCounter: 1,
  noOpenDashboard: process.env.REMOTE_TERMINAL_NO_OPEN === "1",
};

await main();

async function main() {
  await bootstrapInitialRemotes();

  const server = http.createServer(handleRequest);
  state.server = server;
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine local server address");
  }

  state.serverPort = address.port;
  if (!state.noOpenDashboard) {
    openHostDashboard().catch(() => {});
  }

  try {
    await startNgrokTunnel(address.port);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }

  printStartupSummary();

  process.on("SIGINT", async () => {
    await shutdown();
  });

  process.on("SIGTERM", async () => {
    await shutdown();
  });
}

async function bootstrapInitialRemotes() {
  if (explicitTargetList.length > 0) {
    for (const target of explicitTargetList) {
      await addRemoteFromTargetSpec(target);
    }
    return;
  }

  await addDetachedRemote({
    workingDirectory: defaultWorkingDirectory,
    label: nextRemoteLabel(),
  });
}

function splitCsvTargets(raw) {
  return String(raw || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function createId(prefix) {
  return `${prefix}-${crypto.randomBytes(4).toString("hex")}`;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function nextRemoteLabel() {
  const label = `Remote ${state.remoteCounter}`;
  state.remoteCounter += 1;
  return label;
}

function nextDetachedSessionName() {
  const suffix = crypto.randomBytes(2).toString("hex");
  const name = `${detachedSessionPrefix}-${String(state.detachedCounter).padStart(2, "0")}-${suffix}`;
  state.detachedCounter += 1;
  return name;
}

async function execTmux(args) {
  return execFileAsync("tmux", args, {
    cwd: state.defaultWorkingDirectory,
    maxBuffer: 12 * 1024 * 1024,
  });
}

async function ensureDetachedSession(sessionName, workingDirectory) {
  try {
    await execTmux(["has-session", "-t", sessionName]);
  } catch {
    await execTmux([
      "new-session",
      "-Ad",
      "-s",
      sessionName,
      "-c",
      workingDirectory,
    ]);
  }
}

async function listTmuxTargets() {
  const format = [
    "#{pane_id}",
    "#{session_name}",
    "#{window_index}",
    "#{window_name}",
    "#{pane_index}",
    "#{pane_current_path}",
    "#{pane_title}",
    "#{pane_active}",
    "#{window_active}",
  ].join("\t");

  const { stdout } = await execTmux(["list-panes", "-a", "-F", format]);

  return stdout
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [
        paneId,
        sessionName,
        windowIndex,
        windowName,
        paneIndex,
        currentPath,
        paneTitle,
        paneActive,
        windowActive,
      ] = line.split("\t");

      return {
        paneId,
        sessionName,
        windowIndex,
        windowName,
        paneIndex,
        currentPath: currentPath || state.defaultWorkingDirectory,
        paneTitle,
        paneActive: paneActive === "1",
        windowActive: windowActive === "1",
        targetRef: `${sessionName}:${windowIndex}.${paneIndex}`,
      };
    })
    .sort((left, right) => {
      const leftKey = `${left.sessionName}:${left.windowIndex}.${left.paneIndex}`;
      const rightKey = `${right.sessionName}:${right.windowIndex}.${right.paneIndex}`;
      return leftKey.localeCompare(rightKey);
    });
}

async function resolveTmuxTarget(targetSpec) {
  const normalized = String(targetSpec || "").trim();
  if (!normalized) {
    throw new Error("Missing tmux target");
  }

  const panes = await listTmuxTargets();

  if (normalized.startsWith("%")) {
    const pane = panes.find((entry) => entry.paneId === normalized);
    if (pane) {
      return pane;
    }
  }

  const exactPane = panes.find((entry) => entry.targetRef === normalized);
  if (exactPane) {
    return exactPane;
  }

  if (/^[^:]+:\d+$/.test(normalized)) {
    const [sessionName, windowIndex] = normalized.split(":");
    const matches = panes.filter(
      (entry) =>
        entry.sessionName === sessionName && entry.windowIndex === windowIndex,
    );
    const pane =
      matches.find((entry) => entry.paneActive) ||
      matches.find((entry) => entry.windowActive) ||
      matches[0];
    if (pane) {
      return pane;
    }
  }

  const sessionMatches = panes.filter((entry) => entry.sessionName === normalized);
  if (sessionMatches.length > 0) {
    return (
      sessionMatches.find((entry) => entry.windowActive && entry.paneActive) ||
      sessionMatches.find((entry) => entry.paneActive) ||
      sessionMatches[0]
    );
  }

  throw new Error(
    `No encontre el target de tmux "${normalized}". Usa un pane id (%12), session:window.pane o session.`,
  );
}

function getActiveRemotes() {
  return state.remoteOrder
    .map((remoteId) => state.remotes.get(remoteId))
    .filter(Boolean);
}

function getRemoteById(remoteId) {
  if (!remoteId) {
    return null;
  }
  return state.remotes.get(String(remoteId)) || null;
}

function buildRemoteLabel(target, preferredLabel) {
  if (preferredLabel) {
    return preferredLabel;
  }

  const base = target.windowName
    ? `${target.sessionName} · ${target.windowName}`
    : `${target.sessionName} · ${target.windowIndex}.${target.paneIndex}`;

  return base;
}

async function addRemoteFromTargetSpec(targetSpec, options = {}) {
  const target = await resolveTmuxTarget(targetSpec);
  const existing = getActiveRemotes().find(
    (remote) => !remote.revoked && remote.paneId === target.paneId,
  );

  if (existing) {
    return existing;
  }

  const remote = {
    id: createId("remote"),
    remoteToken: crypto.randomBytes(24).toString("hex"),
    label: buildRemoteLabel(target, options.label),
    source: options.source || "attached",
    sessionName: target.sessionName,
    paneId: target.paneId,
    targetRef: target.targetRef,
    windowName: target.windowName,
    workingDirectory: target.currentPath || state.defaultWorkingDirectory,
    lastSeenAt: null,
    revoked: false,
    createdAt: new Date().toISOString(),
  };

  state.remotes.set(remote.id, remote);
  state.remoteOrder.push(remote.id);
  return remote;
}

async function addDetachedRemote(options = {}) {
  const workingDirectory =
    String(options.workingDirectory || "").trim() || state.defaultWorkingDirectory;
  const sessionName = nextDetachedSessionName();
  await ensureDetachedSession(sessionName, workingDirectory);

  return addRemoteFromTargetSpec(sessionName, {
    label: options.label || nextRemoteLabel(),
    source: "detached",
  });
}

async function capturePane(remote) {
  const { stdout } = await execTmux([
    "capture-pane",
    "-p",
    "-J",
    "-S",
    "-200",
    "-t",
    remote.paneId,
  ]);

  return stdout;
}

async function sendLiteral(remote, text) {
  if (!text) {
    return;
  }

  await execTmux([
    "send-keys",
    "-t",
    remote.paneId,
    "-l",
    text,
  ]);
}

async function sendKey(remote, keyName) {
  await execTmux([
    "send-keys",
    "-t",
    remote.paneId,
    keyName,
  ]);
}

async function endRemoteFromMobile(remote) {
  remote.revoked = true;

  if (remote.source !== "detached") {
    return;
  }

  try {
    await execTmux(["kill-session", "-t", remote.sessionName]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/can't find session|failed to connect to server/i.test(message)) {
      throw error;
    }
  }
}

function buildRemoteUrl(remote) {
  if (!state.publicUrl || remote.revoked || state.revoked) {
    return null;
  }

  return `${state.publicUrl}/remote?id=${encodeURIComponent(remote.id)}&token=${encodeURIComponent(remote.remoteToken)}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function buildContinueCommand(sessionName) {
  const target = shellQuote(sessionName);
  return `tmux switch-client -t ${target} 2>/dev/null || tmux attach -t ${target}`;
}

function serializeRemote(remote) {
  return {
    id: remote.id,
    label: remote.label,
    source: remote.source,
    sessionName: remote.sessionName,
    targetRef: remote.targetRef,
    paneId: remote.paneId,
    windowName: remote.windowName,
    workingDirectory: remote.workingDirectory,
    lastSeenAt: remote.lastSeenAt,
    revoked: remote.revoked,
    createdAt: remote.createdAt,
    remoteUrl: buildRemoteUrl(remote),
    continueCommand: buildContinueCommand(remote.sessionName),
  };
}

async function serializeRemoteForHost(remote) {
  const payload = serializeRemote(remote);

  if (!payload.remoteUrl) {
    return payload;
  }

  if (!remote.qrDataUrl || remote.qrSourceUrl !== payload.remoteUrl) {
    remote.qrDataUrl = await QRCode.toDataURL(payload.remoteUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: 220,
    });
    remote.qrSourceUrl = payload.remoteUrl;
  }

  return {
    ...payload,
    qrDataUrl: remote.qrDataUrl,
  };
}

function serializeTargets(targets) {
  return targets.map((target) => ({
    paneId: target.paneId,
    sessionName: target.sessionName,
    targetRef: target.targetRef,
    windowName: target.windowName,
    paneIndex: target.paneIndex,
    windowIndex: target.windowIndex,
    currentPath: target.currentPath,
    paneTitle: target.paneTitle,
    paneActive: target.paneActive,
    windowActive: target.windowActive,
    label: `${target.targetRef} · ${target.windowName || "window"} · ${target.currentPath}`,
  }));
}

function getAuthorizedRemote(url) {
  if (state.revoked) {
    return null;
  }

  const remote = getRemoteById(url.searchParams.get("id"));
  if (!remote || remote.revoked) {
    return null;
  }

  return url.searchParams.get("token") === remote.remoteToken ? remote : null;
}

async function startNgrokTunnel(port) {
  const authtoken =
    process.env.NGROK_AUTHTOKEN || process.env.REMOTE_TERMINAL_NGROK_AUTHTOKEN;

  if (!authtoken) {
    throw new Error(
      "Missing ngrok authtoken. Run `remote-terminal auth <token>` or set NGROK_AUTHTOKEN.",
    );
  }

  const listener = await ngrok.forward({
    addr: port,
    authtoken,
  });

  const publicUrl = listener.url();
  if (!publicUrl || !publicUrl.startsWith("https://")) {
    await listener.close();
    throw new Error("ngrok did not return a usable public URL");
  }

  state.ngrokListener = listener;
  state.tunnelPid = null;
  state.publicUrl = publicUrl;
}

async function stopRemoteAccess() {
  state.revoked = true;
  state.publicUrl = null;

  for (const remote of getActiveRemotes()) {
    remote.revoked = true;
  }

  if (state.ngrokListener) {
    await state.ngrokListener.close();
    state.ngrokListener = null;
  }
}

async function closeAllRemotes() {
  for (const remote of state.remotes.values()) {
    await endRemoteFromMobile(remote);
  }
}

async function shutdown() {
  if (state.shuttingDown) {
    return;
  }

  state.shuttingDown = true;
  await closeAllRemotes();
  await stopRemoteAccess();
  if (state.server) {
    await new Promise((resolve) => state.server.close(resolve));
    state.server = null;
  }
  process.exit(0);
}

async function handleRequest(req, res) {
  try {
    const requestUrl = new URL(
      req.url || "/",
      `http://${req.headers.host || "127.0.0.1"}`,
    );
    const pathname = requestUrl.pathname;

    if (pathname === "/") {
      redirect(res, `/host?admin=${adminToken}`);
      return;
    }

    if (pathname === "/host") {
      if (!isAdminAuthorized(requestUrl)) {
        sendText(res, 401, "Unauthorized");
        return;
      }

      sendHtml(res, renderHostPage());
      return;
    }

    if (pathname === "/remote") {
      const remote = getAuthorizedRemote(requestUrl);
      if (!remote) {
        sendText(res, 401, "Unauthorized");
        return;
      }

      remote.lastSeenAt = new Date().toISOString();
      sendHtml(res, renderRemotePage(remote));
      return;
    }

    if (pathname === "/api/status") {
      if (!isAdminAuthorized(requestUrl)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      sendJson(res, 200, {
        createdAt: state.createdAt,
        serverPort: state.serverPort,
        publicUrl: state.publicUrl,
        tunnelPid: state.tunnelPid,
        revoked: state.revoked,
        error: state.error,
        defaultWorkingDirectory: state.defaultWorkingDirectory,
        invocationPaneId: state.invocationPaneId,
        remotes: await Promise.all(
          getActiveRemotes().map((remote) => serializeRemoteForHost(remote)),
        ),
      });
      return;
    }

    if (pathname === "/api/targets") {
      if (!isAdminAuthorized(requestUrl)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const targets = await listTmuxTargets();
      sendJson(res, 200, {
        targets: serializeTargets(targets),
        invocationPaneId: state.invocationPaneId,
      });
      return;
    }

    if (pathname === "/api/admin/remotes" && req.method === "POST") {
      if (!isAdminAuthorized(requestUrl)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const body = await readJsonBody(req);
      const action = body.action;

      if (action === "attach_target") {
        const target = typeof body.target === "string" ? body.target : "";
        const label = typeof body.label === "string" ? body.label.trim() : "";
        const remote = await addRemoteFromTargetSpec(target, {
          label: label || undefined,
          source: "attached",
        });
        sendJson(res, 200, { ok: true, remote: serializeRemote(remote) });
        return;
      }

      if (action === "create_detached") {
        const workingDirectory =
          typeof body.workingDirectory === "string"
            ? body.workingDirectory.trim()
            : "";
        const label = typeof body.label === "string" ? body.label.trim() : "";

        const remote = await addDetachedRemote({
          workingDirectory: workingDirectory || state.defaultWorkingDirectory,
          label: label || undefined,
        });
        sendJson(res, 200, { ok: true, remote: serializeRemote(remote) });
        return;
      }

      if (action === "revoke_remote") {
        const remote = getRemoteById(body.id);
        if (!remote) {
          sendJson(res, 404, { error: "remote_not_found" });
          return;
        }

        remote.revoked = true;
        sendJson(res, 200, { ok: true });
        return;
      }

      sendJson(res, 400, { error: "unsupported_action" });
      return;
    }

    if (pathname === "/api/screen") {
      const remote = getAuthorizedRemote(requestUrl);
      if (!remote) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      remote.lastSeenAt = new Date().toISOString();
      const screen = await capturePane(remote);
      sendJson(res, 200, {
        screen,
        remote: serializeRemote(remote),
        revoked: state.revoked || remote.revoked,
        error: state.error,
      });
      return;
    }

    if (pathname === "/api/send" && req.method === "POST") {
      const remote = getAuthorizedRemote(requestUrl);
      if (!remote) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      const body = await readJsonBody(req);
      const text = typeof body.text === "string" ? body.text : "";
      const enter = body.enter !== false;

      await sendLiteral(remote, text);
      if (enter) {
        if (text) {
          await wait(literalEnterDelayMs);
        }
        await sendKey(remote, "Enter");
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/api/control" && req.method === "POST") {
      const body = await readJsonBody(req);

      if (body.action === "stop_remote") {
        if (!isAdminAuthorized(requestUrl)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        await stopRemoteAccess();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (body.action === "shutdown_host") {
        if (!isAdminAuthorized(requestUrl)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }

        sendJson(res, 200, { ok: true });
        setTimeout(() => {
          shutdown().catch(() => {});
        }, 50);
        return;
      }

      const remote = getAuthorizedRemote(requestUrl);
      if (!remote) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (body.action === "ctrl_c") {
        await sendKey(remote, "C-c");
      } else if (body.action === "escape") {
        await sendKey(remote, "Escape");
      } else if (body.action === "tab") {
        await sendKey(remote, "Tab");
      } else if (body.action === "enter") {
        await sendKey(remote, "Enter");
      } else if (body.action === "end_session") {
        await endRemoteFromMobile(remote);
      } else {
        sendJson(res, 400, { error: "unsupported_action" });
        return;
      }

      sendJson(res, 200, { ok: true });
      return;
    }

    sendText(res, 404, "Not found");
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isAdminAuthorized(url) {
  return url.searchParams.get("admin") === adminToken;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
    });

    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });

    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, html) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

async function openHostDashboard() {
  const localUrl = `http://127.0.0.1:${state.serverPort}/host?admin=${adminToken}`;
  const child = spawn("open", [localUrl], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function printStartupSummary() {
  console.log("");
  console.log("Remote terminal listo.");
  console.log(`cwd default: ${state.defaultWorkingDirectory}`);
  console.log(`host dashboard: http://127.0.0.1:${state.serverPort}/host?admin=${adminToken}`);

  for (const remote of getActiveRemotes()) {
    console.log(`remote: ${remote.label} -> ${remote.targetRef}`);
    if (buildRemoteUrl(remote)) {
      console.log(`url: ${buildRemoteUrl(remote)}`);
    }
  }

  if (state.error) {
    console.log(`warning: ${state.error}`);
  }

  console.log("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHostPage() {
  const admin = escapeHtml(adminToken);
  const cwd = escapeHtml(state.defaultWorkingDirectory);
  const invocationPane = escapeHtml(state.invocationPaneId || "Not detected");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Remote Terminal Host</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: rgba(15, 23, 42, 0.92);
      --panel-soft: rgba(15, 23, 42, 0.72);
      --border: rgba(148, 163, 184, 0.18);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-soft: rgba(56, 189, 248, 0.18);
      --danger: #f87171;
      --danger-soft: rgba(248, 113, 113, 0.14);
      --ok: #22c55e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at top, rgba(56, 189, 248, 0.16), transparent 38%),
        linear-gradient(180deg, #07111f 0%, #020617 100%);
    }
    .wrap {
      width: min(100%, 78rem);
      margin: 0 auto;
      padding: 1.4rem;
      display: grid;
      gap: 1rem;
    }
    .hero, .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 1.2rem;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.34);
      backdrop-filter: blur(18px);
    }
    .hero {
      padding: 1.25rem 1.4rem;
      display: grid;
      gap: 1rem;
      grid-template-columns: minmax(0, 1.6fr) minmax(16rem, 1fr);
      align-items: start;
    }
    h1, h2, h3 {
      margin: 0;
    }
    h1 {
      font-size: 1.65rem;
      margin-bottom: 0.45rem;
    }
    p {
      margin: 0;
      color: var(--muted);
      line-height: 1.5;
    }
    .meta-grid {
      display: grid;
      gap: 0.75rem;
    }
    .meta-item, .summary-chip {
      padding: 0.9rem 1rem;
      border-radius: 0.95rem;
      border: 1px solid var(--border);
      background: rgba(15, 23, 42, 0.6);
    }
    .meta-label {
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: 0.72rem;
      margin-bottom: 0.35rem;
    }
    .meta-value {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      word-break: break-word;
      font-size: 0.9rem;
    }
    .layout {
      display: grid;
      gap: 1rem;
      grid-template-columns: minmax(18rem, 24rem) minmax(0, 1fr);
    }
    .card {
      padding: 1.15rem;
      display: grid;
      gap: 1rem;
    }
    .stack {
      display: grid;
      gap: 0.75rem;
    }
    .inline {
      display: grid;
      gap: 0.6rem;
      grid-template-columns: minmax(0, 1fr) auto;
    }
    .summary-row {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
    }
    .summary-chip {
      min-width: 10rem;
    }
    .remotes {
      display: grid;
      gap: 0.85rem;
    }
    .remote-card {
      padding: 1rem;
      border-radius: 1rem;
      border: 1px solid var(--border);
      background: var(--panel-soft);
      display: grid;
      gap: 0.85rem;
    }
    .remote-body {
      display: grid;
      gap: 0.85rem;
      grid-template-columns: minmax(0, 1fr) minmax(10rem, 12rem);
      align-items: start;
    }
    .qr-tile {
      display: grid;
      gap: 0.5rem;
      padding: 0.85rem;
      border-radius: 1rem;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.96);
      color: #0f172a;
      justify-items: center;
      text-align: center;
    }
    .qr-tile img {
      width: 100%;
      max-width: 10rem;
      height: auto;
      display: block;
    }
    .qr-tile span {
      font-size: 0.78rem;
      color: #334155;
    }
    .remote-head {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 0.85rem;
      align-items: center;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      min-height: 2rem;
      padding: 0.35rem 0.8rem;
      border-radius: 999px;
      font-size: 0.8rem;
      border: 1px solid rgba(56, 189, 248, 0.3);
      background: var(--accent-soft);
      color: #bae6fd;
    }
    .badge.revoked {
      border-color: rgba(248, 113, 113, 0.35);
      background: var(--danger-soft);
      color: #fecaca;
    }
    .remote-meta {
      display: grid;
      gap: 0.65rem;
      grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    }
    .remote-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.65rem;
    }
    .remote-actions button[data-action="continue"] {
      background: rgba(15, 23, 42, 0.6);
    }
    button.copied {
      border-color: rgba(74, 222, 128, 0.38);
      background: rgba(21, 128, 61, 0.3);
      color: #dcfce7;
    }
    input, select, button {
      width: 100%;
      min-height: 2.9rem;
      padding: 0.8rem 0.95rem;
      border-radius: 0.9rem;
      border: 1px solid var(--border);
      background: rgba(15, 23, 42, 0.88);
      color: var(--text);
      font: inherit;
    }
    button {
      width: auto;
      font-weight: 700;
      cursor: pointer;
      padding-inline: 1rem;
    }
    button.primary {
      border-color: rgba(56, 189, 248, 0.35);
      background: linear-gradient(135deg, rgba(56,189,248,0.22), rgba(14,165,233,0.35));
    }
    button.danger {
      border-color: rgba(248, 113, 113, 0.35);
      color: #fecaca;
      background: rgba(127, 29, 29, 0.2);
    }
    button.ghost {
      background: rgba(15, 23, 42, 0.6);
    }
    .hint {
      padding: 0.9rem 1rem;
      border-radius: 0.95rem;
      border: 1px dashed rgba(148, 163, 184, 0.3);
      color: var(--muted);
      line-height: 1.5;
      background: rgba(15, 23, 42, 0.35);
    }
    .notice {
      display: none;
      padding: 0.85rem 1rem;
      border-radius: 0.95rem;
      border: 1px solid rgba(248, 113, 113, 0.32);
      color: #fecaca;
      background: rgba(127, 29, 29, 0.22);
    }
    .notice.show {
      display: block;
    }
    .empty {
      padding: 1rem;
      border-radius: 0.95rem;
      border: 1px dashed rgba(148, 163, 184, 0.26);
      color: var(--muted);
      text-align: center;
    }
    @media (max-width: 980px) {
      .hero, .layout {
        grid-template-columns: 1fr;
      }
    }
    @media (max-width: 640px) {
      .wrap {
        padding: 0.8rem;
      }
      .inline {
        grid-template-columns: 1fr;
      }
      .remote-actions button,
      .summary-row button {
        width: 100%;
      }
      .remote-body {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="hero">
      <div>
        <h1>Remote Terminal Router</h1>
        <p>One ngrok tunnel, several tmux targets. Attach an existing pane or spawn detached remotes and manage them from the same dashboard.</p>
      </div>
      <div class="meta-grid">
        <div class="meta-item">
          <div class="meta-label">Default working directory</div>
          <div class="meta-value">${cwd}</div>
        </div>
        <div class="meta-item">
          <div class="meta-label">Invocation tmux pane</div>
          <div class="meta-value">${invocationPane}</div>
        </div>
      </div>
    </section>

    <div class="layout">
      <section class="card">
        <div class="stack">
          <h2>Attach Existing Target</h2>
          <p>Pick any active tmux pane. This is how you reuse a session you already have instead of forcing a new detached one.</p>
          <form id="attach-form" class="stack">
            <div class="inline">
              <select id="target-select"></select>
              <button class="ghost" id="refresh-targets-btn" type="button">Refresh</button>
            </div>
            <input id="attach-label" placeholder="Optional label for this remote" />
            <button class="primary" type="submit">Attach Target</button>
          </form>
        </div>

        <div class="stack">
          <h2>Create Detached Remote</h2>
          <p>Create a clean tmux session that can be opened remotely without touching your active panes.</p>
          <form id="detached-form" class="stack">
            <input id="detached-cwd" value="${cwd}" placeholder="Working directory" />
            <input id="detached-label" placeholder="Optional label" />
            <button type="submit">Create Detached Session</button>
          </form>
        </div>

        <div class="hint">
          If you want the exact pane you are already using, run the host from another pane or in background and then attach that pane here. If the host itself occupies the pane, the remote will only see the host process.
        </div>
      </section>

      <section class="card">
        <div class="summary-row">
          <div class="summary-chip">
            <div class="meta-label">Tunnel</div>
            <div class="meta-value" id="status-text">Starting...</div>
          </div>
          <div class="summary-chip">
            <div class="meta-label">Public URL</div>
            <div class="meta-value" id="public-url">Waiting for tunnel...</div>
          </div>
          <button class="danger" id="stop-btn" type="button">Stop Remote Access</button>
          <button class="danger" id="shutdown-btn" type="button">End All & Exit</button>
        </div>

        <div class="notice" id="notice"></div>

        <div class="stack">
          <div>
            <h2>Remote Sessions</h2>
            <p>Each card has its own secure remote URL and can be revoked independently.</p>
          </div>
          <div class="remotes" id="remote-list">
            <div class="empty">Loading remotes...</div>
          </div>
        </div>
      </section>
    </div>
  </main>

  <script>
    const admin = ${JSON.stringify(admin)};
    const targetSelect = document.getElementById("target-select");
    const attachForm = document.getElementById("attach-form");
    const detachedForm = document.getElementById("detached-form");
    const remoteList = document.getElementById("remote-list");
    const publicUrlEl = document.getElementById("public-url");
    const statusText = document.getElementById("status-text");
    const stopBtn = document.getElementById("stop-btn");
    const shutdownBtn = document.getElementById("shutdown-btn");
    const notice = document.getElementById("notice");
    const refreshTargetsBtn = document.getElementById("refresh-targets-btn");
    let currentStatus = null;
    const dashboardConnectionError = "Host connection lost. Open the latest dashboard URL from the terminal and reload this page.";

    function escapeHtml(value) {
      return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
    }

    function showNotice(message, isError = true) {
      if (!message) {
        notice.textContent = "";
        notice.classList.remove("show");
        return;
      }

      notice.textContent = message;
      notice.classList.add("show");
      notice.style.borderColor = isError
        ? "rgba(248, 113, 113, 0.32)"
        : "rgba(56, 189, 248, 0.32)";
      notice.style.background = isError
        ? "rgba(127, 29, 29, 0.22)"
        : "rgba(8, 47, 73, 0.28)";
      notice.style.color = isError ? "#fecaca" : "#bae6fd";
    }

    function flashCopiedButton(button, copiedText = "Copied") {
      if (!button) {
        return;
      }

      clearTimeout(button._copiedTimer);
      if (!button.dataset.originalText) {
        button.dataset.originalText = button.textContent;
      }

      button.textContent = copiedText;
      button.classList.add("copied");
      button._copiedTimer = setTimeout(() => {
        button.textContent = button.dataset.originalText || button.textContent;
        button.classList.remove("copied");
      }, 1600);
    }

    async function requestJson(url, options) {
      let response;
      try {
        response = await fetch(url, options);
      } catch {
        throw new Error(dashboardConnectionError);
      }

      let data = {};
      try {
        data = await response.json();
      } catch {
        if (!response.ok) {
          throw new Error("request_failed");
        }
      }

      if (!response.ok) {
        throw new Error(data.error || "request_failed");
      }

      return data;
    }

    async function getJson(url) {
      return requestJson(url);
    }

    async function postJson(url, body) {
      return requestJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    function renderTargets(targets, invocationPaneId) {
      if (!targets.length) {
        targetSelect.innerHTML = '<option value="">No tmux targets found</option>';
        return;
      }

      targetSelect.innerHTML = targets.map((target) => {
        const selected = invocationPaneId && target.paneId === invocationPaneId ? " selected" : "";
        return '<option value="' + escapeHtml(target.paneId) + '"' + selected + '>' + escapeHtml(target.label) + '</option>';
      }).join("");
    }

    function renderRemotes(remotes) {
      if (!remotes.length) {
        remoteList.innerHTML = '<div class="empty">No remote sessions registered yet.</div>';
        return;
      }

      remoteList.innerHTML = remotes.map((remote) => {
        const badgeClass = remote.revoked ? "badge revoked" : "badge";
        const badgeLabel = remote.revoked ? "Revoked" : (remote.remoteUrl ? "Ready" : "Waiting for tunnel");
        const remoteUrl = remote.remoteUrl
          ? '<div class="meta-item"><div class="meta-label">Remote URL</div><div class="meta-value">' + escapeHtml(remote.remoteUrl) + '</div></div>'
          : "";
        const qrTile = remote.qrDataUrl
          ? [
              '<aside class="qr-tile">',
              '  <img src="' + escapeHtml(remote.qrDataUrl) + '" alt="QR for ' + escapeHtml(remote.label) + '" />',
              '  <span>Scan from your phone</span>',
              '</aside>',
            ].join("")
          : '<aside class="qr-tile"><span>QR available when the tunnel is ready.</span></aside>';

        return [
          '<article class="remote-card" data-remote-id="' + escapeHtml(remote.id) + '">',
          '  <div class="remote-head">',
          '    <div>',
          '      <h3>' + escapeHtml(remote.label) + '</h3>',
          '      <p>' + escapeHtml(remote.targetRef) + ' · ' + escapeHtml(remote.source) + '</p>',
          '    </div>',
          '    <span class="' + badgeClass + '">' + escapeHtml(badgeLabel) + '</span>',
          '  </div>',
          '  <div class="remote-body">',
          '    <div class="remote-meta">',
          '      <div class="meta-item"><div class="meta-label">Session</div><div class="meta-value">' + escapeHtml(remote.sessionName) + '</div></div>',
          '      <div class="meta-item"><div class="meta-label">Working directory</div><div class="meta-value">' + escapeHtml(remote.workingDirectory) + '</div></div>',
          '      <div class="meta-item"><div class="meta-label">Last mobile activity</div><div class="meta-value">' + escapeHtml(remote.lastSeenAt || "No activity yet") + '</div></div>',
          remoteUrl,
          '    </div>',
          qrTile,
          '  </div>',
          '  <div class="remote-actions">',
          '    <button type="button" data-action="continue">Continue in Terminal</button>',
          '    <button class="primary" type="button" data-action="copy"' + (remote.remoteUrl ? "" : " disabled") + '>Copy URL</button>',
          '    <button type="button" data-action="open"' + (remote.remoteUrl ? "" : " disabled") + '>Open Remote</button>',
          '    <button class="danger" type="button" data-action="revoke">Revoke</button>',
          '  </div>',
          '</article>',
        ].join("");
      }).join("");
    }

    async function fetchStatus() {
      const data = await getJson('/api/status?admin=' + encodeURIComponent(admin));
      currentStatus = data;
      publicUrlEl.textContent = data.publicUrl || (data.error || 'Waiting for tunnel...');
      statusText.textContent = data.revoked
        ? 'Remote access stopped'
        : (data.error ? 'Error: ' + data.error : (data.publicUrl ? 'Ready' : 'Starting tunnel...'));
      renderRemotes(data.remotes || []);
    }

    async function refreshTargets() {
      const data = await getJson('/api/targets?admin=' + encodeURIComponent(admin));
      renderTargets(data.targets || [], data.invocationPaneId);
    }

    attachForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      showNotice("");
      try {
        await postJson('/api/admin/remotes?admin=' + encodeURIComponent(admin), {
          action: 'attach_target',
          target: targetSelect.value,
          label: document.getElementById('attach-label').value,
        });
        document.getElementById('attach-label').value = '';
        await Promise.all([fetchStatus(), refreshTargets()]);
      } catch (error) {
        showNotice(error.message || String(error));
      }
    });

    detachedForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      showNotice("");
      try {
        await postJson('/api/admin/remotes?admin=' + encodeURIComponent(admin), {
          action: 'create_detached',
          workingDirectory: document.getElementById('detached-cwd').value,
          label: document.getElementById('detached-label').value,
        });
        document.getElementById('detached-label').value = '';
        await Promise.all([fetchStatus(), refreshTargets()]);
      } catch (error) {
        showNotice(error.message || String(error));
      }
    });

    refreshTargetsBtn.addEventListener("click", async () => {
      showNotice("");
      try {
        await refreshTargets();
      } catch (error) {
        showNotice(error.message || String(error));
      }
    });

    stopBtn.addEventListener("click", async () => {
      showNotice("");
      try {
        await postJson('/api/control?admin=' + encodeURIComponent(admin), {
          action: 'stop_remote',
        });
        await fetchStatus();
      } catch (error) {
        showNotice(error.message || String(error));
      }
    });

    shutdownBtn.addEventListener("click", async () => {
      if (!window.confirm('End all remotes, stop ngrok, kill detached tmux sessions, and close this host?')) {
        return;
      }

      showNotice('Shutting down host and ending detached sessions...', false);
      stopBtn.disabled = true;
      shutdownBtn.disabled = true;
      refreshTargetsBtn.disabled = true;

      try {
        await postJson('/api/control?admin=' + encodeURIComponent(admin), {
          action: 'shutdown_host',
        });
        statusText.textContent = 'Stopping...';
        publicUrlEl.textContent = 'Host shutting down...';
      } catch (error) {
        stopBtn.disabled = false;
        shutdownBtn.disabled = false;
        refreshTargetsBtn.disabled = false;
        showNotice(error.message || String(error));
      }
    });

    remoteList.addEventListener("click", async (event) => {
      const button = event.target.closest('button[data-action]');
      const card = event.target.closest('[data-remote-id]');
      if (!button || !card || !currentStatus) {
        return;
      }

      const remote = (currentStatus.remotes || []).find((entry) => entry.id === card.dataset.remoteId);
      if (!remote) {
        return;
      }

      const action = button.dataset.action;
      showNotice("");

      try {
        if (action === 'continue' && remote.continueCommand) {
          await navigator.clipboard.writeText(remote.continueCommand);
          flashCopiedButton(button);
          showNotice('Continue command copied', false);
          return;
        }

        if (action === 'copy' && remote.remoteUrl) {
          await navigator.clipboard.writeText(remote.remoteUrl);
          flashCopiedButton(button);
          showNotice('Remote URL copied', false);
          return;
        }

        if (action === 'open' && remote.remoteUrl) {
          window.open(remote.remoteUrl, '_blank', 'noopener,noreferrer');
          return;
        }

        if (action === 'revoke') {
          await postJson('/api/admin/remotes?admin=' + encodeURIComponent(admin), {
            action: 'revoke_remote',
            id: remote.id,
          });
          await fetchStatus();
        }
      } catch (error) {
        showNotice(error.message || String(error));
      }
    });

    Promise.all([fetchStatus(), refreshTargets()]).catch((error) => {
      showNotice(error.message || String(error));
    });

    setInterval(() => {
      fetchStatus().catch(() => {});
    }, 2000);
  </script>
</body>
</html>`;
}

function renderRemotePage(remote) {
  const token = escapeHtml(remote.remoteToken);
  const remoteId = escapeHtml(remote.id);
  const remoteLabel = escapeHtml(remote.label);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>${remoteLabel}</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #040814;
      --panel: rgba(15, 23, 42, 0.95);
      --panel-soft: rgba(15, 23, 42, 0.86);
      --border: rgba(148, 163, 184, 0.2);
      --text: #e2e8f0;
      --muted: #94a3b8;
      --accent: #38bdf8;
      --accent-soft: rgba(56, 189, 248, 0.14);
      --danger: #f87171;
      --danger-soft: rgba(248, 113, 113, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at top, rgba(56, 189, 248, 0.14), transparent 35%),
        linear-gradient(180deg, #040814 0%, #020617 100%);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      padding:
        max(0.7rem, env(safe-area-inset-top))
        0.7rem
        calc(0.9rem + env(safe-area-inset-bottom))
        0.7rem;
    }
    .wrap {
      width: min(100%, 54rem);
      margin: 0 auto;
      display: grid;
      gap: 0.85rem;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 1rem;
      box-shadow: 0 18px 60px rgba(0,0,0,0.34);
      overflow: hidden;
    }
    .head {
      padding: 0.95rem;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      align-items: start;
    }
    .head h1 {
      margin: 0 0 0.2rem;
      font-size: 1rem;
    }
    .head p {
      margin: 0;
      color: var(--muted);
      font-size: 0.84rem;
      line-height: 1.45;
      word-break: break-word;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      min-height: 2rem;
      padding: 0.35rem 0.75rem;
      border-radius: 999px;
      font-size: 0.78rem;
      border: 1px solid rgba(56, 189, 248, 0.3);
      background: var(--accent-soft);
      color: #bae6fd;
      white-space: nowrap;
    }
    .meta {
      color: var(--muted);
      font-size: 0.82rem;
      padding: 0 0.95rem 0.9rem;
      word-break: break-word;
    }
    .desktop-continue {
      padding: 0 0.95rem 0.7rem;
      display: grid;
      gap: 0.45rem;
      justify-items: start;
    }
    .desktop-continue button {
      min-height: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: #94cfff;
      font-size: 0.78rem;
      font-weight: 600;
      text-decoration: underline;
      text-decoration-color: rgba(148, 207, 255, 0.35);
      text-underline-offset: 0.2rem;
      cursor: pointer;
    }
    .desktop-continue button:disabled {
      opacity: 0.6;
    }
    .continue-command {
      width: 100%;
      display: flex;
      align-items: flex-start;
      gap: 0.5rem;
      padding: 0.68rem 0.78rem;
      border-radius: 0.9rem;
      border: 1px solid var(--border);
      background: rgba(15, 23, 42, 0.55);
    }
    .continue-command.copied {
      border-color: rgba(74, 222, 128, 0.38);
      background: rgba(21, 128, 61, 0.16);
    }
    .continue-command[hidden] {
      display: none;
    }
    .continue-command code {
      flex: 1 1 auto;
      min-width: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.76rem;
      line-height: 1.45;
      color: #dbeafe;
      word-break: break-word;
      white-space: pre-wrap;
    }
    .continue-command button {
      flex: 0 0 auto;
      min-height: 2.15rem;
      padding: 0.45rem 0.72rem;
      border-radius: 0.82rem;
    }
    pre {
      margin: 0;
      min-height: min(56vh, 32rem);
      max-height: 60vh;
      overflow: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      padding: 0.95rem;
      background: rgba(2, 6, 23, 0.9);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8rem;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      border-top: 1px solid rgba(255,255,255,0.02);
      border-bottom: 1px solid rgba(255,255,255,0.02);
    }
    .controls {
      display: grid;
      gap: 0.65rem;
      padding: 0.8rem;
      background: linear-gradient(180deg, rgba(4, 8, 20, 0), rgba(4, 8, 20, 0.32) 18%, rgba(4, 8, 20, 0.86) 100%);
    }
    .composer {
      display: grid;
      gap: 0.5rem;
    }
    .composer-main {
      display: flex;
      align-items: stretch;
      gap: 0.5rem;
    }
    .composer-main input {
      flex: 1 1 auto;
      min-width: 0;
    }
    .composer-status[hidden] {
      display: none;
    }
    .composer-status {
      min-height: 0.95rem;
      font-size: 0.74rem;
      line-height: 1.35;
      color: var(--muted);
    }
    .composer-status[data-tone="accent"] {
      color: #bae6fd;
    }
    .composer-status[data-tone="success"] {
      color: #bbf7d0;
    }
    .composer-status[data-tone="error"] {
      color: #fecaca;
    }
    .controls-toggle {
      align-self: flex-end;
      min-height: 2.2rem;
      padding: 0.45rem 0.78rem;
    }
    input, button {
      min-height: 2.7rem;
      border-radius: 0.92rem;
      border: 1px solid var(--border);
      background: var(--panel-soft);
      color: var(--text);
      font: inherit;
    }
    input {
      width: 100%;
      padding: 0.76rem 0.92rem;
    }
    button {
      padding: 0.65rem 0.9rem;
      font-weight: 650;
      cursor: pointer;
      white-space: nowrap;
    }
    button:disabled {
      cursor: wait;
      opacity: 0.72;
    }
    button.primary {
      border-color: rgba(56, 189, 248, 0.32);
      background: linear-gradient(135deg, rgba(56,189,248,0.22), rgba(14,165,233,0.35));
    }
    button.secondary {
      border-color: rgba(148,163,184,0.28);
      background: rgba(15, 23, 42, 0.74);
      color: #cbd5e1;
    }
    button.secondary.active {
      border-color: rgba(74, 222, 128, 0.3);
      background: rgba(21, 128, 61, 0.26);
      color: #dcfce7;
    }
    button.danger {
      border-color: rgba(248,113,113,0.32);
      background: rgba(127, 29, 29, 0.2);
      color: #fecaca;
    }
    .terminal-actions {
      display: grid;
      gap: 0.6rem;
      grid-template-columns: repeat(5, minmax(0, 1fr));
    }
    .terminal-actions[hidden] {
      display: none;
    }
    .terminal-actions button {
      width: 100%;
      min-width: 0;
    }
    .icon-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 2.9rem;
      padding-inline: 0.82rem;
    }
    .icon-button svg {
      width: 1.05rem;
      height: 1.05rem;
      fill: currentColor;
    }
    @media (max-width: 640px) {
      body {
        padding:
          max(0.45rem, env(safe-area-inset-top))
          0.45rem
          calc(0.75rem + env(safe-area-inset-bottom))
          0.45rem;
      }
      .head {
        flex-direction: column;
      }
      pre {
        min-height: 52vh;
        max-height: 58vh;
        padding: 0.85rem;
      }
      .controls {
        gap: 0.55rem;
        padding: 0.7rem;
      }
      .composer-main {
        gap: 0.42rem;
      }
      input, button {
        min-height: 2.48rem;
      }
      button {
        padding: 0.56rem 0.74rem;
      }
      .terminal-actions {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .terminal-actions button {
        min-height: 2.42rem;
      }
      #end-btn {
        grid-column: 1 / -1;
      }
    }
  </style>
</head>
<body>
  <main class="wrap">
    <section class="card">
      <div class="head">
        <div>
          <h1>${remoteLabel}</h1>
          <p id="meta-line">Connecting…</p>
        </div>
        <span class="badge" id="status-badge">Connecting</span>
      </div>
      <div class="meta" id="meta-secondary">Loading terminal…</div>
      <div class="desktop-continue">
        <button id="continue-terminal-btn" type="button">Continue in Terminal</button>
        <div class="continue-command" id="continue-command" hidden>
          <code id="continue-command-text"></code>
          <button class="secondary" id="copy-continue-btn" type="button">Copy</button>
        </div>
      </div>
      <pre id="screen">Loading terminal...\n</pre>
      <div class="controls">
        <form class="composer" id="composer">
          <div class="composer-main">
            <input
              id="command-input"
              autocomplete="off"
              autocapitalize="off"
              autocorrect="off"
              spellcheck="false"
              enterkeyhint="send"
              placeholder="Type or dictate a command"
            />
            <button class="secondary icon-button" id="voice-btn" type="button" hidden title="Voice input" aria-label="Start voice input"></button>
            <button class="primary" id="send-btn" type="submit">Send</button>
          </div>
          <div class="composer-status" id="composer-status" hidden aria-live="polite"></div>
          <button class="secondary controls-toggle" id="toggle-actions-btn" type="button" aria-expanded="false" aria-controls="terminal-actions">Show Keys</button>
          <div class="terminal-actions" id="terminal-actions" hidden>
            <button class="secondary" id="esc-btn" type="button">Esc</button>
            <button class="secondary" id="tab-btn" type="button">Tab</button>
            <button class="secondary" id="enter-btn" type="button">Enter</button>
            <button class="danger" id="ctrlc-btn" type="button">Ctrl+C</button>
            <button class="danger" id="end-btn" type="button">End</button>
          </div>
        </form>
      </div>
    </section>
  </main>

  <script>
    const token = ${JSON.stringify(token)};
    const remoteId = ${JSON.stringify(remoteId)};
    const screen = document.getElementById("screen");
    const metaLine = document.getElementById("meta-line");
    const metaSecondary = document.getElementById("meta-secondary");
    const badge = document.getElementById("status-badge");
    const input = document.getElementById("command-input");
    const sendButton = document.getElementById("send-btn");
    const continueTerminalButton = document.getElementById("continue-terminal-btn");
    const continueCommandBox = document.getElementById("continue-command");
    const continueCommandText = document.getElementById("continue-command-text");
    const copyContinueButton = document.getElementById("copy-continue-btn");
    const toggleActionsButton = document.getElementById("toggle-actions-btn");
    const terminalActions = document.getElementById("terminal-actions");
    const escButton = document.getElementById("esc-btn");
    const tabButton = document.getElementById("tab-btn");
    const enterButton = document.getElementById("enter-btn");
    const ctrlCButton = document.getElementById("ctrlc-btn");
    const endButton = document.getElementById("end-btn");
    const voiceButton = document.getElementById("voice-btn");
    const composerStatus = document.getElementById("composer-status");
    let running = true;
    let pendingAction = false;
    let statusTimer = null;
    let fetchInFlight = null;
    let pollTimer = null;
    let burstUntil = 0;
    let screenRequestId = 0;
    let appliedScreenRequestId = 0;
    let recognition = null;
    let recognitionSupported = false;
    let listening = false;
    let actionsExpanded = false;
    let continueCommandVisible = false;
    let currentContinueCommand = ${JSON.stringify(buildContinueCommand(remote.sessionName))};
    let followScreen = true;
    let forceFollowScreen = true;
    let screenHydrated = false;
    const micIcon = [
      '<svg viewBox="0 0 24 24" aria-hidden="true">',
      '  <path d="M12 15a3 3 0 0 0 3-3V7a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Zm5-3a1 1 0 1 1 2 0a7 7 0 0 1-6 6.92V21h3a1 1 0 1 1 0 2H8a1 1 0 0 1 0-2h3v-2.08A7 7 0 0 1 5 12a1 1 0 1 1 2 0a5 5 0 0 0 10 0Z" />',
      '</svg>',
    ].join('');
    const stopIcon = [
      '<svg viewBox="0 0 24 24" aria-hidden="true">',
      '  <path d="M7 7h10v10H7z" />',
      '</svg>',
    ].join('');

    function badgeDisconnected(label) {
      badge.textContent = label;
      badge.style.borderColor = "rgba(248,113,113,0.32)";
      badge.style.background = "rgba(248,113,113,0.12)";
      badge.style.color = "#fecaca";
    }

    function buildUrl(path) {
      return path + '?id=' + encodeURIComponent(remoteId) + '&token=' + encodeURIComponent(token);
    }

    function setStatus(message, tone = '', persist = false) {
      clearTimeout(statusTimer);
      composerStatus.hidden = !message;

      if (!message) {
        composerStatus.textContent = '';
        composerStatus.removeAttribute('data-tone');
        return;
      }

      composerStatus.textContent = message;
      if (tone) {
        composerStatus.setAttribute('data-tone', tone);
      } else {
        composerStatus.removeAttribute('data-tone');
      }

      if (!persist) {
        statusTimer = setTimeout(() => {
          composerStatus.hidden = true;
          composerStatus.textContent = '';
          composerStatus.removeAttribute('data-tone');
        }, 1800);
      }
    }

    function clearComposer() {
      input.value = '';
      input.setAttribute('value', '');
    }

    function isNearBottom() {
      return screen.scrollHeight - screen.clientHeight - screen.scrollTop <= 28;
    }

    function scrollScreenToBottom() {
      screen.scrollTop = screen.scrollHeight;
      followScreen = true;
    }

    function syncActionVisibility() {
      terminalActions.hidden = !actionsExpanded;
      toggleActionsButton.textContent = actionsExpanded ? 'Hide Keys' : 'Show Keys';
      toggleActionsButton.setAttribute('aria-expanded', String(actionsExpanded));
    }

    function syncContinueCommand() {
      continueCommandText.textContent = currentContinueCommand || '';
      continueCommandBox.hidden = !continueCommandVisible || !currentContinueCommand;
      continueTerminalButton.textContent = continueCommandVisible ? 'Hide Terminal Command' : 'Continue in Terminal';
    }

    function flashCopiedButton(button, copiedText = 'Copied') {
      if (!button) {
        return;
      }

      clearTimeout(button._copiedTimer);
      if (!button.dataset.originalText) {
        button.dataset.originalText = button.textContent;
      }

      button.textContent = copiedText;
      button.classList.add('copied');
      button._copiedTimer = setTimeout(() => {
        button.textContent = button.dataset.originalText || button.textContent;
        button.classList.remove('copied');
      }, 1600);
    }

    function flashContinueCommandBox() {
      clearTimeout(continueCommandBox._copiedTimer);
      continueCommandBox.classList.add('copied');
      continueCommandBox._copiedTimer = setTimeout(() => {
        continueCommandBox.classList.remove('copied');
      }, 1600);
    }

    function syncControls() {
      sendButton.disabled = pendingAction;
      continueTerminalButton.disabled = pendingAction;
      copyContinueButton.disabled = pendingAction || !currentContinueCommand;
      toggleActionsButton.disabled = pendingAction;
      escButton.disabled = pendingAction;
      tabButton.disabled = pendingAction;
      enterButton.disabled = pendingAction;
      ctrlCButton.disabled = pendingAction;
      endButton.disabled = pendingAction;

      voiceButton.hidden = !recognitionSupported;
      voiceButton.disabled = listening ? false : pendingAction || !recognitionSupported;
      voiceButton.classList.toggle('active', listening);
      voiceButton.innerHTML = listening ? stopIcon : micIcon;
      voiceButton.setAttribute('aria-label', listening ? 'Stop voice input' : 'Start voice input');
      voiceButton.title = listening ? 'Stop voice input' : 'Voice input';
    }

    function scheduleBurst(durationMs = 2200) {
      burstUntil = Math.max(burstUntil, Date.now() + durationMs);
      if (!pollTimer) {
        scheduleNextPoll(80);
      }
    }

    function nextPollDelay() {
      return Date.now() < burstUntil ? 110 : 240;
    }

    function scheduleNextPoll(delay = nextPollDelay()) {
      clearTimeout(pollTimer);
      if (!running) {
        return;
      }
      pollTimer = setTimeout(() => {
        pollTimer = null;
        fetchScreen().catch(() => {
          badgeDisconnected('Disconnected');
        }).finally(() => {
          scheduleNextPoll();
        });
      }, delay);
    }

    async function fetchScreen(options = {}) {
      if (!running) {
        return;
      }

      if (fetchInFlight && !options.force) {
        return fetchInFlight;
      }

      const task = (async () => {
        const requestId = ++screenRequestId;
        const response = await fetch(buildUrl('/api/screen'));
        if (requestId < appliedScreenRequestId) {
          return;
        }

        if (!response.ok) {
          appliedScreenRequestId = requestId;
          badgeDisconnected('Disconnected');
          screen.textContent = await response.text();
          return;
        }

        const data = await response.json();
        if (requestId < appliedScreenRequestId) {
          return;
        }

        appliedScreenRequestId = requestId;
        const remote = data.remote;
        const shouldFollow = forceFollowScreen || !screenHydrated || followScreen;
        const previousScrollTop = screen.scrollTop;
        metaLine.textContent = remote.workingDirectory + ' · ' + remote.targetRef;
        metaSecondary.textContent = 'tmux session ' + remote.sessionName + ' · ' + (remote.lastSeenAt || 'No mobile activity yet');
        currentContinueCommand = remote.continueCommand || '';
        syncContinueCommand();
        screen.textContent = data.screen || '';
        screenHydrated = true;
        forceFollowScreen = false;

        if (shouldFollow) {
          scrollScreenToBottom();
        } else {
          const maxScrollTop = Math.max(screen.scrollHeight - screen.clientHeight, 0);
          screen.scrollTop = Math.min(previousScrollTop, maxScrollTop);
          followScreen = isNearBottom();
        }

        if (data.revoked) {
          running = false;
          badgeDisconnected('Revoked');
        } else {
          badge.textContent = 'Connected';
          badge.style.borderColor = 'rgba(56, 189, 248, 0.3)';
          badge.style.background = 'rgba(8, 47, 73, 0.45)';
          badge.style.color = '#bae6fd';
        }
      })();

      fetchInFlight = task;

      try {
        return await task;
      } finally {
        if (fetchInFlight === task) {
          fetchInFlight = null;
        }
      }
    }

    async function post(path, body) {
      const response = await fetch(buildUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(await response.text());
      }
    }

    async function runRemoteAction(statusLabel, callback) {
      pendingAction = true;
      syncControls();
      setStatus(statusLabel, 'accent', true);
      scheduleBurst();

      try {
        await callback();
        forceFollowScreen = true;
        await fetchScreen({ force: true });
        setStatus('Sent.', 'success');
      } catch (error) {
        setStatus(error instanceof Error ? error.message : String(error), 'error', true);
      } finally {
        pendingAction = false;
        syncControls();
        input.focus();
        scheduleBurst(1500);
      }
    }

    async function send(text, enter = true) {
      await runRemoteAction(enter ? 'Sending…' : 'Typing…', async () => {
        await post('/api/send', { text, enter });
      });
    }

    async function control(action) {
      await runRemoteAction('Sending key…', async () => {
        await post('/api/control', { action });
      });
    }

    async function endSession() {
      if (!window.confirm('End this remote session from mobile?')) {
        return;
      }

      pendingAction = true;
      syncControls();
      setStatus('Ending session…', 'accent', true);

      try {
        await post('/api/control', { action: 'end_session' });
        running = false;
        badgeDisconnected('Ended');
        metaSecondary.textContent = 'Remote access closed from mobile';
        screen.textContent += '\\n\\n[Remote session ended from mobile]\\n';
        setStatus('Session ended.', 'success', true);
      } catch (error) {
        pendingAction = false;
        syncControls();
        setStatus(error instanceof Error ? error.message : String(error), 'error', true);
        return;
      }

      input.blur();
      input.disabled = true;
      pendingAction = true;
      syncControls();
      endButton.textContent = 'Ended';
    }

    screen.addEventListener('scroll', () => {
      followScreen = isNearBottom();
    });

    toggleActionsButton.addEventListener('click', () => {
      actionsExpanded = !actionsExpanded;
      syncActionVisibility();
    });

    continueTerminalButton.addEventListener('click', () => {
      continueCommandVisible = !continueCommandVisible;
      syncContinueCommand();
    });

    copyContinueButton.addEventListener('click', async () => {
      if (!currentContinueCommand) {
        return;
      }

      try {
        await navigator.clipboard.writeText(currentContinueCommand);
        flashCopiedButton(copyContinueButton);
        flashContinueCommandBox();
        setStatus('Continue command copied.', 'success');
      } catch {
        setStatus('Could not copy command.', 'error');
      }
    });

    document.getElementById('composer').addEventListener('submit', async (event) => {
      event.preventDefault();
      const value = input.value.trim();
      if (!value) {
        return;
      }
      clearComposer();
      await send(value, true);
      clearComposer();
    });

    escButton.addEventListener('click', async () => {
      await control('escape');
    });

    tabButton.addEventListener('click', async () => {
      await control('tab');
    });

    enterButton.addEventListener('click', async () => {
      await control('enter');
    });

    ctrlCButton.addEventListener('click', async () => {
      await control('ctrl_c');
    });

    endButton.addEventListener('click', async () => {
      await endSession();
    });

    function initializeVoiceInput() {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        syncControls();
        return;
      }

      recognitionSupported = true;
      recognition = new SpeechRecognition();
      recognition.lang = navigator.language || 'en-US';
      recognition.interimResults = true;
      recognition.continuous = false;
      recognition.maxAlternatives = 1;

      recognition.addEventListener('start', () => {
        listening = true;
        syncControls();
        setStatus('Listening… speak now.', 'accent', true);
      });

      recognition.addEventListener('result', (event) => {
        const transcript = Array.from(event.results)
          .map((result) => result[0] ? result[0].transcript : '')
          .join(' ')
          .replace(/\\s+/g, ' ')
          .trim();

        input.value = transcript;
        if (transcript) {
          setStatus('Voice ready. Tap Send to submit.', 'accent');
        }
      });

      recognition.addEventListener('error', (event) => {
        listening = false;
        syncControls();

        const message =
          event.error === 'not-allowed'
            ? 'Microphone permission blocked.'
            : event.error === 'no-speech'
              ? 'No speech detected.'
              : 'Voice input unavailable right now.';

        setStatus(message, 'error');
      });

      recognition.addEventListener('end', () => {
        listening = false;
        syncControls();

        if (input.value.trim()) {
          setStatus('Voice ready. Tap Send to submit.', 'accent');
        } else {
          setStatus('', '');
        }
      });

      voiceButton.addEventListener('click', () => {
        if (!recognition) {
          return;
        }

        if (listening) {
          recognition.stop();
          return;
        }

        input.focus();
        recognition.start();
      });

      syncControls();
    }

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        scheduleBurst(2000);
        fetchScreen({ force: true }).catch(() => {});
      }
    });

    window.addEventListener('focus', () => {
      scheduleBurst(2000);
      fetchScreen({ force: true }).catch(() => {});
    });

    syncActionVisibility();
    syncContinueCommand();
    initializeVoiceInput();

    fetchScreen().catch(() => {
      badgeDisconnected('Disconnected');
    }).finally(() => {
      scheduleNextPoll();
    });
  </script>
</body>
</html>`;
}
