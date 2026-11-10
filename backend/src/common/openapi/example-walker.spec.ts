import { findExampleGaps, mediaExampleGaps, type SchemaMap } from './example-walker';

const components: SchemaMap = {
  UuidHolder: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
  Covered: {
    type: 'object',
    properties: {
      id: { type: 'string', example: '3c1f3a9e-2d4b-4a57-8e0f-6b7d9c1a2e44' },
      kind: { type: 'string', enum: ['A', 'B'] },
      limit: { type: 'integer', default: 20 },
      fixed: { type: 'string', const: 'x' },
    },
  },
  Page: {
    type: 'object',
    properties: {
      entries: { type: 'array', items: { $ref: '#/components/schemas/UuidHolder' } },
      nextCursor: { type: 'string', nullable: true },
    },
  },
  Maybe: {
    type: 'object',
    properties: { ai: { nullable: true, allOf: [{ $ref: '#/components/schemas/UuidHolder' }] } },
  },
  Loop: { type: 'object', properties: { next: { $ref: '#/components/schemas/Loop' } } },
  FraudProblemDto: { type: 'object', properties: { status: { type: 'number' } } },
  ProblemDetailsDto: { type: 'object', properties: { detail: { type: 'string' } } },
};

describe('findExampleGaps (DBS-137)', () => {
  it('TC-137-10 accepts a leaf with example, enum, default or const', () => {
    expect(findExampleGaps({ $ref: '#/components/schemas/Covered' }, components)).toEqual([]);
  });

  it('TC-137-10 names the path of a leaf with none, through $ref', () => {
    expect(
      findExampleGaps({ $ref: '#/components/schemas/UuidHolder' }, components, 'Body'),
    ).toEqual(['Body.id']);
  });

  it('TC-137-10 walks array items and nullable leaves', () => {
    expect(findExampleGaps({ $ref: '#/components/schemas/Page' }, components)).toEqual([
      'entries[].id',
      'nextCursor',
    ]);
  });

  it('TC-137-10 walks allOf with nullable', () => {
    expect(findExampleGaps({ $ref: '#/components/schemas/Maybe' }, components)).toEqual(['ai.id']);
  });

  it('TC-137-10 accepts an example at any level above the leaves', () => {
    expect(
      findExampleGaps(
        { $ref: '#/components/schemas/Page', example: { entries: [], nextCursor: null } },
        components,
      ),
    ).toEqual([]);
    expect(
      findExampleGaps(
        {
          type: 'object',
          additionalProperties: { type: 'object' },
          example: { db: { status: 'up' } },
        },
        components,
      ),
    ).toEqual([]);
  });

  it('TC-137-10 reports an object with additionalProperties but no example', () => {
    expect(
      findExampleGaps(
        { type: 'object', additionalProperties: { type: 'object' } },
        components,
        'info',
      ),
    ).toEqual(['info']);
  });

  it('TC-137-10 walks an inline schema like a named one', () => {
    expect(
      findExampleGaps(
        {
          type: 'object',
          properties: {
            transferId: { type: 'string' },
            reviewStatus: { type: 'string', enum: ['X'] },
          },
        },
        components,
        'review',
      ),
    ).toEqual(['review.transferId']);
  });

  it('TC-137-10 terminates on a cyclic reference', () => {
    expect(findExampleGaps({ $ref: '#/components/schemas/Loop' }, components)).toEqual([]);
  });

  it('TC-137-10 exempts the shared problem schemas, which carry media-type examples instead', () => {
    expect(findExampleGaps({ $ref: '#/components/schemas/FraudProblemDto' }, components)).toEqual(
      [],
    );
    expect(findExampleGaps({ $ref: '#/components/schemas/ProblemDetailsDto' }, components)).toEqual(
      [],
    );
  });

  it('TC-137-10 a media type example is enough, otherwise the schema is walked', () => {
    const schema = { $ref: '#/components/schemas/UuidHolder' };
    expect(mediaExampleGaps({ schema, example: { id: 'x' } }, components)).toEqual([]);
    expect(
      mediaExampleGaps({ schema, examples: { ok: { value: { id: 'x' } } } }, components),
    ).toEqual([]);
    expect(mediaExampleGaps({ schema }, components)).toEqual(['id']);
    expect(mediaExampleGaps(undefined, components)).toEqual(['(no content)']);
  });
});
