import { z } from "@hono/zod-openapi";
import { valid } from "semver";
import * as S from "../contracts";
import { type App, endpoint, commit, changed, intent, replay, replayResponse } from "../http";
import { ApiError, db, device, grants, audit, parse, service, type Ctx } from "../platform";
import { manifestBytes, verify } from "../crypto";
import { firmwarePrincipal } from "./devices";
import { createHash } from "node:crypto";
import { ReleaseQuery } from "../cms-contracts";

type ReleaseRow = Omit<z.infer<typeof S.Release>, "verified"> & { verified: number };
const objectKey = (id: string) => `releases/${id}.bin`;
async function release(env: Env, id: string) {
    const r = await db(env)
        .prepare("SELECT * FROM firmware_releases WHERE releaseId=?")
        .bind(id)
        .first<ReleaseRow>();
    if (!r) throw new ApiError(404, "RELEASE_NOT_FOUND");
    return r;
}
async function publisher(env: Env, r: ReleaseRow | z.infer<typeof S.Manifest>) {
    const p = await db(env)
        .prepare("SELECT publicKey FROM publisher_keys WHERE keyId=? AND revokedAt IS NULL")
        .bind(r.publisherKeyId)
        .first<{ publicKey: string }>();
    if (!p || !(await verify(p.publicKey, r.signature, manifestBytes(r))))
        throw new ApiError(422, "PUBLISHER_SIGNATURE_INVALID");
}
async function authorizedRelease(c: Ctx) {
    const d = await firmwarePrincipal(c),
        r = await release(c.env, parse(S.Id, c.req.param("releaseId")));
    if (
        d.firmwareTarget !== r.releaseId ||
        r.state !== "APPROVED" ||
        !r.verified ||
        r.hardwareTarget !== d.hardwareTarget ||
        !d.otaSlotBytes ||
        r.size > d.otaSlotBytes ||
        !JSON.parse(d.capabilities).includes("UPGRADE_FIRMWARE")
    )
        throw new ApiError(403, "FIRMWARE_FORBIDDEN");
    await publisher(c.env, r);
    return r;
}
function checksum(object: R2Object, r: ReleaseRow) {
    const digest = object.checksums.sha256;
    return (
        object.size === r.size &&
        digest &&
        Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("") ===
            r.sha256
    );
}
export function firmwareRoutes(app: App) {
    endpoint(
        app,
        {
            method: "post",
            path: "/api/admin/firmware-releases",
            permission: "firmware:write",
            input: S.Manifest,
            output: S.Release,
            status: 201,
            summary: "Create immutable signed application release",
        },
        async (c, input) => {
            if (valid(input.version) !== input.version || input.version.includes("+"))
                throw new ApiError(422, "INVALID_VERSION");
            await publisher(c.env, input);
            const response = {
                ...input,
                state: "UPLOADING",
                verified: false,
                createdAt: Date.now(),
            };
            return commit(
                c,
                "release:create",
                input,
                response,
                [
                    c.env.DB.prepare(
                        "INSERT INTO firmware_releases VALUES(?,?,?,?,?,?,?,?, 'UPLOADING',0,?)"
                    ).bind(
                        input.releaseId,
                        input.buildId,
                        input.hardwareTarget,
                        input.version,
                        input.size,
                        input.sha256,
                        input.publisherKeyId,
                        input.signature,
                        response.createdAt
                    ),
                    audit(
                        c.env,
                        c.get("principal"),
                        c.get("actorId"),
                        "RELEASE_CREATED",
                        undefined,
                        JSON.stringify({ releaseId: input.releaseId })
                    ),
                ],
                201
            );
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/firmware-releases",
            permission: "devices:read",
            query: ReleaseQuery,
            output: S.pageOf(S.Release),
            summary: "List filtered release metadata",
        },
        async (c) => {
            const q = parse(ReleaseQuery, c.req.query());
            const rows = await db(c.env)
                .prepare(
                    "SELECT * FROM firmware_releases WHERE releaseId>? AND (? IS NULL OR hardwareTarget=?) AND (? IS NULL OR version=?) AND (? IS NULL OR state=?) ORDER BY releaseId LIMIT ?"
                )
                .bind(
                    q.cursor ?? "",
                    q.hardwareTarget ?? null,
                    q.hardwareTarget ?? null,
                    q.version ?? null,
                    q.version ?? null,
                    q.state ?? null,
                    q.state ?? null,
                    q.limit + 1
                )
                .all<ReleaseRow>();
            return c.json({
                items: rows.results
                    .slice(0, q.limit)
                    .map((r) => ({ ...r, verified: !!r.verified })),
                nextCursor:
                    rows.results.length > q.limit ? rows.results[q.limit - 1]!.releaseId : null,
            });
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/admin/firmware-releases/{releaseId}",
            permission: "devices:read",
            output: S.Release,
            summary: "Read immutable release and recover upload state",
        },
        async (c) => {
            const r = await release(c.env, c.req.param("releaseId")!);
            return c.json({ ...r, verified: !!r.verified });
        }
    );
    app.openAPIRegistry.registerPath({
        method: "put",
        path: "/api/admin/firmware-releases/{releaseId}/binary",
        security: [{ ServiceBearer: [] }],
        request: {
            params: z.object({ releaseId: S.Id }),
            headers: z.object({
                "x-actor-id": S.Id,
                "content-length": z.string().regex(/^\d+$/).optional(),
            }),
            body: {
                required: true,
                content: {
                    "application/octet-stream": {
                        schema: z.string().openapi({ format: "binary" }),
                    },
                },
            },
        },
        responses: {
            200: {
                description: "Checksum verified; release is DRAFT or already verified",
                content: { "application/json": { schema: S.Ok } },
            },
            default: {
                description: "Standard JSON error envelope; 401/403/404/409/413/422/429/503",
                content: { "application/json": { schema: S.ErrorBody } },
            },
        },
    });
    app.put("/api/admin/firmware-releases/:releaseId/binary", async (c) => {
        await service(c, "firmware:write");
        const r = await release(c.env, parse(S.Id, c.req.param("releaseId")));
        if (r.state === "REVOKED") throw new ApiError(409, "RELEASE_REVOKED");
        await publisher(c.env, r);
        if (!c.req.raw.body) throw new ApiError(422, "BINARY_REQUIRED");
        const length = c.req.header("content-length");
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== r.size))
            throw new ApiError(Number(length) > 8388608 ? 413 : 422, "ARTIFACT_SIZE_INVALID");
        let object = await c.env.FIRMWARE.head(objectKey(r.releaseId));
        if (object) {
            const digest = createHash("sha256"),
                reader = c.req.raw.body.getReader();
            let size = 0;
            try {
                while (true) {
                    const part = await reader.read();
                    if (part.done) break;
                    size += part.value.byteLength;
                    if (size > r.size) {
                        await reader.cancel();
                        throw new ApiError(422, "ARTIFACT_SIZE_INVALID");
                    }
                    digest.update(part.value);
                }
            } finally {
                reader.releaseLock();
            }
            if (size !== r.size || digest.digest("hex") !== r.sha256)
                throw new ApiError(422, "ARTIFACT_INVALID");
        }
        if (!object) {
            const fixed = new FixedLengthStream(r.size),
                abort = new AbortController(),
                digest = createHash("sha256");
            let size = 0;
            const validation = new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                    size += chunk.byteLength;
                    if (size > r.size) throw new ApiError(422, "ARTIFACT_SIZE_INVALID");
                    digest.update(chunk);
                    controller.enqueue(chunk);
                },
                flush() {
                    if (size !== r.size || digest.digest("hex") !== r.sha256)
                        throw new ApiError(422, "ARTIFACT_INVALID");
                },
            });
            const pipe = c.req.raw.body
                .pipeThrough(validation)
                .pipeTo(fixed.writable, { signal: abort.signal });
            // Cancel the producer when R2 stops reading, including a concurrent create-only upload.
            const put = c.env.FIRMWARE.put(objectKey(r.releaseId), fixed.readable, {
                sha256: r.sha256,
                onlyIf: { etagDoesNotMatch: "*" },
                httpMetadata: { contentType: "application/octet-stream" },
            }).then(
                (value) => {
                    if (!value) abort.abort(new ApiError(409, "ARTIFACT_UPLOAD_CONFLICT"));
                    return value;
                },
                (error) => {
                    abort.abort(error);
                    throw error;
                }
            );
            const results = await Promise.allSettled([pipe, put]);
            const invalid = results.find(
                (v) => v.status === "rejected" && v.reason instanceof ApiError
            );
            if (invalid?.status === "rejected") throw invalid.reason;
            if (results.some((v) => v.status === "rejected"))
                throw new ApiError(503, "STORAGE_UNAVAILABLE");
            object = await c.env.FIRMWARE.head(objectKey(r.releaseId));
        }
        if (!object || !checksum(object, r)) throw new ApiError(422, "ARTIFACT_INVALID");
        await db(c.env).batch([
            c.env.DB.prepare(
                "INSERT INTO transaction_guard SELECT count(*) FROM service_credentials WHERE credentialId=? AND revokedAt IS NULL"
            ).bind(c.get("principal").credentialId),
            c.env.DB.prepare(
                "UPDATE firmware_releases SET verified=1,state=CASE WHEN state='UPLOADING' THEN 'DRAFT' ELSE state END WHERE releaseId=? AND state!='REVOKED'"
            ).bind(r.releaseId),
            changed(c.env),
            audit(
                c.env,
                c.get("principal"),
                c.get("actorId"),
                "RELEASE_UPLOADED",
                undefined,
                JSON.stringify({ releaseId: r.releaseId })
            ),
            c.env.DB.prepare("DELETE FROM transaction_guard"),
        ]);
        return c.json({ ok: true });
    });
    endpoint(
        app,
        {
            method: "patch",
            path: "/api/admin/firmware-releases/{releaseId}",
            permission: "firmware:approve",
            input: S.ReleasePatch,
            output: S.Release,
            summary: "Approve verified release or revoke future use",
        },
        async (c, input) => {
            const previous = await replay(
                c.env,
                await intent(c, `release:state:${c.req.param("releaseId")}`, input)
            );
            if (previous) return replayResponse(previous);
            const r = await release(c.env, c.req.param("releaseId")!);
            if (input.state === "APPROVED") {
                if (!r.verified || r.state !== "DRAFT")
                    throw new ApiError(409, "RELEASE_NOT_READY");
                const object = await c.env.FIRMWARE.head(objectKey(r.releaseId));
                if (!object || !checksum(object, r)) throw new ApiError(422, "ARTIFACT_INVALID");
                await publisher(c.env, r);
            }
            return commit(
                c,
                `release:state:${r.releaseId}`,
                input,
                { ...r, verified: !!r.verified, state: input.state },
                [
                    c.env.DB.prepare(
                        "UPDATE firmware_releases SET state=? WHERE releaseId=? AND (?!='APPROVED' OR (state='DRAFT' AND verified=1)) AND (?!='APPROVED' OR EXISTS(SELECT 1 FROM publisher_keys WHERE keyId=publisherKeyId AND revokedAt IS NULL))"
                    ).bind(input.state, r.releaseId, input.state, input.state),
                    changed(c.env),
                    audit(
                        c.env,
                        c.get("principal"),
                        c.get("actorId"),
                        "RELEASE_STATE_CHANGED",
                        undefined,
                        JSON.stringify({ releaseId: r.releaseId, state: input.state })
                    ),
                ]
            );
        }
    );
    endpoint(
        app,
        {
            method: "put",
            path: "/api/admin/devices/{deviceId}/firmware-target",
            permission: "devices:write",
            input: S.TargetInput,
            output: S.TargetInput,
            summary: "Assign approved target without dispatching",
        },
        async (c, input) => {
            const d = await device(c.env, c.req.param("deviceId")!);
            grants(c.get("principal"), d.siteId, d.scopeId);
            const previous = await replay(
                c.env,
                await intent(c, `firmware:target:${d.deviceId}`, input)
            );
            if (previous) return replayResponse(previous);
            const r = await release(c.env, input.releaseId);
            if (r.state !== "APPROVED" || !r.verified) throw new ApiError(409, "RELEASE_NOT_READY");
            await publisher(c.env, r);
            if (d.hardwareTarget && d.hardwareTarget !== r.hardwareTarget)
                throw new ApiError(409, "FIRMWARE_INCOMPATIBLE");
            return commit(c, `firmware:target:${d.deviceId}`, input, input, [
                c.env.DB.prepare(
                    "UPDATE devices SET firmwareTarget=? WHERE deviceId=? AND siteId=? AND scopeId=? AND EXISTS(SELECT 1 FROM firmware_releases r JOIN publisher_keys p ON p.keyId=r.publisherKeyId WHERE r.releaseId=? AND r.state='APPROVED' AND r.verified=1 AND p.revokedAt IS NULL)"
                ).bind(r.releaseId, d.deviceId, d.siteId, d.scopeId, r.releaseId),
                changed(c.env),
                audit(
                    c.env,
                    c.get("principal"),
                    c.get("actorId"),
                    "FIRMWARE_TARGET",
                    d,
                    JSON.stringify(input)
                ),
            ]);
        }
    );
    endpoint(
        app,
        {
            method: "get",
            path: "/api/devices/{deviceId}/firmware/{releaseId}/manifest",
            output: S.Manifest,
            summary: "Own authorized firmware manifest",
        },
        async (c) => {
            const {
                state: _,
                verified: __,
                createdAt: ___,
                ...manifest
            } = await authorizedRelease(c);
            return c.json(manifest);
        }
    );
    app.openAPIRegistry.registerPath({
        method: "get",
        path: "/api/devices/{deviceId}/firmware/{releaseId}/binary",
        security: [{ DeviceBearer: [] }],
        request: {
            params: z.object({ deviceId: S.Id, releaseId: S.Id }),
            headers: z.object({ range: z.string().optional() }),
        },
        responses: {
            200: {
                description: "Full binary; Content-Length, ETag and Accept-Ranges: bytes",
                content: {
                    "application/octet-stream": {
                        schema: z.string().openapi({ format: "binary" }),
                    },
                },
            },
            206: {
                description: "Single byte range; Content-Range and Content-Length",
                content: {
                    "application/octet-stream": {
                        schema: z.string().openapi({ format: "binary" }),
                    },
                },
            },
            416: { description: "Empty response with Content-Range: bytes */size" },
            default: {
                description: "Standard JSON error envelope; 401/403/404/422/429/503",
                content: { "application/json": { schema: S.ErrorBody } },
            },
        },
    });
    app.get("/api/devices/:deviceId/firmware/:releaseId/binary", async (c) => {
        const r = await authorizedRelease(c),
            range = c.req.header("range");
        let offset = 0,
            length = r.size,
            partial = false;
        if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range);
            let start = NaN,
                end = NaN;
            if (m && (m[1] || m[2])) {
                if (!m[1]) {
                    const suffix = Number(m[2]);
                    if (suffix > 0) {
                        start = Math.max(0, r.size - suffix);
                        end = r.size - 1;
                    }
                } else {
                    start = Number(m[1]);
                    end = m[2] ? Math.min(Number(m[2]), r.size - 1) : r.size - 1;
                }
            }
            if (
                !Number.isSafeInteger(start) ||
                !Number.isSafeInteger(end) ||
                start < 0 ||
                start >= r.size ||
                end < start
            )
                return new Response(null, {
                    status: 416,
                    headers: { "content-range": `bytes */${r.size}` },
                });
            offset = start;
            length = end - start + 1;
            partial = true;
        }
        const object = await c.env.FIRMWARE.get(
            objectKey(r.releaseId),
            partial ? { range: { offset, length } } : undefined
        );
        if (!object) throw new ApiError(503, "ARTIFACT_UNAVAILABLE");
        const headers = new Headers({
            "content-type": "application/octet-stream",
            "content-length": String(length),
            "accept-ranges": "bytes",
            etag: object.httpEtag,
            "cache-control": "no-store",
        });
        if (partial)
            headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${r.size}`);
        return new Response(object.body, { status: partial ? 206 : 200, headers });
    });
}
