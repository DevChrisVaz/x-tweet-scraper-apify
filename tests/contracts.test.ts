import { describe, expect, it } from 'vitest';
import {
  ActorInputSchema,
  TweetOutputSchema,
} from '../src/contracts.js';

describe('actor input contract', () => {
  it('applies the documented defaults', () => {
    const input = ActorInputSchema.parse({ fromUsers: ['apify'] });

    expect(input.maxResults).toBe(100);
    expect(input.includeReplies).toBe(true);
    expect(input.includeRetweets).toBe(false);
    expect(input.mediaType).toBe('any');
    expect(input.sortBy).toBe('latest');
  });

  it('rejects invalid caps, unsupported top sorting, and search terms', () => {
    expect(() => ActorInputSchema.parse({ fromUsers: ['apify'], maxResults: 0 })).toThrow();
    expect(() => ActorInputSchema.parse({ fromUsers: ['apify'], maxResults: 10_001 })).toThrow();
    expect(() => ActorInputSchema.parse({ fromUsers: ['apify'], sortBy: 'top' })).toThrow();
    expect(() => ActorInputSchema.parse({ searchTerms: ['x'] })).toThrow(/searchTerms/i);
    expect(() => ActorInputSchema.parse({})).toThrow(/target/i);
  });
});

describe('tweet output contract', () => {
  it('requires every nullable field and preserves nulls', () => {
    const tweet = TweetOutputSchema.parse({
      id: '123',
      url: 'https://x.com/apify/status/123',
      text: 'hello',
      lang: null,
      createdAt: '2025-01-01T00:00:00Z',
      conversationId: null,
      isReply: false,
      isRetweet: false,
      isQuote: false,
      inReplyToId: null,
      quotedTweetId: null,
      author: {
        id: '42',
        username: 'apify',
        name: 'Apify',
        verified: false,
        followers: 1,
        following: 2,
      },
      metrics: {
        likes: 0,
        retweets: 0,
        replies: 0,
        quotes: 0,
        bookmarks: null,
        views: null,
      },
      entities: {
        hashtags: [],
        mentions: [],
        urls: [],
        media: [{ type: 'photo', url: 'https://example.com/photo.jpg', thumbnail: null }],
      },
      source: null,
      scrapedAt: '2025-01-01T00:00:01Z',
    });

    expect(tweet.lang).toBeNull();
    expect(tweet.conversationId).toBeNull();
    expect(tweet.inReplyToId).toBeNull();
    expect(tweet.quotedTweetId).toBeNull();
    expect(tweet.metrics.bookmarks).toBeNull();
    expect(tweet.metrics.views).toBeNull();
    expect(tweet.source).toBeNull();
    expect(tweet.entities.media[0]?.thumbnail).toBeNull();

    const nullableTopLevel = [
      'lang',
      'conversationId',
      'inReplyToId',
      'quotedTweetId',
      'source',
    ];
    for (const field of nullableTopLevel) {
      const missing = { ...tweet } as Record<string, unknown>;
      delete missing[field];
      expect(() => TweetOutputSchema.parse(missing), `missing nullable field ${field}`).toThrow();
    }

    for (const field of ['bookmarks', 'views']) {
      const metrics = { ...tweet.metrics } as Record<string, unknown>;
      delete metrics[field];
      expect(() => TweetOutputSchema.parse({ ...tweet, metrics }), `missing nullable metric ${field}`).toThrow();
    }

    const media = { ...tweet.entities.media[0] } as Record<string, unknown>;
    delete media.thumbnail;
    expect(
      () => TweetOutputSchema.parse({ ...tweet, entities: { ...tweet.entities, media: [media] } }),
      'missing nullable media thumbnail',
    ).toThrow();
  });
});
