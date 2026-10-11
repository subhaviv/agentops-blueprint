#!/usr/bin/env node
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import "source-map-support/register";

import { WorkloadNetworkStack } from "../apps/workload-account/lib/workload-network-stack";
import { WorkloadAppStack } from "../apps/workload-account/lib/workload-app-stack";

const app = new App();

const stage = app.node.tryGetContext("stage");
if (stage !== "workload") {
  throw new Error(
    `This repo only supports stage=workload. Got: '${stage ?? "(none)"}'. Pass --context stage=workload.`,
  );
}

function str(key: string): string | undefined {
  const v = app.node.tryGetContext(key);
  return typeof v === "string" ? v : undefined;
}

function strArr(key: string): string[] {
  const raw = app.node.tryGetContext(key);
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try { return JSON.parse(raw); } catch { return []; }
}

const workloadAccount = str("agenticai/workloadAccountId");
const region = str("agenticai/defaultRegion") ?? process.env.CDK_DEFAULT_REGION ?? "us-east-1";
const availabilityZones = strArr("agenticai/availabilityZones");

if (!workloadAccount) throw new Error("Missing context: agenticai/workloadAccountId");
if (availabilityZones.length < 2) throw new Error("Missing context: agenticai/availabilityZones (need ≥2)");

// Seed AZ cache so CDK skips live lookup during synth.
const azKey = `availability-zones:account=${workloadAccount}:region=${region}`;
if (!app.node.tryGetContext(azKey)) {
  app.node.setContext(azKey, availabilityZones);
}

const networkStack = new WorkloadNetworkStack(app, "agentops-Workload-NetworkStack", {
  env: { account: workloadAccount, region },
  vpcCidr: str("agenticai/vpcCidr"),
  availabilityZones,
});

const deployApp =
  app.node.tryGetContext("agenticai/deployWorkloadApp") === true ||
  app.node.tryGetContext("agenticai/deployWorkloadApp") === "true";

if (deployApp) {
  const appStack = new WorkloadAppStack(app, "agentops-Workload-AppStack", {
    env: { account: workloadAccount, region },
    vpc: networkStack.vpc,
    envName:    str("agenticai/envName")    ?? "nonprod",
    tenantId:   str("agenticai/tenantId")   ?? "lob",
    agentId:    str("agenticai/agentId")    ?? "primary",
    costCentre: str("agenticai/costCentre") ?? "engineering",
    agentImageUri:          str("agenticai/agentImageUri"),
    guardrailId:            str("agenticai/guardrailId"),
    externalUserPoolId:     str("agenticai/externalUserPoolId"),
    externalUserPoolClientId: str("agenticai/externalUserPoolClientId"),
    externalUserPoolRegion: str("agenticai/externalUserPoolRegion"),
    inferenceM2mSecretArn:  str("agenticai/inferenceM2mSecretArn"),
    inferenceGatewayUrl:    str("agenticai/inferenceGatewayUrl"),
    inferenceModelId:       str("agenticai/inferenceModelId"),
    notificationEmail:      str("agenticai/notificationEmail"),
  });
  appStack.addDependency(networkStack);
}

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
app.synth();
