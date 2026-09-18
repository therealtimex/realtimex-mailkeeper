import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// Same shape as realtimex-aigateway: dist/<name>-plugin-<version>/ staged,
// zipped, sha256'd, and attached to a GitHub Release for marketplace install.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

export function stagePluginRelease({ rootDir = repoRoot, outDir = path.join(rootDir, "dist") } = {}) {
  const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(path.join(rootDir, "realtimex.plugin.json"), "utf8"));
  if (manifest.version !== packageJson.version) {
    throw new Error(
      `realtimex.plugin.json version ${manifest.version} does not match package.json ${packageJson.version}`
    );
  }
  const assetBaseName = `${manifest.name}-plugin-${manifest.version}`;
  const stageDir = path.join(outDir, assetBaseName);

  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  writeFileSync(path.join(stageDir, "realtimex.plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    path.join(stageDir, "plugin-metadata.json"),
    `${JSON.stringify(
      {
        plugin: {
          manifestId: manifest.id,
          slug: manifest.name,
          displayName: manifest.displayName,
          installSource: "github-release",
          repository: packageJson.repository?.url || null,
          lifecycle: {
            enableSupported: true,
            disableSupported: true,
            reloadRequired: false,
            activationScope: manifest.activationScope,
          },
          hostRequirements: {
            // Until realtimex-ai-app#1996 lands, runtime/host.js uses the @/ shim.
            publicSdkNamespaces: ["workspaces", "heartbeat"],
            fallback: "server-internal-shim",
          },
        },
      },
      null,
      2
    )}\n`
  );

  for (const entry of ["index.js", "runtime", "templates", "skills"]) {
    cpSync(path.join(rootDir, entry), path.join(stageDir, entry), { recursive: true });
  }
  cpSync(path.join(rootDir, "README.md"), path.join(stageDir, "README.md"));

  const zipPath = path.join(outDir, `${assetBaseName}.zip`);
  rmSync(zipPath, { force: true });
  const zip = spawnSync("zip", ["-r", "-q", zipPath, assetBaseName], { cwd: outDir, stdio: "inherit" });
  if (zip.status !== 0) throw new Error("zip failed");

  const sha256 = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
  writeFileSync(path.join(outDir, `${assetBaseName}.sha256`), `${sha256}  ${assetBaseName}.zip\n`);

  return { stageDir, zipPath, sha256, assetBaseName };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = stagePluginRelease();
  console.log(JSON.stringify(result, null, 2));
}
