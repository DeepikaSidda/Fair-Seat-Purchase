#!/usr/bin/env node
/**
 * Fair Seat Purchase — CDK app entry point.
 *
 * Instantiates the {@link FairSeatPurchaseStack}. Account/region are taken from
 * the standard CDK environment variables (`CDK_DEFAULT_ACCOUNT` /
 * `CDK_DEFAULT_REGION`) which the CDK CLI populates from your active AWS
 * credentials/profile at synth/deploy time.
 *
 * Run via the `app` command in `cdk.json` (`npx tsx bin/app.ts`).
 */

import { App } from "aws-cdk-lib";

import { FairSeatPurchaseStack } from "../lib/fair-seat-purchase-stack.js";

const app = new App();

new FairSeatPurchaseStack(app, "FairSeatPurchaseStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
