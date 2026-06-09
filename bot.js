#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");

loadDotEnv();

const LLM_PROVIDER = (process.env.LLM_PROVIDER || (process.env.GROQ_API_KEY ? "groq" : "ollama")).toLowerCase();
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const GROQ_BASE_URL = process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1";
const REQUESTED_MODEL =
  process.env.LLM_MODEL ||
  process.env.GROQ_MODEL ||
  process.env.OLLAMA_MODEL ||
  (LLM_PROVIDER === "groq" ? "llama-3.3-70b-versatile" : "qwen2.5-coder:1.5b");
const MODEL = resolveModel(LLM_PROVIDER, REQUESTED_MODEL);
const MAX_STEPS = Number(process.env.CODEFORGE_MAX_STEPS || process.env.CODEBOT_MAX_STEPS || 60);
const COMMAND_TIMEOUT_MS = Number(process.env.CODEFORGE_COMMAND_TIMEOUT_MS || process.env.CODEBOT_COMMAND_TIMEOUT_MS || 120000);
const MAX_FILE_BYTES = Number(process.env.CODEFORGE_MAX_FILE_BYTES || process.env.CODEBOT_MAX_FILE_BYTES || 200000);
const MAX_TOOL_RESULT_CHARS = Number(process.env.CODEFORGE_MAX_TOOL_RESULT_CHARS || process.env.CODEBOT_MAX_TOOL_RESULT_CHARS || 12000);
const REQUIRE_WRITE_APPROVAL = (process.env.CODEFORGE_REQUIRE_WRITE_APPROVAL || process.env.CODEBOT_REQUIRE_WRITE_APPROVAL) !== "false";
const MAX_REPEAT_RESPONSES = Number(process.env.CODEFORGE_MAX_REPEAT_RESPONSES || process.env.CODEBOT_MAX_REPEAT_RESPONSES || 2);

const colors = {
  cyan: "\x1b[36m",
  lightGreen: "\x1b[92m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  yellow: "\x1b[33m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  reset: "\x1b[0m"
};

const SYSTEM_PROMPT = `
You are a terminal coding assistant.

You can use exactly one tool per response.

Available tools:

LIST_FILES

LIST_DIR path

SEARCH_FILES query

READ_FILE path

WRITE_FILE path
\`\`\`
content
\`\`\`

RUN_COMMAND command

FINAL answer

Rules:
- Output plain text tool calls only. Do not wrap tool calls in markdown fences.
- Only use markdown code fences for WRITE_FILE content.
- First understand the workspace using the provided file map, LIST_FILES, LIST_DIR, SEARCH_FILES, and READ_FILE.
- Use READ_FILE before editing existing files.
- Use WRITE_FILE to create or replace files.
- For edits, write the complete new contents of the target file.
- Use RUN_COMMAND to inspect folders, run tests, run scripts, and install packages when needed.
- Prefer safe commands such as ls, pwd, find, rg, npm test, node file.js.
- Do not run destructive commands like rm -rf, git reset, reboot, shutdown, mkfs, dd, chmod -R 777, or fork bombs.
- After making changes, run a relevant verification command if one is available.
- Never repeat the same tool call after receiving its result. If a tool result is enough, use FINAL. If it is not enough, choose a different tool.
- If a file already exists in the workspace map, READ_FILE before deciding whether to update it.
- When the task is finished, respond with FINAL.
- Do not explain tool calls. Output only the tool call.
`.trim();

const CODEFORGE_LOGO = String.raw`
  ██████╗  ██████╗  ██████╗  ███████╗
 ██╔════╝ ██╔═══██╗ ██╔══██╗ ██╔════╝
 ██║      ██║   ██║ ██║  ██║ █████╗
 ██║      ██║   ██║ ██║  ██║ ██╔══╝
 ╚██████╗ ╚██████╔╝ ██████╔╝ ███████╗
  ╚═════╝  ╚═════╝  ╚═════╝  ╚══════╝

 ███████╗  ██████╗  ██████╗   ██████╗  ███████╗
 ██╔════╝ ██╔═══██╗ ██╔══██╗ ██╔════╝  ██╔════╝
 █████╗   ██║   ██║ ██████╔╝ ██║  ███╗ █████╗
 ██╔══╝   ██║   ██║ ██╔══██╗ ██║   ██║ ██╔══╝
 ██║      ╚██████╔╝ ██║  ██║ ╚██████╔╝ ███████╗
 ╚═╝       ╚═════╝  ╚═╝  ╚═╝  ╚═════╝  ╚══════╝
`.replace(/^\n/, "").trimEnd();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function resolveModel(provider, requestedModel) {
  const deprecatedGroqModels = new Map([
    ["qwen-2.5-coder-32b", process.env.GROQ_REPLACEMENT_MODEL || "llama-3.3-70b-versatile"],
    ["openai/gpt-oss-120b", process.env.GROQ_REPLACEMENT_MODEL || "llama-3.3-70b-versatile"]
  ]);

  if (provider === "groq" && deprecatedGroqModels.has(requestedModel)) {
    return deprecatedGroqModels.get(requestedModel);
  }

  return requestedModel;
}

function loadDotEnv() {
  const envPaths = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.env.HOME || process.cwd(), ".codeforge.env"),
    path.resolve(process.env.HOME || process.cwd(), ".codebot.env")
  ];

  for (const envPath of envPaths) {
    loadDotEnvFile(envPath);
  }
}

function loadDotEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function color(name, text) {
  return `${colors[name] || ""}${text}${colors.reset}`;
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

function terminalWidth() {
  return Math.max(process.stdout.columns || 88, 60);
}

function truncateLine(line, width) {
  const cleanLength = stripAnsi(line).length;
  if (cleanLength <= width) {
    return line;
  }

  return `${line.slice(0, Math.max(width - 1, 0))}…`;
}

function panel(title, body, options = {}) {
  const width = terminalWidth();
  const borderColor = options.color || "blue";
  const maxBodyWidth = width - 4;
  const titleText = title ? ` ${title} ` : "";
  const topFill = Math.max(width - titleText.length - 2, 0);
  const top = `${color(borderColor, "┌")}${color("bold", titleText)}${color(borderColor, "─".repeat(topFill))}${color(borderColor, "┐")}`;
  const bottom = `${color(borderColor, "└")}${color(borderColor, "─".repeat(width - 2))}${color(borderColor, "┘")}`;
  const lines = String(body || "")
    .split(/\r?\n/)
    .flatMap((line) => {
      if (line.length === 0) {
        return [""];
      }

      const chunks = [];
      let remaining = line;
      while (stripAnsi(remaining).length > maxBodyWidth) {
        chunks.push(truncateLine(remaining, maxBodyWidth));
        remaining = remaining.slice(maxBodyWidth);
      }
      chunks.push(remaining);
      return chunks;
    });

  console.log(top);
  for (const line of lines) {
    const display = truncateLine(line, maxBodyWidth);
    const padding = Math.max(maxBodyWidth - stripAnsi(display).length, 0);
    console.log(`${color(borderColor, "│")} ${display}${" ".repeat(padding)} ${color(borderColor, "│")}`);
  }
  console.log(bottom);
}

function table(rows) {
  const keyWidth = Math.min(
    Math.max(...rows.map(([key]) => stripAnsi(key).length), 4),
    24
  );

  return rows
    .map(([key, value]) => `${color("dim", key.padEnd(keyWidth))}  ${value}`)
    .join("\n");
}

function stepHeader(step) {
  const label = ` Step ${step} `;
  const width = terminalWidth();
  const fill = Math.max(width - label.length, 0);
  console.log(`\n${color("blue", color("bold", label))}${color("blue", "─".repeat(fill))}`);
}

function status(label, message, statusColor = "cyan") {
  console.log(`${color(statusColor, color("bold", label))} ${message}`);
}

function tick(message, statusColor = "green") {
  console.log(`${color(statusColor, "✓")} ${message}`);
}

function warnTick(message) {
  console.log(`${color("yellow", "!")} ${message}`);
}

function commandLineShell() {
  return process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
}

function commandLineArgs(command) {
  if (process.platform === "win32") {
    return ["/d", "/s", "/c", command];
  }

  return ["-lc", command];
}

function summarizeAction(output, result) {
  if (output === "LIST_FILES") {
    return "scanned workspace";
  }

  if (output.startsWith("LIST_DIR ")) {
    return `scanned ${output.replace("LIST_DIR ", "").trim() || "."}`;
  }

  if (output.startsWith("SEARCH_FILES ")) {
    return `searched "${output.replace("SEARCH_FILES ", "").trim()}"`;
  }

  if (output.startsWith("READ_FILE ")) {
    return `read ${output.replace("READ_FILE ", "").trim()}`;
  }

  if (output.startsWith("WRITE_FILE ")) {
    const filePath = output.split("\n")[0].replace("WRITE_FILE ", "").trim();
    return result.startsWith("User rejected") ? `skipped ${filePath}` : `updated ${filePath}`;
  }

  if (output.startsWith("RUN_COMMAND ")) {
    const command = output.replace("RUN_COMMAND ", "").trim();
    return result.startsWith("User rejected") ? `skipped command: ${command}` : `ran command: ${command}`;
  }

  if (result.startsWith("ERROR: Invalid response format")) {
    return "corrected model response";
  }

  return "continued";
}

function isInternalError(result) {
  return (
    result.startsWith("ERROR: Invalid response format") ||
    result.startsWith("ERROR: WRITE_FILE requires")
  );
}

function renderLogo() {
  const lines = CODEFORGE_LOGO.split("\n");
  console.log("");

  lines.forEach((line) => {
    if (!line) {
      console.log("");
      return;
    }

    console.log(color("lightGreen", line));
  });

  console.log(color("dim", "codeforge terminal coding agent"));
  console.log("");
}

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer));
  });
}

async function callLLM(messages) {
  if (LLM_PROVIDER === "groq") {
    return await callGroq(messages);
  }

  if (LLM_PROVIDER === "ollama") {
    return await callOllama(messages);
  }

  throw new Error(`Unsupported LLM_PROVIDER: ${LLM_PROVIDER}`);
}

async function callGroq(messages) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY is required when LLM_PROVIDER=groq.");
  }

  const response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      temperature: 0.2
    }),
    signal: AbortSignal.timeout(300000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Groq request failed: HTTP ${response.status}\n${body}`);
  }

  const data = await response.json();
  return String(data.choices?.[0]?.message?.content || "").trim();
}

async function callOllama(messages) {
  const response = await fetch(`${OLLAMA_BASE_URL}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      stream: false,
      options: {
        temperature: 0.2
      }
    }),
    signal: AbortSignal.timeout(300000)
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Ollama request failed: HTTP ${response.status}\n${body}`);
  }

  const data = await response.json();
  return String(data.message?.content || "").trim();
}

function resolveWorkspacePath(filePath) {
  const resolved = path.resolve(process.cwd(), filePath);
  const cwd = process.cwd();

  if (resolved !== cwd && !resolved.startsWith(cwd + path.sep)) {
    throw new Error(`Path is outside current workspace: ${filePath}`);
  }

  return resolved;
}

function readFile(filePath) {
  const resolved = resolveWorkspacePath(filePath);

  if (!fs.existsSync(resolved)) {
    return `ERROR: File does not exist: ${filePath}`;
  }

  if (!fs.statSync(resolved).isFile()) {
    return `ERROR: Path is not a file: ${filePath}`;
  }

  const stat = fs.statSync(resolved);
  if (stat.size > MAX_FILE_BYTES) {
    return `ERROR: File is too large to read (${stat.size} bytes): ${filePath}`;
  }

  return fs.readFileSync(resolved, "utf8");
}

function shouldIgnorePath(relativePath) {
  if (relativePath === ".") {
    return false;
  }

  const parts = relativePath.split(path.sep);
  const ignoredDirs = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    ".cache",
    ".turbo",
    "tmp"
  ]);

  if (parts.some((part) => ignoredDirs.has(part))) {
    return true;
  }

  const fileName = parts[parts.length - 1] || "";
  return (
    fileName === ".DS_Store" ||
    fileName.endsWith(".log") ||
    fileName.endsWith(".png") ||
    fileName.endsWith(".jpg") ||
    fileName.endsWith(".jpeg") ||
    fileName.endsWith(".gif") ||
    fileName.endsWith(".pdf") ||
    fileName.endsWith(".zip") ||
    fileName.endsWith(".tar") ||
    fileName.endsWith(".gz")
  );
}

function walkFiles(startDir, options = {}) {
  const root = process.cwd();
  const maxFiles = options.maxFiles || 300;
  const results = [];

  function walk(currentDir) {
    if (results.length >= maxFiles) {
      return;
    }

    const entries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= maxFiles) {
        return;
      }

      const absolute = path.join(currentDir, entry.name);
      const relative = path.relative(root, absolute) || ".";

      if (shouldIgnorePath(relative)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const size = fs.statSync(absolute).size;
        results.push(`${relative} (${size} bytes)`);
      }
    }
  }

  walk(startDir);
  return results;
}

function listFiles() {
  const files = walkFiles(process.cwd(), { maxFiles: 500 });
  return files.length ? files.join("\n") : "No files found.";
}

function listDir(dirPath) {
  const resolved = resolveWorkspacePath(dirPath || ".");

  if (!fs.existsSync(resolved)) {
    return `ERROR: Directory does not exist: ${dirPath}`;
  }

  if (!fs.statSync(resolved).isDirectory()) {
    return `ERROR: Path is not a directory: ${dirPath}`;
  }

  const entries = fs
    .readdirSync(resolved, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((entry) => {
      const relative = path.relative(process.cwd(), path.join(resolved, entry.name));
      return !shouldIgnorePath(relative);
    })
    .map((entry) => {
      const suffix = entry.isDirectory() ? "/" : "";
      const relative = path.relative(process.cwd(), path.join(resolved, entry.name));
      const size = entry.isFile() ? ` (${fs.statSync(path.join(resolved, entry.name)).size} bytes)` : "";
      return `${relative}${suffix}${size}`;
    });

  return entries.length ? entries.join("\n") : "Directory is empty.";
}

function searchFiles(query) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return "ERROR: SEARCH_FILES requires a query.";
  }

  const root = process.cwd();
  const files = walkFiles(root, { maxFiles: 500 }).map((line) => line.replace(/ \(\d+ bytes\)$/, ""));
  const matches = [];

  for (const filePath of files) {
    if (matches.length >= 100) {
      break;
    }

    const absolute = path.join(root, filePath);
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_FILE_BYTES) {
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(absolute, "utf8");
    } catch (error) {
      continue;
    }
    const lines = content.split(/\r?\n/);

    lines.forEach((line, index) => {
      if (matches.length >= 100) {
        return;
      }

      if (line.toLowerCase().includes(needle)) {
        matches.push(`${filePath}:${index + 1}: ${line.slice(0, 220)}`);
      }
    });
  }

  return matches.length ? matches.join("\n") : `No matches for: ${query}`;
}

function extractCodeBlock(text) {
  const match = text.match(/```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)```/);
  return match ? match[1] : "";
}

function normalizeToolOutput(output) {
  const trimmed = output.trim();
  const toolNames = [
    "LIST_FILES",
    "LIST_DIR",
    "SEARCH_FILES",
    "READ_FILE",
    "WRITE_FILE",
    "RUN_COMMAND",
    "FINAL"
  ];

  for (const toolName of toolNames) {
    const index = trimmed.indexOf(toolName);
    if (index !== -1) {
      return trimmed.slice(index).trim();
    }
  }

  return trimmed;
}

function finalText(output) {
  const content = output.replace("FINAL", "").trim();
  if (content.toLowerCase().startsWith("answer")) {
    return content.slice("answer".length).trim() || "Done.";
  }

  return content || "Done.";
}

function buildWritePreview(filePath, content) {
  const resolved = resolveWorkspacePath(filePath);
  const exists = fs.existsSync(resolved);
  const previousSize = exists && fs.statSync(resolved).isFile() ? fs.statSync(resolved).size : 0;
  const lines = content.split(/\r?\n/);
  const preview = lines.slice(0, 40).join("\n");
  const remainingLines = Math.max(lines.length - 40, 0);

  return {
    exists,
    previousSize,
    nextSize: Buffer.byteLength(content, "utf8"),
    preview,
    remainingLines
  };
}

async function writeFile(filePath, content) {
  const resolved = resolveWorkspacePath(filePath);
  const dir = path.dirname(resolved);

  if (REQUIRE_WRITE_APPROVAL) {
    const preview = buildWritePreview(filePath, content);
    const action = preview.exists ? "Update" : "Create";

    panel(
      `${action} File`,
      `${table([
        ["Path", filePath],
        ["Current", `${preview.previousSize} bytes`],
        ["New", `${preview.nextSize} bytes`]
      ])}

${color("bold", "Preview")}
${preview.preview || "(empty file)"}`,
      { color: "yellow" }
    );

    if (preview.remainingLines > 0) {
      status("Preview", `${preview.remainingLines} more lines hidden`, "yellow");
    }

    const answer = await ask(color("yellow", `Approve ${action.toLowerCase()}? [y/N] `));
    if (answer.trim().toLowerCase() !== "y") {
      return `User rejected ${action.toLowerCase()} for file: ${filePath}`;
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolved, content, "utf8");

  return `Wrote file: ${filePath}`;
}

function isUnsafeCommand(command) {
  const normalized = command.toLowerCase();
  const blocked = [
    "rm -rf",
    "git reset",
    "git checkout --",
    "shutdown",
    "reboot",
    "mkfs",
    "dd ",
    ":(){",
    "chmod -r 777",
    "chown -r"
  ];

  return blocked.some((item) => normalized.includes(item));
}

async function runCommand(command) {
  if (isUnsafeCommand(command)) {
    return `BLOCKED unsafe command: ${command}`;
  }

  panel("Command Approval", command, { color: "yellow" });
  const answer = await ask(color("yellow", "Run this command? [y/N] "));
  if (answer.trim().toLowerCase() !== "y") {
    return "User rejected command.";
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const shell = commandLineShell();
    const child = spawn(shell, commandLineArgs(command), {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["inherit", "pipe", "pipe"]
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, COMMAND_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve(`STDOUT:
${stdout}

STDERR:
${stderr}${error.message}

EXIT_CODE:
1`);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve(`STDOUT:
${stdout.slice(-6000)}

STDERR:
${stderr.slice(-6000)}

EXIT_CODE:
${signal ? `signal ${signal}` : code || 0}`);
    });
  });
}

async function handleResponse(output) {
  if (output === "LIST_FILES") {
    return listFiles();
  }

  if (output.startsWith("LIST_DIR ")) {
    const dirPath = output.replace("LIST_DIR ", "").trim();
    return listDir(dirPath);
  }

  if (output.startsWith("SEARCH_FILES ")) {
    const query = output.replace("SEARCH_FILES ", "").trim();
    return searchFiles(query);
  }

  if (output.startsWith("READ_FILE ")) {
    const filePath = output.replace("READ_FILE ", "").trim();
    return readFile(filePath);
  }

  if (output.startsWith("WRITE_FILE ")) {
    const firstLine = output.split("\n")[0];
    const filePath = firstLine.replace("WRITE_FILE ", "").trim();
    const content = extractCodeBlock(output);

    if (!content) {
      return "ERROR: WRITE_FILE requires a markdown code block.";
    }

    return await writeFile(filePath, content);
  }

  if (output.startsWith("RUN_COMMAND ")) {
    const command = output.replace("RUN_COMMAND ", "").trim();
    return await runCommand(command);
  }

  if (output.startsWith("FINAL ")) {
    panel("Done", finalText(output), { color: "green" });
    return null;
  }

  return `ERROR: Invalid response format.

You must output exactly one valid tool call and no extra explanation.

Use one of:
LIST_FILES
LIST_DIR path
SEARCH_FILES query
READ_FILE path
WRITE_FILE path
\`\`\`
content
\`\`\`
RUN_COMMAND command
FINAL answer`;
}

function buildMessages(task) {
  return [
    {
      role: "system",
      content: SYSTEM_PROMPT
    },
    {
      role: "user",
      content: `Task:
${task}

Initial workspace file map:
${listFiles()}`
    }
  ];
}

async function runTask(task) {
  const messages = buildMessages(task);
  let lastOutput = "";
  let repeatCount = 0;

  for (let step = 1; step <= MAX_STEPS; step++) {
    let output;
    try {
      output = normalizeToolOutput(await callLLM(messages));
    } catch (error) {
      panel("LLM Request Failed", error.message, { color: "red" });
      return;
    }

    if (output === lastOutput) {
      repeatCount += 1;
    } else {
      repeatCount = 0;
      lastOutput = output;
    }

    if (repeatCount >= MAX_REPEAT_RESPONSES) {
      const correction = `ERROR: You repeated the same response ${repeatCount + 1} times: ${output}

Do not repeat this tool call again. Use a different tool based on the result you already received, or use FINAL if the task is complete.`;

      warnTick("corrected repeated model response");

      messages.push({
        role: "assistant",
        content: output
      });

      messages.push({
        role: "user",
        content: correction
      });

      continue;
    }

    let result;
    try {
      result = await handleResponse(output);
    } catch (error) {
      result = `ERROR: ${error.message}`;
    }

    if (result === null) {
      return;
    }

    if (result.startsWith("ERROR:") && !isInternalError(result)) {
      panel("Tool Error", result.slice(0, 4000), { color: "red" });
    } else {
      const message = summarizeAction(output, result);
      if (result.startsWith("User rejected") || isInternalError(result)) {
        warnTick(message);
      } else {
        tick(message);
      }
    }

    messages.push({
      role: "assistant",
      content: output
    });

    messages.push({
      role: "user",
      content: result.slice(0, MAX_TOOL_RESULT_CHARS)
    });
  }

  panel("Stopped", `Stopped after ${MAX_STEPS} steps.`, { color: "red" });
}

async function main() {
  renderLogo();

  const startupRows = [
    ["Provider", LLM_PROVIDER],
    ["Model", MODEL],
    ["Endpoint", LLM_PROVIDER === "groq" ? GROQ_BASE_URL : OLLAMA_BASE_URL],
    ["Workspace", process.cwd()]
  ];

  if (REQUESTED_MODEL !== MODEL) {
    startupRows.splice(2, 0, ["Requested", `${REQUESTED_MODEL} -> ${MODEL}`]);
  }

  panel("CodeForge", table(startupRows), { color: "cyan" });
  console.log("");

  while (true) {
    const task = (await ask("Task: ")).trim();

    if (!task) {
      continue;
    }

    if (["exit", "quit", "/exit", "/quit"].includes(task.toLowerCase())) {
      rl.close();
      return;
    }

    await runTask(task);
    console.log(color("dim", "\nType another task, or type exit to quit.\n"));
  }
}

main().catch((error) => {
  panel("Fatal Error", error.stack || error.message, { color: "red" });
  rl.close();
  process.exit(1);
});
