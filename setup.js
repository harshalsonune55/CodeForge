#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function main() {
  const envPath = path.resolve(process.env.HOME || process.cwd(), ".codeforge.env");

  console.log("CodeForge global setup");
  console.log(`Config file: ${envPath}\n`);

  const provider = (await ask("Provider [groq]: ")) || "groq";
  let lines = [`LLM_PROVIDER=${provider}`];

  if (provider === "groq") {
    const apiKey = await ask("Groq API key: ");
    const model = (await ask("Groq model [llama-3.3-70b-versatile]: ")) || "llama-3.3-70b-versatile";

    lines.push(`GROQ_API_KEY=${apiKey}`);
    lines.push(`GROQ_MODEL=${model}`);
  } else if (provider === "ollama") {
    const baseUrl = (await ask("Ollama base URL [http://localhost:11434]: ")) || "http://localhost:11434";
    const model = (await ask("Ollama model [qwen2.5-coder:1.5b]: ")) || "qwen2.5-coder:1.5b";

    lines.push(`OLLAMA_BASE_URL=${baseUrl}`);
    lines.push(`OLLAMA_MODEL=${model}`);
  } else {
    console.error(`Unsupported provider: ${provider}`);
    rl.close();
    process.exit(1);
  }

  lines.push("CODEFORGE_REQUIRE_WRITE_APPROVAL=true");
  fs.writeFileSync(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });

  console.log("\nSaved global config.");
  console.log("You can now run: codeforge");
  rl.close();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  rl.close();
  process.exit(1);
});
