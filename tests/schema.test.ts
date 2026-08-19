import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const outputSchema = JSON.parse(readFileSync(new URL('../OUTPUT_SCHEMA.json', import.meta.url), 'utf8')) as object;

const completeTweet = {
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
  author: { id: '42', username: 'apify', name: 'Apify', verified: false, followers: 1, following: 2 },
  metrics: { likes: 0, retweets: 0, replies: 0, quotes: 0, bookmarks: null, views: null },
  entities: { hashtags: [], mentions: [], urls: [], media: [] },
  source: null,
  scrapedAt: '2025-01-01T00:00:01Z',
};

describe('output JSON schema', () => {
  it('rejects offset timestamps and accepts UTC Z timestamps', () => {
    const validate = new Ajv().compile(outputSchema);

    expect(validate(completeTweet)).toBe(true);
    expect(validate({ ...completeTweet, createdAt: '2025-01-01T00:00:00+05:00' })).toBe(false);
  });
});
