// Agent keys in DynamoDB (M4-01), in the users table (dynamodb-sign-in-stores.ts):
//   AGENTKEY#<keyHash>  / AGENTKEY            keyId, accountId, name, scope, createdAt   (lookup by key)
//   ACCOUNT#<accountId> / AGENTKEY#<keyId>    keyHash, name, scope, createdAt            (an account's keys)
// Both items are written and deleted in one transaction, so a revoked key
// never lingers in the lookup.

import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactionCanceledException,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';

import type { AgentKeyStorePort } from '../application/agent-key-store-port.js';
import type { AgentKey } from '../domain/agent-key.js';

type Item = Record<string, AttributeValue>;

const s = (value: string): AttributeValue => ({ S: value });
const n = (value: number): AttributeValue => ({ N: String(value) });
const str = (item: Item, key: string): string => item[key]?.S ?? '';
const num = (item: Item, key: string): number => Number(item[key]?.N ?? 'NaN');

export class DynamoAgentKeyStore implements AgentKeyStorePort {
  constructor(
    private readonly client: DynamoDBClient,
    private readonly table: string,
  ) {}

  async put(key: AgentKey): Promise<void> {
    const common = { name: s(key.name), scope: s(key.scope), createdAt: n(key.createdAt) };
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.table,
                Item: { pk: s(`AGENTKEY#${key.keyHash}`), sk: s('AGENTKEY'), keyId: s(key.id), accountId: s(key.accountId), ...common },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            {
              Put: {
                TableName: this.table,
                Item: { pk: s(`ACCOUNT#${key.accountId}`), sk: s(`AGENTKEY#${key.id}`), keyHash: s(key.keyHash), ...common },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (error instanceof TransactionCanceledException) throw new Error('Agent key collision; refusing to overwrite');
      throw error;
    }
  }

  async findByHash(keyHash: string): Promise<AgentKey | undefined> {
    const reply = await this.client.send(
      new GetItemCommand({ TableName: this.table, Key: { pk: s(`AGENTKEY#${keyHash}`), sk: s('AGENTKEY') }, ConsistentRead: true }),
    );
    const item = reply.Item;
    if (item === undefined) return undefined;
    return {
      id: str(item, 'keyId'),
      accountId: str(item, 'accountId'),
      name: str(item, 'name'),
      scope: 'read',
      keyHash,
      createdAt: num(item, 'createdAt'),
    };
  }

  async listByAccount(accountId: string): Promise<readonly AgentKey[]> {
    const keys: AgentKey[] = [];
    let start: Item | undefined;
    do {
      const reply = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': s(`ACCOUNT#${accountId}`), ':prefix': s('AGENTKEY#') },
          ConsistentRead: true,
          ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        }),
      );
      for (const item of reply.Items ?? []) {
        keys.push({
          id: str(item, 'sk').slice('AGENTKEY#'.length),
          accountId,
          name: str(item, 'name'),
          scope: 'read',
          keyHash: str(item, 'keyHash'),
          createdAt: num(item, 'createdAt'),
        });
      }
      start = reply.LastEvaluatedKey;
    } while (start !== undefined);
    return keys.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async delete(accountId: string, keyId: string): Promise<'deleted' | 'not_found'> {
    const accountItem = { pk: s(`ACCOUNT#${accountId}`), sk: s(`AGENTKEY#${keyId}`) };
    const reply = await this.client.send(new GetItemCommand({ TableName: this.table, Key: accountItem, ConsistentRead: true }));
    if (reply.Item === undefined) return 'not_found';
    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Delete: { TableName: this.table, Key: accountItem, ConditionExpression: 'attribute_exists(pk)' } },
            { Delete: { TableName: this.table, Key: { pk: s(`AGENTKEY#${str(reply.Item, 'keyHash')}`), sk: s('AGENTKEY') } } },
          ],
        }),
      );
    } catch (error) {
      // Revoked by another request in between.
      if (error instanceof TransactionCanceledException) return 'not_found';
      throw error;
    }
    return 'deleted';
  }
}
