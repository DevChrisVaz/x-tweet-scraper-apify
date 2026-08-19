import { z } from 'zod';

const nonEmptyString = z.string().min(1);
const id = nonEmptyString;
const utcTimestamp = z.string().datetime({ offset: false });

const isoDateOrTimestamp = z.string().refine(
  (value) => {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
    const timestamp = /^\d{4}-\d{2}-\d{2}T/.test(value);
    return (dateOnly || timestamp) && !Number.isNaN(Date.parse(value));
  },
  'must be a valid ISO-8601 date or timestamp',
);

export const ProxyConfigurationSchema = z
  .object({
    useApifyProxy: z.boolean().default(false),
    apifyProxyGroups: z.array(nonEmptyString).optional(),
    apifyProxyCountry: nonEmptyString.optional(),
  })
  .strict();

export const ActorInputSchema = z
  .object({
    fromUsers: z.array(nonEmptyString).default([]),
    tweetIds: z.array(id).default([]),
    searchTerms: z.array(nonEmptyString).default([]),
    hashtags: z.array(nonEmptyString).default([]),
    since: isoDateOrTimestamp.optional(),
    until: isoDateOrTimestamp.optional(),
    language: z.string().regex(/^[a-z]{2}$/i).optional(),
    minLikes: z.number().int().nonnegative().optional(),
    minRetweets: z.number().int().nonnegative().optional(),
    minReplies: z.number().int().nonnegative().optional(),
    onlyVerified: z.boolean().default(false),
    mediaType: z.enum(['any', 'text_only', 'images', 'video', 'links']).default('any'),
    includeReplies: z.boolean().default(true),
    includeRetweets: z.boolean().default(false),
    sortBy: z.literal('latest').default('latest'),
    maxResults: z.number().int().min(1).max(10_000).default(100),
    proxyConfiguration: ProxyConfigurationSchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.searchTerms.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['searchTerms'],
        message: 'searchTerms is not supported; provide fromUsers or tweetIds instead',
      });
    }
    if (input.fromUsers.length === 0 && input.tweetIds.length === 0 && input.searchTerms.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fromUsers'],
        message: 'at least one target is required: fromUsers, tweetIds, or searchTerms',
      });
    }
    if (input.since !== undefined && input.until !== undefined && Date.parse(input.since) > Date.parse(input.until)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['since'],
        message: 'since must be earlier than or equal to until',
      });
    }
  });

export const TweetMediaSchema = z
  .object({
    type: z.enum(['photo', 'video', 'animated_gif']),
    url: nonEmptyString,
    thumbnail: nonEmptyString.nullable(),
  })
  .strict();

export const TweetAuthorSchema = z
  .object({
    id,
    username: nonEmptyString,
    name: nonEmptyString,
    verified: z.boolean(),
    followers: z.number().int().nonnegative(),
    following: z.number().int().nonnegative(),
  })
  .strict();

export const TweetMetricsSchema = z
  .object({
    likes: z.number().int().nonnegative(),
    retweets: z.number().int().nonnegative(),
    replies: z.number().int().nonnegative(),
    quotes: z.number().int().nonnegative(),
    bookmarks: z.number().int().nonnegative().nullable(),
    views: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const TweetEntitiesSchema = z
  .object({
    hashtags: z.array(nonEmptyString),
    mentions: z.array(nonEmptyString),
    urls: z.array(nonEmptyString),
    media: z.array(TweetMediaSchema),
  })
  .strict();

export const TweetOutputSchema = z
  .object({
    id,
    url: nonEmptyString,
    text: z.string(),
    lang: nonEmptyString.nullable(),
    createdAt: utcTimestamp,
    conversationId: id.nullable(),
    isReply: z.boolean(),
    isRetweet: z.boolean(),
    isQuote: z.boolean(),
    inReplyToId: id.nullable(),
    quotedTweetId: id.nullable(),
    author: TweetAuthorSchema,
    metrics: TweetMetricsSchema,
    entities: TweetEntitiesSchema,
    source: z.string().nullable(),
    scrapedAt: utcTimestamp,
  })
  .strict();

const SubjectSchema = z
  .object({
    actorId: id,
    runId: id,
    userId: id,
  })
  .strict();

export const EntitlementResolutionSchema = z
  .object({
    subject: SubjectSchema,
    tier: z.enum(['free', 'paid', 'unknown']),
    effectiveLimit: z.number().int().min(0).max(10_000),
    expiresAt: utcTimestamp,
    issuedAt: utcTimestamp,
    signature: nonEmptyString,
    keyId: nonEmptyString,
  })
  .strict();

export const SignedDecisionSchema = z
  .object({
    subject: SubjectSchema,
    tweetId: id,
    decision: z.enum(['grant', 'deny']),
    expiresAt: utcTimestamp,
    signature: nonEmptyString,
    keyId: nonEmptyString,
  })
  .strict();

export const BatchReservationRequestSchema = z
  .object({
    subject: SubjectSchema,
    tweetIds: z.array(id).min(1).max(20),
    requestId: id,
    issuedAt: utcTimestamp,
    signature: nonEmptyString,
  })
  .strict()
  .refine((request) => new Set(request.tweetIds).size === request.tweetIds.length, {
    path: ['tweetIds'],
    message: 'tweetIds must be unique within a reservation batch',
  });

export const SignedReservationResponseSchema = z
  .object({
    subject: SubjectSchema,
    decisions: z.array(SignedDecisionSchema).max(20),
    expiresAt: utcTimestamp,
    signature: nonEmptyString,
    keyId: nonEmptyString,
  })
  .strict();

export type ActorInput = z.infer<typeof ActorInputSchema>;
export type TweetOutput = z.infer<typeof TweetOutputSchema>;
export type EntitlementResolution = z.infer<typeof EntitlementResolutionSchema>;
export type SignedDecision = z.infer<typeof SignedDecisionSchema>;
export type BatchReservationRequest = z.infer<typeof BatchReservationRequestSchema>;
export type SignedReservationResponse = z.infer<typeof SignedReservationResponseSchema>;
