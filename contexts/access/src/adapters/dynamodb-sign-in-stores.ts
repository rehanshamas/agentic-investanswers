// Account and session stores in DynamoDB (M2-08; user data lives in DynamoDB,
// docs/architecture.md). DynamoDB Local from docker-compose.yml until AWS
// staging is deployed (decision record F-01); the table is created by CDK
// there (M2-01) and by `ensureUsersTable` locally.
//
// One table, keys `pk` and `sk`:
//   ACCOUNT#<id>        / ACCOUNT   email, passwordHash, createdAt
//   EMAIL#<email>       / EMAIL     accountId   (keeps emails unique)
//   SESSION#<tokenHash> / SESSION   accountId, createdAt, expiresAt, ttl
// An account and its email item are written in one transaction, each only if
// absent, so two sign-ups with one email cannot both succeed. Sessions carry
// `ttl` (epoch seconds) so DynamoDB deletes expired ones by itself.

import {
  ConditionalCheckFailedException,
  CreateTableCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  ResourceNotFoundException,
  TransactionCanceledException,
  TransactWriteItemsCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

import type { AccountStorePort, SessionStorePort } from '../application/sign-in-ports.js';
import type { Account } from '../domain/account.js';
import type { Session } from '../domain/session.js';

export interface DynamoConfig {
  /** Defaults to the local DynamoDB from docker-compose.yml; "aws" means AWS itself, with the default credential chain. */
  readonly endpoint?: string | undefined;
  readonly region?: string;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string };
  readonly table: string;
}

type Item = Record<string, AttributeValue>;

const s = (value: string): AttributeValue => ({ S: value });
const n = (value: number): AttributeValue => ({ N: String(value) });
const str = (item: Item, key: string): string => item[key]?.S ?? '';
const num = (item: Item, key: string): number => Number(item[key]?.N ?? 'NaN');

export function dynamoClient(config: DynamoConfig): DynamoDBClient {
  if (config.endpoint === 'aws') return new DynamoDBClient(config.region ? { region: config.region } : {});
  return new DynamoDBClient({
    endpoint: config.endpoint ?? 'http://127.0.0.1:8000',
    region: config.region ?? 'us-east-1',
    // DynamoDB Local accepts any credentials; real AWS uses the default chain when none are given.
    ...(config.credentials ? { credentials: config.credentials } : {}),
  });
}

/** Create the users table if it does not exist (local runs and tests; CDK creates it in AWS). */
export async function ensureUsersTable(client: DynamoDBClient, table: string): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: table }));
    return;
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
    }),
  );
  await client.send(
    new UpdateTimeToLiveCommand({ TableName: table, TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true } }),
  );
}

export class DynamoAccountStore implements AccountStorePort {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly table: string,
  ) {}

  async create(account: Account): Promise<'created' | 'email_taken'> {
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { pk: s(`EMAIL#${account.email}`), sk: s('EMAIL'), accountId: s(account.id) },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: {
                  pk: s(`ACCOUNT#${account.id}`),
                  sk: s('ACCOUNT'),
                  email: s(account.email),
                  passwordHash: s(account.passwordHash),
                  createdAt: n(account.createdAt),
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
      return 'created';
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        const reasons = error.CancellationReasons ?? [];
        if (reasons[0]?.Code === 'ConditionalCheckFailed') return 'email_taken';
      }
      throw error;
    }
  }

  async findByEmail(email: string): Promise<Account | undefined> {
    const link = await this.get(`EMAIL#${email}`, 'EMAIL');
    return link === undefined ? undefined : this.findById(str(link, 'accountId'));
  }

  async findById(id: string): Promise<Account | undefined> {
    const item = await this.get(`ACCOUNT#${id}`, 'ACCOUNT');
    if (item === undefined) return undefined;
    return { id, email: str(item, 'email'), passwordHash: str(item, 'passwordHash'), createdAt: num(item, 'createdAt') };
  }

  private async get(pk: string, sk: string): Promise<Item | undefined> {
    const reply = await this.client.send(
      new GetItemCommand({ TableName: this.table, Key: { pk: s(pk), sk: s(sk) }, ConsistentRead: true }),
    );
    return reply.Item;
  }
}

export class DynamoSessionStore implements SessionStorePort {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly table: string,
  ) {}

  async put(session: Session): Promise<void> {
    await this.client.send(
      new PutItemCommand({
        TableName: this.table,
        Item: {
          pk: s(`SESSION#${session.tokenHash}`),
          sk: s('SESSION'),
          accountId: s(session.accountId),
          createdAt: n(session.createdAt),
          expiresAt: n(session.expiresAt),
          ttl: n(Math.ceil(session.expiresAt / 1_000)),
        },
        // A token hash colliding with an existing session would be a broken random source.
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    ).catch((error: unknown) => {
      if (error instanceof ConditionalCheckFailedException) throw new Error('Session token collision; refusing to overwrite');
      throw error;
    });
  }

  async get(tokenHash: string): Promise<Session | undefined> {
    const reply = await this.client.send(
      new GetItemCommand({ TableName: this.table, Key: { pk: s(`SESSION#${tokenHash}`), sk: s('SESSION') }, ConsistentRead: true }),
    );
    const item = reply.Item;
    if (item === undefined) return undefined;
    return { tokenHash, accountId: str(item, 'accountId'), createdAt: num(item, 'createdAt'), expiresAt: num(item, 'expiresAt') };
  }

  async delete(tokenHash: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({ TableName: this.table, Key: { pk: s(`SESSION#${tokenHash}`), sk: s('SESSION') } }),
    );
  }
}
