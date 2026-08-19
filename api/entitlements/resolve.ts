import { getEntitlementHandlers } from '../../src/vercel-entitlements.js';

export async function POST(request: Request): Promise<Response> {
  try {
    return await getEntitlementHandlers().resolve(request);
  } catch (error) {
    console.error('entitlement configuration failed', error instanceof Error ? error.message : 'unknown error');
    return Response.json({ error: 'entitlement service unavailable' }, { status: 503 });
  }
}
