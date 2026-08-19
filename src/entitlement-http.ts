import { BatchReservationRequestSchema, EntitlementResolutionRequestSchema } from './contracts.js';
import { EntitlementService, verifyRequest, type AuthenticatedRequest, type EntitlementRepository } from './entitlements.js';

export interface EntitlementHandlerConfig {
  secret: string;
  canonicalActorId: string;
  repository: EntitlementRepository;
  service: EntitlementService;
  replayedNonces?: Set<string>;
  now?: number;
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : 'request rejected';
  const status = /missing|invalid|mismatch|replay|timestamp|signature|subject|identity/i.test(message) ? 401 : /limit|batch|expired/i.test(message) ? 403 : 503;
  return Response.json({ error: message }, { status });
}

function requestFromWeb(request: Request): Promise<AuthenticatedRequest> {
  return request.json().then((body: unknown) => {
    const pathname = new URL(request.url).pathname;
    return { method: request.method, path: pathname, headers: request.headers, body };
  });
}

function assertCanonicalActor(subject: { actorId: string }, config: EntitlementHandlerConfig): void {
  if (!config.canonicalActorId || subject.actorId !== config.canonicalActorId) throw new Error('actor subject mismatch');
}

export function createEntitlementHandlers(config: EntitlementHandlerConfig): {
  resolve: (request: Request) => Promise<Response>;
  reserve: (request: Request) => Promise<Response>;
} {
  const replayedNonces = config.replayedNonces ?? new Set<string>();
  return {
    async resolve(request) {
      try {
        const authenticated = await verifyRequest(await requestFromWeb(request), { secret: config.secret, replayedNonces, ...(config.repository.claimNonce ? { claimNonce: (nonce, ttl) => config.repository.claimNonce!(nonce, ttl) } : {}), ...(config.now === undefined ? {} : { now: config.now }) });
        assertCanonicalActor(authenticated.subject, config);
        const body = EntitlementResolutionRequestSchema.parse(authenticated.body);
        const resolution = await config.service.resolve({ subject: authenticated.subject, maxResults: body.requestedMaxResults, isPaying: body.platformIsPaying });
        return Response.json(resolution);
      } catch (error) {
        console.error('entitlement resolve failed', error instanceof Error ? error.message : 'unknown error');
        return errorResponse(error);
      }
    },
    async reserve(request) {
      try {
        const authenticated = await verifyRequest(await requestFromWeb(request), { secret: config.secret, replayedNonces, ...(config.repository.claimNonce ? { claimNonce: (nonce, ttl) => config.repository.claimNonce!(nonce, ttl) } : {}), ...(config.now === undefined ? {} : { now: config.now }) });
        assertCanonicalActor(authenticated.subject, config);
        const parsed = BatchReservationRequestSchema.parse(authenticated.body);
        const response = await config.service.handleReservation({ subject: authenticated.subject, tweetIds: parsed.tweetIds });
        return Response.json(response);
      } catch (error) {
        console.error('entitlement reservation failed', error instanceof Error ? error.message : 'unknown error');
        return errorResponse(error);
      }
    },
  };
}
