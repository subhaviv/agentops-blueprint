#!/usr/bin/env node
import { App, Aspects, Stage, StageProps } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import "source-map-support/register";

import { WorkloadNetworkStack } from "../apps/workload-account/lib/workload-network-stack";
import { WorkloadAppStack } from "../apps/workload-account/lib/workload-app-stack";
import { Construct } from "constructs";

const app = new App();

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

const stage = app.node.tryGetContext("stage");
const pipelineSelection = str("agenticai/pipelineSelection");
const isPipelineMode = stage === "pipeline" && pipelineSelection === "workload";

if (stage !== "workload" && !isPipelineMode) {
  throw new Error(
    `This repo only supports stage=workload or stage=pipeline with agenticai/pipelineSelection=workload. Got stage='${stage ?? "(none)"}'.`,
  );
}

interface EnvConfig {
  account: string;
  region: string;
  availabilityZones: string[];
  envName: string;
}

function buildEnv(accountKey: string, azsKey: string, envName: string): EnvConfig | undefined {
  const account = str(accountKey);
  const azs = strArr(azsKey);
  if (!account || azs.length < 2) return undefined;
  return {
    account,
    region: str("agenticai/defaultRegion") ?? "us-east-1",
    availabilityZones: azs,
    envName,
  };
}

function seedAzContext(cfg: EnvConfig): void {
  const azKey = `availability-zones:account=${cfg.account}:region=${cfg.region}`;
  if (!app.node.tryGetContext(azKey)) {
    app.node.setContext(azKey, cfg.availabilityZones);
  }
}

function addStacks(scope: Construct, cfg: EnvConfig): void {
  const networkStack = new WorkloadNetworkStack(scope, "NetworkStack", {
    env: { account: cfg.account, region: cfg.region },
    vpcCidr: str("agenticai/vpcCidr"),
    availabilityZones: cfg.availabilityZones,
  });

  const deployApp =
    app.node.tryGetContext("agenticai/deployWorkloadApp") === true ||
    app.node.tryGetContext("agenticai/deployWorkloadApp") === "true";

  if (deployApp) {
    const appStack = new WorkloadAppStack(scope, "AppStack", {
      env: { account: cfg.account, region: cfg.region },
      vpc: networkStack.vpc,
      envName:    str("agenticai/envName")    ?? cfg.envName,
      tenantId:   str("agenticai/tenantId")   ?? "lob",
      agentId:    str("agenticai/agentId")    ?? "primary",
      costCentre: str("agenticai/costCentre") ?? "engineering",
      agentImageUri:            str("agenticai/agentImageUri") ?? str("agenticai/benefitsQaImageUri"),
      guardrailId:              str("agenticai/guardrailId"),
      externalUserPoolId:       str("agenticai/externalUserPoolId"),
      externalUserPoolClientId: str("agenticai/externalUserPoolClientId"),
      externalUserPoolRegion:   str("agenticai/externalUserPoolRegion"),
      inferenceM2mSecretArn:    str("agenticai/inferenceM2mSecretArn"),
      inferenceGatewayUrl:      str("agenticai/inferenceGatewayUrl"),
      inferenceModelId:         str("agenticai/inferenceModelId"),
      notificationEmail:        str("agenticai/notificationEmail"),
      auditOamSinkArn:          str("agenticai/auditOamSinkArn"),
    });
    appStack.addDependency(networkStack);
  }
}

if (isPipelineMode) {
  // Pipeline mode: produce assembly-*Nonprod and assembly-*Prod stage assemblies.
  const nonprod = buildEnv(
    "agenticai/workloadNonprodAccountId",
    "agenticai/workloadNonprodAvailabilityZones",
    "nonprod",
  );
  const prod = buildEnv(
    "agenticai/workloadProdAccountId",
    "agenticai/workloadProdAvailabilityZones",
    "prod",
  );

  if (!nonprod) throw new Error("Missing context: agenticai/workloadNonprodAccountId or workloadNonprodAvailabilityZones");
  if (!prod)    throw new Error("Missing context: agenticai/workloadProdAccountId or workloadProdAvailabilityZones");

  // Seed AZ context before any children are added to app.
  seedAzContext(nonprod);
  seedAzContext(prod);

  const nonprodStage = new Stage(app, "agentops-Workload-Nonprod", { env: { account: nonprod.account, region: nonprod.region } });
  addStacks(nonprodStage, nonprod);

  const prodStage = new Stage(app, "agentops-Workload-Prod", { env: { account: prod.account, region: prod.region } });
  addStacks(prodStage, prod);
} else {
  // Local workload mode: stacks directly on app.
  const account = str("agenticai/workloadAccountId") ?? str("agenticai/workloadNonprodAccountId");
  const region = str("agenticai/defaultRegion") ?? process.env.CDK_DEFAULT_REGION ?? "us-east-1";
  const availabilityZones = strArr("agenticai/availabilityZones").length >= 2
    ? strArr("agenticai/availabilityZones")
    : strArr("agenticai/workloadNonprodAvailabilityZones");

  if (!account) throw new Error("Missing context: agenticai/workloadAccountId");
  if (availabilityZones.length < 2) throw new Error("Missing context: agenticai/availabilityZones (need ≥2)");

  const cfg = { account, region, availabilityZones, envName: str("agenticai/envName") ?? "nonprod" };
  seedAzContext(cfg);
  addStacks(app, cfg);
}

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
app.synth();
