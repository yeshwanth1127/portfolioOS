import crypto from 'crypto';
import { featureDenied, hasFeature } from '../core/permissions/features.js';
import { dbQuery } from '../domain/db-helpers.js';

const err = (code, message) => ({ error: { code, message } });
const BILLING_SECRET = () => process.env.BILLING_WEBHOOK_SECRET ?? 'dev-billing-webhook-secret';

export async function createCheckoutSession(client, membership) {
  if (!hasFeature(membership, 'billing')) return featureDenied(membership, 'billing');
  if (membership.role !== 'owner') return err('forbidden', 'Workspace owner only.');

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (stripeKey) {
    return {
      mode: 'stripe',
      checkout_url: `https://checkout.stripe.com/c/pay/cs_test_${crypto.randomBytes(12).toString('hex')}`,
      message: 'Stripe key present; use hosted checkout in production.',
    };
  }

  const sessionId = `mock_${crypto.randomBytes(8).toString('hex')}`;
  return {
    mode: 'mock',
    session_id: sessionId,
    checkout_url: `https://example.com/billing/mock-checkout?session=${sessionId}`,
  };
}

function billingSecretOk(given) {
  const expected = BILLING_SECRET();
  const secret = String(given ?? '');
  if (!secret || secret.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function billingWebhook(client, rawBody, headers) {
  if (!billingSecretOk(headers?.['x-billing-secret'] ?? rawBody?.webhook_secret)) {
    return err('forbidden', 'Invalid billing webhook secret.');
  }

  const workspaceId = rawBody?.workspace_id;
  const planCode = rawBody?.plan_code ?? 'pilot';
  const stripeCustomerId = rawBody?.stripe_customer_id ?? null;
  const subscriptionStatus = rawBody?.subscription_status ?? 'active';
  if (!/^[0-9a-f-]{36}$/i.test(String(workspaceId ?? ''))) {
    return err('invalid', 'workspace_id required.');
  }

  await client.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
  await client.query(`SELECT set_config('app.role', 'system', true)`);

  await client.query(
    `INSERT INTO billing_customers (workspace_id, stripe_customer_id, subscription_status)
     VALUES ($1,$2,$3)
     ON CONFLICT (workspace_id) DO UPDATE SET
       stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, billing_customers.stripe_customer_id),
       subscription_status = EXCLUDED.subscription_status,
       updated_at = now()`,
    [workspaceId, stripeCustomerId, subscriptionStatus],
  );

  await client.query(`SELECT auth.set_workspace_entitlement($1, $2, NULL, $3::jsonb)`, [
    workspaceId,
    planCode,
    JSON.stringify({ source: 'billing_webhook' }),
  ]);

  const { rows } = await dbQuery(
    client,
    `SELECT workspace_id, stripe_customer_id, subscription_status, updated_at FROM billing_customers WHERE workspace_id = $1`,
    [workspaceId],
  );
  return { ok: true, customer: rows[0] };
}
