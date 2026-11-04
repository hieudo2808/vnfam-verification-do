import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { ServiceProvision, Id, PublicKey } from "../src/contracts";
import { randomToken, hash, unb64 } from "../src/crypto";

const [command, inputPath, environment = "local"] = Bun.argv.slice(2);
if (
    !inputPath ||
    !["local", "staging"].includes(environment) ||
    !["service:create", "service:revoke", "publisher:add", "publisher:revoke"].includes(
        command ?? ""
    )
)
    throw new Error(
        "Usage: bun run provision <service:create|service:revoke|publisher:add|publisher:revoke> <JSON file> [local|staging]"
    );
const input = await Bun.file(inputPath).json();
const q = (value: string) => `'${value.replaceAll("'", "''")}'`;
let sql: string, secret: Record<string, string> | undefined;
if (command === "service:create") {
    const p = ServiceProvision.parse(input);
    if (
        p.kind === "MINIGAME" &&
        p.permissions.some((v) => !["checkins:read", "checkins:write"].includes(v))
    )
        throw new Error("Minigame cannot receive admin permissions");
    if (p.kind !== "OPERATOR" && p.permissions.includes("policy:write"))
        throw new Error("policy:write requires OPERATOR");
    const token = randomToken();
    secret = { credentialId: p.credentialId, clientId: p.clientId, token };
    sql = `INSERT INTO service_credentials VALUES(${[p.credentialId, p.clientId, p.kind, await hash(token), JSON.stringify(p.permissions), JSON.stringify(p.sites), JSON.stringify(p.scopes)].map(q).join(",")},NULL,${Date.now()});`;
} else if (command === "service:revoke") {
    sql = `UPDATE service_credentials SET revokedAt=${Date.now()} WHERE credentialId=${q(Id.parse(input.credentialId))};`;
} else {
    const publicKey = command === "publisher:add" ? PublicKey.parse(input.publicKey) : null;
    const keyId = publicKey ? await hash(unb64(publicKey)) : PublicKey.parse(input.keyId);
    sql = publicKey
        ? `INSERT INTO publisher_keys VALUES(${q(keyId)},${q(publicKey)},NULL);`
        : `UPDATE publisher_keys SET revokedAt=${Date.now()} WHERE keyId=${q(keyId)};`;
}
await mkdir(".local", { recursive: true });
const sqlPath = resolve(".local", `provision-${crypto.randomUUID()}.sql`);
const output = secret
    ? resolve(
          ".local",
          `${environment === "local" ? "" : environment + "-"}${secret.credentialId}.secret.json`
      )
    : null;
// Write once before DB commit, so a lost response never loses the operator's only token copy.
if (output)
    await writeFile(output, JSON.stringify(secret, null, 2) + "\n", { flag: "wx", mode: 0o600 });
await writeFile(sqlPath, sql, { flag: "wx", mode: 0o600 });
try {
    const stateDir = process.env.VNFAM_LOCAL_STATE_DIR;
    const child = Bun.spawn(
        [
            process.execPath,
            "run",
            "db:execute",
            ...(environment === "staging"
                ? ["--remote", "--config", "wrangler.staging.jsonc"]
                : ["--local", ...(stateDir ? ["--persist-to", stateDir] : [])]),
            "--file",
            sqlPath,
        ],
        { stdout: "ignore", stderr: "ignore" }
    );
    if ((await child.exited) !== 0)
        throw new Error(
            "Provision failed; inspect the selected D1 environment. No secret printed."
        );
    console.log(
        output ? `Credential saved once: ${output}` : `${environment} provisioning completed`
    );
} finally {
    await unlink(sqlPath);
}
