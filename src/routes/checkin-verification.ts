import { z } from "@hono/zod-openapi";
import type { App } from "../http";
import { ApiError, db, rateLimit } from "../platform";
import { Policy, Time } from "../contracts";
import { ContractQrQuery, verifyCheckinQr } from "../checkin-verification";

export function checkinVerificationRoutes(app: App) {
    const errors = {
        400: "bad_request",
        401: "invalid_signature",
        404: "unknown_device",
        410: "expired",
        429: "rate_limited",
        503: "unavailable",
    } as const;
    app.openAPIRegistry.registerPath({
        method: "get",
        path: "/checkin",
        summary: "Verify P-256/SHA-256 contract QR only; no player session, receipt or redirect",
        description: "Exactly v, did, t and sig. Message: ASCII v1.<did>.<t>. t is Unix seconds on a 30-second boundary. sig is Base64URL without padding of IEEE P1363 r||s (64 bytes). All responses use Cache-Control: no-store.",
        security: [],
        request: { query: ContractQrQuery },
        responses: {
            200: {
                description: "Valid signature and QR time window",
                content: {
                    "application/json": {
                        schema: z.strictObject({
                            valid: z.literal(true),
                            deviceId: ContractQrQuery.shape.did,
                            issuedAtMs: Time,
                            verifiedAtMs: Time,
                        }),
                    },
                },
            },
            ...Object.fromEntries(
                Object.entries(errors).map(([status, error]) => [
                    status,
                    {
                        description: error,
                        content: {
                            "application/json": { schema: z.object({ error: z.literal(error) }) },
                        },
                    },
                ])
            ),
        },
    });
    app.get("/checkin", async (c) => {
        c.header("cache-control", "no-store");
        try {
            // shortcut: dev IP limiter; backend tổng must set its own public traffic policy.
            await rateLimit(c.env, `checkin:${c.req.header("cf-connecting-ip") ?? "local"}`, 120);
            const query = c.req.queries();
            if (
                Object.keys(query).length !== 4 ||
                Object.keys(ContractQrQuery.shape).some((key) => query[key]?.length !== 1)
            )
                return c.json({ error: "bad_request" }, 400);
            const parsed = ContractQrQuery.safeParse(c.req.query());
            if (!parsed.success) return c.json({ error: "bad_request" }, 400);
            const qr = parsed.data;
            const row = await db(c.env)
                .prepare(
                    `SELECT d.credentialHash,d.checkInEnabled,k.publicKey,p.maxAgeMs,p.futureSkewMs
                 FROM devices d
                 LEFT JOIN qr_keys k ON k.deviceId=d.deviceId AND k.generation=d.generation AND k.state='ACTIVE'
                 LEFT JOIN qr_policy p ON p.id=1
                 WHERE d.deviceId=? AND d.deletedAt IS NULL`
                )
                .bind(qr.did)
                .first<{
                    credentialHash: string | null;
                    checkInEnabled: number;
                    publicKey: string | null;
                    maxAgeMs: number | null;
                    futureSkewMs: number | null;
                }>();
            if (!row) return c.json({ error: "unknown_device" }, 404);
            const policy = Policy.safeParse({
                maxAgeMs: row.maxAgeMs,
                futureSkewMs: row.futureSkewMs,
            });
            if (!policy.success) return c.json({ error: "unavailable" }, 503);
            if (!row.credentialHash || !row.checkInEnabled || !row.publicKey)
                return c.json({ error: "invalid_signature" }, 401);
            const result = await verifyCheckinQr(qr, row.publicKey, policy.data, Date.now());
            if ("error" in result) {
                const status =
                    result.error === "expired" ? 410 : result.error === "bad_request" ? 400 : 401;
                return c.json(result, status);
            }
            return c.json(result);
        } catch (error) {
            if (error instanceof ApiError && error.status === 429)
                return c.json({ error: "rate_limited" }, 429);
            return c.json({ error: "unavailable" }, 503);
        }
    });
}
