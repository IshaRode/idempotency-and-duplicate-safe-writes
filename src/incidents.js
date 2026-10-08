const crypto = require('crypto');
const { db } = require('./db');

function canonicalize(val) {
  if (val === undefined) return 'null';
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val);
  }
  if (Array.isArray(val)) {
    return '[' + val.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(val).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalize(val[k])).join(',') + '}';
}

function hashRequest(body) {
  const canonical = canonicalize(body);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function createIncident(req, res) {
  const idempotencyKey = req.get('Idempotency-Key');
  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const tenantId = req.user.tenantId;
  const operation = 'POST:/incidents';
  const requestHash = hashRequest(req.body);
  const { title, severity, serviceId } = req.body;

  const result = await db.tx(async t => {
    // Attempt to claim idempotency key atomically
    const claim = await t.oneOrNone(
      `INSERT INTO idempotency_keys (
        tenant_id, operation, key, request_hash, state, expires_at
      )
      VALUES (
        $1, $2, $3, $4, 'processing', now() + interval '24 hours'
      )
      ON CONFLICT (tenant_id, operation, key) DO NOTHING
      RETURNING *`,
      [tenantId, operation, idempotencyKey, requestHash]
    );

    if (claim) {
      // First request / claim winner: create incident and paging job
      const incident = await t.one(
        `INSERT INTO incidents (tenant_id, service_id, title, severity)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, serviceId, title, severity]
      );

      await t.none(
        `INSERT INTO paging_jobs (incident_id, tenant_id)
         VALUES ($1, $2)`,
        [incident.id, tenantId]
      );

      await t.none(
        `UPDATE idempotency_keys
         SET state = 'completed',
             response_status = 201,
             response_body = $1
         WHERE tenant_id = $2 AND operation = $3 AND key = $4`,
        [JSON.stringify(incident), tenantId, operation, idempotencyKey]
      );

      return { isReplay: false, status: 201, body: incident };
    }

    // Key already exists (concurrent duplicate or sequential retry)
    const existing = await t.one(
      `SELECT * FROM idempotency_keys
       WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, operation, idempotencyKey]
    );

    if (existing.request_hash !== requestHash) {
      return { error: 'idempotency_key_conflict', status: 409 };
    }

    if (existing.state === 'completed') {
      return {
        isReplay: true,
        status: existing.response_status || 201,
        body: existing.response_body
      };
    }

    if (existing.state === 'processing') {
      return { error: 'operation_in_progress', status: 409 };
    }

    if (existing.state === 'failed') {
      return { error: 'prior_operation_failed', status: 409 };
    }

    return { error: 'operation_in_progress', status: 409 };
  });

  if (result.error) {
    return res.status(result.status).json({ error: result.error });
  }

  if (result.isReplay) {
    res.set('Idempotent-Replayed', 'true');
  }

  return res.status(result.status).json(result.body);
}

module.exports = { createIncident, hashRequest };
