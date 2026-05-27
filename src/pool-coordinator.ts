import { DurableObject } from "cloudflare:workers";
import type { RecordResult, SelectionRequest, SelectionResult } from "./types";

type LeaseRow = {
  identity_id: string;
  expires_at: number;
};

type RateRow = {
  remaining: number;
  reset_at: number;
};

export class PoolCoordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS leases (
          route_key TEXT PRIMARY KEY,
          identity_id TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS rate_states (
          identity_id TEXT NOT NULL,
          resource TEXT NOT NULL,
          remaining INTEGER NOT NULL,
          reset_at INTEGER NOT NULL,
          PRIMARY KEY (identity_id, resource)
        );
        CREATE TABLE IF NOT EXISTS cooldowns (
          identity_id TEXT NOT NULL,
          route_key TEXT NOT NULL,
          status INTEGER NOT NULL,
          reason TEXT NOT NULL,
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (identity_id, route_key)
        );
      `);
    });
  }

  selectIdentity(request: SelectionRequest): SelectionResult {
    const now = Date.now();
    const candidateIds = new Set(request.candidates.map((candidate) => candidate.id));
    const lease = this.ctx.storage.sql
      .exec<LeaseRow>(
        "SELECT identity_id, expires_at FROM leases WHERE route_key = ?",
        request.routeKey,
      )
      .toArray()[0];
    if (
      lease !== undefined &&
      lease.expires_at > now &&
      candidateIds.has(lease.identity_id) &&
      !this.isCoolingDown(lease.identity_id, request, now) &&
      !this.isQuotaExhausted(lease.identity_id, request.resource, now)
    ) {
      return {
        identityId: lease.identity_id,
        reason: "sticky",
        leaseTtlSeconds: Math.ceil((lease.expires_at - now) / 1000),
      };
    }

    let best: (typeof request.candidates)[number] | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const candidate of request.candidates) {
      if (this.isCoolingDown(candidate.id, request, now)) {
        continue;
      }
      const rate = this.ctx.storage.sql
        .exec<RateRow>(
          "SELECT remaining, reset_at FROM rate_states WHERE identity_id = ? AND resource = ?",
          candidate.id,
          request.resource,
        )
        .toArray()[0];
      if (rate !== undefined && rate.reset_at > now && rate.remaining <= 0) {
        continue;
      }
      const remaining = rate === undefined || rate.reset_at <= now ? 5000 : rate.remaining;
      const score = remaining + candidate.weight;
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    if (best === undefined) {
      throw new Error("all_identity_candidates_cooling_down");
    }
    const ttlMs = 10_000;
    this.ctx.storage.sql.exec(
      `INSERT INTO leases (route_key, identity_id, expires_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(route_key) DO UPDATE SET identity_id = excluded.identity_id, expires_at = excluded.expires_at`,
      request.routeKey,
      best.id,
      now + ttlMs,
    );
    return {
      identityId: best.id,
      reason: bestScore === Number.NEGATIVE_INFINITY ? "fallback" : "highest_remaining",
      leaseTtlSeconds: ttlMs / 1000,
    };
  }

  recordResult(result: RecordResult): void {
    if (result.rate?.remaining !== undefined && result.rate.resetAt !== undefined) {
      this.ctx.storage.sql.exec(
        `INSERT INTO rate_states (identity_id, resource, remaining, reset_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(identity_id, resource)
         DO UPDATE SET remaining = excluded.remaining, reset_at = excluded.reset_at`,
        result.identityId,
        result.resource,
        result.rate.remaining,
        result.rate.resetAt * 1000,
      );
    }
    if (result.status === 401 || result.status === 403 || result.status === 429) {
      const cooldown = classifyCooldown(result);
      this.ctx.storage.sql.exec(
        `INSERT INTO cooldowns (identity_id, route_key, status, reason, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(identity_id, route_key)
         DO UPDATE SET status = excluded.status, reason = excluded.reason, expires_at = excluded.expires_at`,
        result.identityId,
        cooldown.key,
        result.status,
        "github_error",
        Date.now() + cooldown.ttlMs,
      );
    }
  }

  private cooldownExpiresAt(identityId: string, routeKey: string, now: number): number | undefined {
    const cooldown = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        "SELECT expires_at FROM cooldowns WHERE identity_id = ? AND route_key = ?",
        identityId,
        routeKey,
      )
      .toArray()[0];
    return cooldown !== undefined && cooldown.expires_at > now ? cooldown.expires_at : undefined;
  }

  private isCoolingDown(identityId: string, request: SelectionRequest, now: number): boolean {
    return (
      this.cooldownExpiresAt(identityId, "*", now) !== undefined ||
      this.cooldownExpiresAt(identityId, `resource:${request.resource}`, now) !== undefined ||
      this.cooldownExpiresAt(identityId, request.routeKey, now) !== undefined
    );
  }

  private isQuotaExhausted(identityId: string, resource: string, now: number): boolean {
    const rate = this.ctx.storage.sql
      .exec<RateRow>(
        "SELECT remaining, reset_at FROM rate_states WHERE identity_id = ? AND resource = ?",
        identityId,
        resource,
      )
      .toArray()[0];
    return rate !== undefined && rate.reset_at > now && rate.remaining <= 0;
  }
}

function classifyCooldown(result: RecordResult): { key: string; ttlMs: number } {
  const retryAfterMs =
    result.rate?.retryAfter !== undefined ? Math.max(result.rate.retryAfter, 1) * 1000 : undefined;
  if (result.status === 401) {
    return { key: "*", ttlMs: retryAfterMs ?? 120_000 };
  }
  if (retryAfterMs !== undefined) {
    return { key: "*", ttlMs: retryAfterMs };
  }
  if (result.status === 403 && result.rate?.remaining !== undefined && result.rate.remaining > 0) {
    return { key: "*", ttlMs: 120_000 };
  }
  if (result.status === 429) {
    return { key: `resource:${result.resource}`, ttlMs: 120_000 };
  }
  return { key: result.routeKey, ttlMs: 120_000 };
}
