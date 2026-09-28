import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { S3Client, CreateBucketCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
const db = new DynamoDBClient({ endpoint: process.env.DYNAMODB_ENDPOINT });
const TableName = process.env.TABLE_NAME!;
try {
  await db.send(new DescribeTableCommand({ TableName }));
} catch (error) {
  if ((error as { name: string }).name !== 'ResourceNotFoundException') throw error;
  await db.send(
    new CreateTableCommand({
      TableName,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
        { AttributeName: 'gpk', AttributeType: 'S' },
        { AttributeName: 'gsk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'jobs',
          KeySchema: [
            { AttributeName: 'gpk', KeyType: 'HASH' },
            { AttributeName: 'gsk', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );
  await db.send(
    new UpdateTimeToLiveCommand({
      TableName,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    }),
  );
}
const s3 = new S3Client({
  endpoint: process.env.R2_ENDPOINT,
  region: 'auto',
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID!,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  },
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
const Bucket = process.env.R2_BUCKET!;
try {
  await s3.send(new CreateBucketCommand({ Bucket }));
} catch (e) {
  if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes((e as { name: string }).name))
    throw e;
}
try {
  await s3.send(
    new PutBucketCorsCommand({
      Bucket,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
            AllowedMethods: ['GET', 'PUT', 'HEAD'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag', 'Content-Length', 'Content-Range'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
} catch (e) {
  if ((e as { name: string }).name !== 'NotImplemented') throw e;
  console.log('Local MinIO uses global CORS configuration.');
}
console.log(
  'Local DynamoDB table and private object bucket are ready. Incomplete uploads are cleaned by the application job runner.',
);
