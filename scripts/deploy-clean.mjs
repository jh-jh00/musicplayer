
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const wrangler = process.env.PLAYER_WRANGLER || join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const scratchPrefix = join(tmpdir(), "playlist-player-build-");
const stage = mkdtempSync(scratchPrefix);
const publicDir = join(stage, "public");
const config = join(stage, "wrangler.jsonc");
const env = { ...process.env, WRANGLER_SEND_METRICS: "false", WRANGLER_LOG_PATH: join(stage, "wrangler.log") };
const assets = [
  "_headers", "admin.html", "icons", "index.html", "js",
  "manifest.webmanifest", "privacy.html", "styles-gameboy.css", "styles.css",
  "sw.js", "terms.html", "watch-app.css", "watch.css", "watch.html",
];

function run(args, capture = false) {
  const result = spawnSync(process.execPath, args, {
    cwd: stage, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    if (capture) process.stderr.write(result.stderr || result.stdout || "");
    throw result.error || new Error("Command failed: " + args.join(" "));
  }
  return result.stdout || "";
}

try {
  const production = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8"));
  if (!process.argv.includes("--build-only") && production.d1_databases[0].database_id === "00000000-0000-0000-0000-000000000000") {
    throw new Error("Copy your D1 database_id into wrangler.jsonc before deployment.");
  }
  for (const asset of assets) cpSync(join(root, asset), join(publicDir, asset), { recursive: true });
  cpSync(join(root, "worker.mjs"), join(stage, "worker.mjs"));
  cpSync(join(root, "wrangler.jsonc"), config);
  for (const directory of ["js", "functions"]) {
    for (const file of readdirSync(join(root, directory), { recursive: true })) {
      if (file.endsWith(".js")) run(["--check", join(root, directory, file)]);
    }
  }
  run([wrangler, "pages", "functions", "build", join(root, "functions"),
    "--outdir", join(stage, "compiled"), "--build-output-directory", publicDir,
    "--compatibility-date", production.compatibility_date]);
  run([join(root, "scripts", "verify-worker.mjs"), root, stage]);
  if (!process.argv.includes("--build-only")) {
    run([wrangler, "deploy", "--config", config, "--keep-vars"]);
  } else if (process.argv.includes("--keep-stage")) {
    console.log("VERIFIED_STAGE=" + stage);
  }
} finally {
  if (!process.argv.includes("--keep-stage") && stage.startsWith(scratchPrefix)) {
    rmSync(stage, { recursive: true, force: true });
  }
}
