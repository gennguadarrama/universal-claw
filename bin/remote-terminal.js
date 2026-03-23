#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const serverPath = path.join(packageRoot, "server.mjs");
const appDir = path.join(os.homedir(), ".remote-terminal");
const configPath = path.join(appDir, "config.json");
const logDir = path.join(appDir, "logs");
const ngrokConfigCandidates = [
  path.join(os.homedir(), ".config", "ngrok", "ngrok.yml"),
  path.join(os.homedir(), "Library", "Application Support", "ngrok", "ngrok.yml"),
  path.join(os.homedir(), ".ngrok2", "ngrok.yml"),
];

function usage() {
  console.log(`Usage:
  remote-terminal
  remote-terminal here
  remote-terminal share
  remote-terminal --detached
  remote-terminal --attach <tmux-target>
  remote-terminal --cwd <dir>
  remote-terminal --no-open
  remote-terminal doctor
  remote-terminal auth <ngrok-token>
  remote-terminal auth --status
  remote-terminal auth --clear
  remote-terminal --help

Behavior:
  - Inside tmux, it shares the current pane by default.
  - \`remote-terminal here\` and \`remote-terminal share\` explicitly share the current tmux pane.
  - Outside tmux, it creates a detached remote session in the current directory.
  - --attach targets a specific tmux pane/session manually.
  - --detached forces a new detached session even if you are inside tmux.
  - doctor validates external dependencies and ngrok auth setup.
  - auth stores the ngrok authtoken locally so users do not need to export it every time.
`);
}

function ensureAppDir() {
  fs.mkdirSync(appDir, { recursive: true });
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(config) {
  ensureAppDir();
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(configPath, 0o600);
}

function commandExists(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${JSON.stringify(command)}`], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function getStoredAuthToken() {
  const config = readConfig();
  return typeof config.ngrokAuthtoken === "string" ? config.ngrokAuthtoken.trim() : "";
}

function getNgrokConfigAuthToken() {
  for (const candidate of ngrokConfigCandidates) {
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const match = raw.match(/^\s*authtoken:\s*["']?([^\s"']+)["']?\s*$/m);
      if (match?.[1]) {
        return match[1].trim();
      }
    } catch {
      // Ignore missing config files.
    }
  }

  return "";
}

function resolveAuthToken() {
  return (
    process.env.NGROK_AUTHTOKEN ||
    process.env.REMOTE_TERMINAL_NGROK_AUTHTOKEN ||
    getStoredAuthToken() ||
    getNgrokConfigAuthToken()
  );
}

function doctor() {
  const token = resolveAuthToken();
  const checks = [
    {
      name: "tmux",
      ok: commandExists("tmux"),
      install: "Install tmux with brew install tmux or your Linux package manager.",
    },
    {
      name: "ngrok authtoken",
      ok: Boolean(token),
      install: "Run `remote-terminal auth <token>` once, or set NGROK_AUTHTOKEN.",
    },
  ];

  console.log("remote-terminal doctor");
  console.log("");

  let failed = false;
  for (const check of checks) {
    const prefix = check.ok ? "OK" : "MISSING";
    console.log(`${prefix.padEnd(8)} ${check.name}`);
    if (!check.ok) {
      console.log(`         ${check.install}`);
      failed = true;
    }
  }

  console.log("");
  if (failed) {
    process.exitCode = 1;
    return;
  }

  console.log("Environment looks ready.");
}

function handleAuthCommand(argv) {
  if (argv[0] !== "auth") {
    return false;
  }

  if (argv[1] === "--status") {
    const token = getStoredAuthToken();
    if (!token) {
      console.log("No stored ngrok authtoken.");
      return true;
    }
    console.log(`Stored ngrok authtoken: ${token.slice(0, 6)}...${token.slice(-4)}`);
    return true;
  }

  if (argv[1] === "--clear") {
    const config = readConfig();
    delete config.ngrokAuthtoken;
    writeConfig(config);
    console.log("Stored ngrok authtoken removed.");
    return true;
  }

  const token = argv[1];
  if (!token) {
    console.error("Missing ngrok authtoken.");
    console.error("Usage: remote-terminal auth <token>");
    process.exit(1);
  }

  const config = readConfig();
  config.ngrokAuthtoken = token.trim();
  writeConfig(config);
  console.log("Stored ngrok authtoken.");
  return true;
}

function parseArgs(argv) {
  const options = {
    attachTarget: "",
    cwd: process.cwd(),
    forceDetached: false,
    noOpen: false,
    doctorOnly: false,
    shareCurrent: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--attach") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --attach");
      }
      options.attachTarget = value;
      index += 1;
      continue;
    }

    if (arg === "--cwd") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --cwd");
      }
      options.cwd = path.resolve(value);
      index += 1;
      continue;
    }

    if (arg === "--detached") {
      options.forceDetached = true;
      continue;
    }

    if (arg === "here" || arg === "share") {
      options.shareCurrent = true;
      continue;
    }

    if (arg === "--no-open") {
      options.noOpen = true;
      continue;
    }

    if (arg === "doctor") {
      options.doctorOnly = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function chooseMode(options) {
  if (options.shareCurrent) {
    if (!process.env.TMUX_PANE) {
      throw new Error("`remote-terminal here` requires running inside tmux.");
    }

    return {
      mode: `current:${process.env.TMUX_PANE}`,
      remoteTarget: process.env.TMUX_PANE,
    };
  }

  if (options.attachTarget) {
    return {
      mode: `attached:${options.attachTarget}`,
      remoteTarget: options.attachTarget,
    };
  }

  if (!options.forceDetached && process.env.TMUX_PANE) {
    return {
      mode: `attached:${process.env.TMUX_PANE}`,
      remoteTarget: process.env.TMUX_PANE,
    };
  }

  return {
    mode: "detached",
    remoteTarget: "",
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const argv = process.argv.slice(2);

  if (handleAuthCommand(argv)) {
    return;
  }

  let options;
  try {
    options = parseArgs(argv);
    if (options.shareCurrent && options.forceDetached) {
      throw new Error("`here` cannot be combined with --detached.");
    }
    if (options.shareCurrent && options.attachTarget) {
      throw new Error("`here` cannot be combined with --attach.");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("");
    usage();
    process.exit(1);
  }

  if (options.doctorOnly) {
    doctor();
    return;
  }

  if (!fs.existsSync(serverPath)) {
    console.error(`server.mjs not found at ${serverPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(options.cwd) || !fs.statSync(options.cwd).isDirectory()) {
    console.error(`Working directory does not exist: ${options.cwd}`);
    process.exit(1);
  }

  if (!commandExists("tmux")) {
    console.error("Missing required system dependency: tmux");
    console.error("Run `remote-terminal doctor` for setup guidance.");
    process.exit(1);
  }

  const authToken = resolveAuthToken();
  if (!authToken) {
    console.error("Missing ngrok authtoken.");
    console.error("Run `remote-terminal auth <token>` once, or set NGROK_AUTHTOKEN.");
    process.exit(1);
  }

  fs.mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const logPath = path.join(logDir, `remote-terminal-${timestamp}.log`);
  const logFd = fs.openSync(logPath, "a");
  const { mode, remoteTarget } = chooseMode(options);
  const childEnv = {
    ...process.env,
    NGROK_AUTHTOKEN: authToken,
  };

  if (remoteTarget) {
    childEnv.REMOTE_TMUX_TARGET = remoteTarget;
  }

  if (options.noOpen) {
    childEnv.REMOTE_TERMINAL_NO_OPEN = "1";
  }

  const child = spawn(process.execPath, [serverPath, options.cwd], {
    cwd: packageRoot,
    env: childEnv,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();
  fs.closeSync(logFd);

  console.log("Starting remote terminal...");
  console.log(`pid: ${child.pid ?? "unknown"}`);
  console.log(`mode: ${mode}`);
  if (options.shareCurrent && process.env.TMUX_PANE) {
    console.log(`sharing current tmux pane: ${process.env.TMUX_PANE}`);
  }
  console.log(`cwd: ${options.cwd}`);
  console.log(`log: ${logPath}`);

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, "utf8");
      if (content.includes("host dashboard:") || content.includes("warning:")) {
        const lines = content.split("\n");
        for (const prefix of ["host dashboard:", "remote:", "url:", "warning:"]) {
          const line = lines.find((entry) => entry.startsWith(prefix));
          if (line) {
            console.log(line);
          }
        }
        return;
      }
    }

    await wait(250);
  }

  console.log("Still starting. Check the log if the dashboard does not appear.");
}

await main();
