#!/usr/bin/env node
/**
 * CDK App entry for an LOB workload repo.
 *
 * Supports a single stage: `workload`
 *   - Deploys WorkloadNetworkStack (VPC + VPCEs) and WorkloadAppStack
 *     (AgentCore runtimes, ECR, API Gateway) into the workload account.
 *
 * All changes go through the S3WorkloadPipelineStack in the platform repo.
 * The LOB CI job uploads workload-source.zip to the platform-owned S3 bucket
 * on every merge to main; CodePipeline triggers automatically.
 *
 * Direct `cdk deploy` is only used for the initial pipeline bootstrap
 * (performed once by the platform team, not the LOB team).
 *
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: MIT-0
 */
import { App, Aspects } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import "source-map-support/register";

import { WorkloadNetworkStack } from "../apps/workload-account/lib/workload-network-stack";
import { WorkloadAppStack } from "../apps/workload-account/lib/workload-app-stack";
import { resolveDeploymentRegion } from "@agenticai/platform-baselines";

const app = new App();

const stage: string | undefined = app.node.tryGetContext("stage");

function deploymentRegion(): string {
  return resolveDeploymentRegion(
    process.env.CDK_DEFAULT_REGION,
    app.node.tryGetContext("agenticai/defaultRegion"),
  );
}

function stringArrayContext(key: string): readonly string[] {
  const raw = app.node.tryGetContext(key);
  if (raw === undefined) return [];
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Context '${key}' must be a JSON array of strings.`, { cause: error });
    }
  }
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string" || v.length === 0)) {
    throw new Error(`Context '${key}' must be a JSON array of non-empty strings.`);
  }
  return parsed;
}

if (stage !== "workload") {
  throw new Error(
    `This workload repo only supports stage=workload. Got: '${stage ?? "(none)"}'. ` +
    "Pass --context stage=workload.",
  );
}

const workloadAccount = app.node.tryGetContext("agenticai/workloadAccountId");
const availabilityZones = stringArrayContext("agenticai/availabilityZones");
const vpcCidr = app.node.tryGetContext("agenticai/vpcCidr");
const region = deploymentRegion();

const missing: string[] = [];
if (!workloadAccount) missing.push("agenticai/workloadAccountId");
if (availabilityZones.length < 2) missing.push("agenticai/availabilityZones (need ≥2)");
if (missing.length > 0) {
  throw new Error(`workload stage requires context keys: ${missing.join(", ")}`);
}

// Seed AZ context so CDK doesn't need to make a network call during synth.
const azKey = `availability-zones:account=${workloadAccount}:region=${region}`;
if (!app.node.tryGetContext(azKey)) {
  app.node.setContext(azKey, [...availabilityZones]);
}

const networkStack = new WorkloadNetworkStack(
  app,
  "agentops-Workload-NetworkStack",
  {
    env: { account: workloadAccount, region },
    vpcCidr,
    availabilityZones,
  },
);

const deployApp =
  app.node.tryGetContext("agenticai/deployWorkloadApp") === true ||
  app.node.tryGetContext("agenticai/deployWorkloadApp") === "true";

if (deployApp) {
  const tenantId  = String(app.node.tryGetContext("agenticai/tenantId")  ?? "lob");
  const agentId   = String(app.node.tryGetContext("agenticai/agentId")   ?? "primary");
  const costCentre = String(app.node.tryGetContext("agenticai/costCentre") ?? "engineering");
  const envName   = String(app.node.tryGetContext("agenticai/envName")   ?? "nonprod");

  const externalUserPoolId       = app.node.tryGetContext("agenticai/externalUserPoolId");
  const externalUserPoolClientId = app.node.tryGetContext("agenticai/externalUserPoolClientId");
  const externalUserPoolRegion   = app.node.tryGetContext("agenticai/externalUserPoolRegion");
  const auditOamSinkArn          = app.node.tryGetContext("agenticai/auditOamSinkArn");
  const notificationEmail        = app.node.tryGetContext("agenticai/notificationEmail");
  const monthlyBudgetUsd         = app.node.tryGetContext("agenticai/monthlyBudgetUsd");

  const appStack = new WorkloadAppStack(
    app,
    "agentops-Workload-AppStack",
    {
      env: { account: workloadAccount, region },
      vpcId: networkStack.vpc.vpc.vpcId,
      workloadSubnetIds: networkStack.vpc.vpc.selectSubnets({ subnetGroupName: "workload" }).subnetIds,
      workloadSubnetRouteTableIds: networkStack.vpc.vpc
        .selectSubnets({ subnetGroupName: "workload" })
        .subnets.map((s) => s.routeTable.routeTableId),
      vpcCidr: networkStack.vpc.vpc.vpcCidrBlock,
      availabilityZones: networkStack.vpc.vpc.availabilityZones,
      bedrockRuntimeVpceId: networkStack.vpc.endpoints.bedrockRuntime.vpcEndpointId,
      envName,
      tenantId,
      agentId,
      costCentre,
      externalUserPoolId:       typeof externalUserPoolId       === "string" ? externalUserPoolId       : undefined,
      externalUserPoolClientId: typeof externalUserPoolClientId === "string" ? externalUserPoolClientId : undefined,
      externalUserPoolRegion:   typeof externalUserPoolRegion   === "string" ? externalUserPoolRegion   : undefined,
      auditOamSinkArn:          typeof auditOamSinkArn          === "string" ? auditOamSinkArn          : undefined,
      notificationEmail:        typeof notificationEmail        === "string" ? notificationEmail        : undefined,
      monthlyBudgetUsd:         typeof monthlyBudgetUsd         === "number" ? monthlyBudgetUsd         : undefined,
      benefitsQaImageUri:
        typeof app.node.tryGetContext("agenticai/benefitsQaImageUri") === "string"
          ? String(app.node.tryGetContext("agenticai/benefitsQaImageUri"))
          : undefined,
      benefitsQaGuardrailId:
        typeof app.node.tryGetContext("agenticai/benefitsQaGuardrailId") === "string"
          ? String(app.node.tryGetContext("agenticai/benefitsQaGuardrailId"))
          : undefined,
      benefitsQaJwtAuthorizer:
        typeof externalUserPoolId === "string" && typeof externalUserPoolClientId === "string"
          ? {
              issuerUrl: `https://cognito-idp.${typeof externalUserPoolRegion === "string" ? externalUserPoolRegion : region}.amazonaws.com/${externalUserPoolId}`,
              allowedClients: [externalUserPoolClientId],
            }
          : undefined,
    },
  );
  appStack.addDependency(networkStack);
}

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
app.synth();
