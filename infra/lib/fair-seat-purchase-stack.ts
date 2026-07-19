/**
 * Fair Seat Purchase — AWS CDK stack (Option A deployment).
 *
 * Publishes the whole app to the internet with the standard secure static-hosting
 * pattern:
 *
 *   - UI  : private S3 bucket (Block Public Access ON) served through a
 *           CloudFront distribution using Origin Access Control (OAC). The
 *           bucket is never public; only CloudFront can read it.
 *   - API : the Express app on a Node.js Lambda behind an HTTP API
 *           (API Gateway v2). CORS is handled by the Express app (see
 *           src/api/app.ts) so the CloudFront-hosted UI can call the API.
 *   - Data: the EXISTING `FairSeatPurchase` DynamoDB table is IMPORTED (not
 *           recreated), so the already-seeded ARENA1 inventory is reused and
 *           there is no CloudFormation "table already exists" conflict.
 *
 * The static assets in ../../public are uploaded to the bucket, and a generated
 * `config.js` (containing the deployed API URL) is written on top so the UI
 * knows where the API lives.
 *
 * ⚠️ SECURITY: the API uses PLACEHOLDER auth (`x-fan-id` header, see
 * src/api/auth.ts). This exposes an UNAUTHENTICATED endpoint that can hold/buy
 * seats. Acceptable for a demo; a real deployment MUST add an authorizer
 * (JWT / waiting-room token) before the API route.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type { Construct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Lambda entry (`src/api/lambda.ts`) relative to infra/lib/. */
const LAMBDA_ENTRY = path.join(__dirname, "..", "..", "src", "api", "lambda.ts");
/** Static UI directory (`public/`) relative to infra/lib/. */
const PUBLIC_DIR = path.join(__dirname, "..", "..", "public");
/** The existing DynamoDB table name (created out-of-band by `npm run db:create`). */
const TABLE_NAME = "FairSeatPurchase";

export class FairSeatPurchaseStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // ── Import the EXISTING table (not recreated). grantIndexPermissions so
    //    the Lambda's IAM policy also covers GSI1 / GSI2 queries. ───────────
    const table = dynamodb.Table.fromTableAttributes(this, "FairSeatPurchaseTable", {
      tableName: TABLE_NAME,
      grantIndexPermissions: true,
    });

    // ── API Lambda: the serverless-http Express app (src/api/lambda.ts). ────
    const apiFn = new NodejsFunction(this, "FairSeatPurchaseApiFn", {
      entry: LAMBDA_ENTRY,
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: Duration.seconds(15),
      environment: {
        FSP_TABLE_NAME: TABLE_NAME,
        // Allow the CloudFront-hosted UI (any origin for the demo) to call the API.
        FSP_CORS_ORIGIN: "*",
        // The sweeper runs in the long-lived server, not per-request Lambda.
        FSP_SWEEP_INTERVAL_MS: "0",
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node20",
        minify: true,
        sourceMap: true,
        // Express and its CJS dependencies use require() of Node built-ins
        // (e.g. "http"). In an ESM bundle esbuild's default require shim throws
        // "Dynamic require of ... is not supported". This banner recreates a
        // working require (and __dirname/__filename) at the top of the bundle.
        banner:
          "import{createRequire as __cr}from'module';import{fileURLToPath as __fu}from'url';import{dirname as __dn}from'path';const require=__cr(import.meta.url);const __filename=__fu(import.meta.url);const __dirname=__dn(__filename);",
      },
    });
    table.grantReadWriteData(apiFn);

    // ── HTTP API fronting the Lambda (Express handles CORS + routing). ──────
    const httpApi = new apigwv2.HttpApi(this, "FairSeatPurchaseHttpApi", {
      apiName: "fair-seat-purchase-api",
      description:
        "Fair Seat Purchase HTTP API (Express on Lambda). PLACEHOLDER auth — add an authorizer before production.",
    });
    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new HttpLambdaIntegration("ApiIntegration", apiFn),
    });
    httpApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.ANY],
      integration: new HttpLambdaIntegration("RootIntegration", apiFn),
    });

    // ── Private S3 bucket for the static UI (never public). ─────────────────
    const siteBucket = new s3.Bucket(this, "FairSeatPurchaseSite", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY, // demo teardown
      autoDeleteObjects: true,
    });

    // ── CloudFront distribution (OAC) serving the private bucket over HTTPS. ─
    const distribution = new cloudfront.Distribution(this, "FairSeatPurchaseCdn", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      defaultRootObject: "index.html",
      comment: "Fair Seat Purchase static UI",
    });

    // ── Deploy the static assets, then overwrite config.js with the API URL. ─
    // Later sources win, so the generated config.js overrides the placeholder
    // one shipped in public/. BucketDeployment substitutes the CDK token
    // (httpApi.apiEndpoint) at deploy time.
    new s3deploy.BucketDeployment(this, "FairSeatPurchaseSiteDeploy", {
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
      sources: [
        s3deploy.Source.asset(PUBLIC_DIR),
        s3deploy.Source.data("config.js", `window.FSP_API_BASE="${httpApi.apiEndpoint}";`),
      ],
    });

    // ── Outputs. ────────────────────────────────────────────────────────────
    new CfnOutput(this, "SiteUrl", {
      value: `https://${distribution.distributionDomainName}`,
      description: "Public CloudFront URL for the Fair Seat Purchase UI.",
    });
    new CfnOutput(this, "ApiUrl", {
      value: httpApi.apiEndpoint,
      description: "API Gateway (HTTP API) invoke URL.",
    });
    new CfnOutput(this, "TableName", {
      value: TABLE_NAME,
      description: "DynamoDB table (imported, not managed by this stack).",
    });
  }
}
