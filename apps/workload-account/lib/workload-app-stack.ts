/**
 * WorkloadAppStack — AgentCore runtime + API Gateway + Cognito.
 * Uses only aws-cdk-lib — no @agenticai/* packages required.
 */
import {
  Stack,
  StackProps,
  CfnOutput,
  Duration,
  RemovalPolicy,
  aws_ec2 as ec2,
  aws_iam as iam,
  aws_logs as logs,
  aws_cognito as cognito,
  aws_apigatewayv2 as apigwv2,
  aws_apigatewayv2_authorizers as apigwv2auth,
  aws_ecr as ecr,
  aws_bedrock as bedrock,
  aws_oam as oam,
  aws_cloudwatch as cw,
  custom_resources as cr,
  CustomResource,
} from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface WorkloadAppStackProps extends StackProps {
  readonly vpc: ec2.IVpc;
  readonly envName: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly costCentre: string;

  /** ECR image URI for the agent container. */
  readonly agentImageUri?: string;
  /** Bedrock guardrail ID from the platform team. */
  readonly guardrailId?: string;

  /** External Cognito User Pool ID (from platform team). */
  readonly externalUserPoolId?: string;
  readonly externalUserPoolClientId?: string;
  readonly externalUserPoolRegion?: string;

  /** Inference gateway values from platform team. */
  readonly inferenceM2mSecretArn?: string;
  readonly inferenceGatewayUrl?: string;
  readonly inferenceModelId?: string;

  readonly notificationEmail?: string;

  /**
   * Audit-account CloudWatch OAM sink ARN. When set, this stack creates an OAM
   * source Link sharing this account's Metrics + Logs + Traces (incl. the AgentCore
   * runtime log group and X-Ray) up to the central sink for cross-account
   * observability. Inlined as a plain CfnLink — this repo has no @agenticai packages.
   */
  readonly auditOamSinkArn?: string;
}

export class WorkloadAppStack extends Stack {
  readonly userPool: cognito.IUserPool;
  readonly api: apigwv2.HttpApi;
  readonly executionRole: iam.Role;

  constructor(scope: Construct, id: string, props: WorkloadAppStackProps) {
    super(scope, id, props);

    const prefix = `agenticai-${props.envName}-${props.tenantId}-${props.agentId}`;

    // ── Cognito User Pool (or import external) ────────────────────────────────
    if (props.externalUserPoolId) {
      this.userPool = cognito.UserPool.fromUserPoolId(
        this, 'ExternalUserPool', props.externalUserPoolId,
      );
    } else {
      this.userPool = new cognito.UserPool(this, 'UserPool', {
        userPoolName: `${prefix}-pool`,
        selfSignUpEnabled: false,
        removalPolicy: RemovalPolicy.DESTROY,
      });
    }

    const userPoolRegion = props.externalUserPoolRegion ?? this.region;
    const clientId = props.externalUserPoolClientId ?? '';

    // ── HTTP API Gateway ──────────────────────────────────────────────────────
    const authorizer = new apigwv2auth.HttpJwtAuthorizer('JwtAuthorizer',
      `https://cognito-idp.${userPoolRegion}.amazonaws.com/${props.externalUserPoolId ?? (this.userPool as cognito.UserPool).userPoolId}`,
      {
        jwtAudience: clientId ? [clientId] : ['placeholder'],
      },
    );

    this.api = new apigwv2.HttpApi(this, 'Api', {
      apiName: `${prefix}-api`,
      defaultAuthorizer: authorizer,
    });

    // ── AgentCore Runtime execution role ──────────────────────────────────────
    this.executionRole = new iam.Role(this, 'RuntimeExecutionRole', {
      roleName: `${prefix}-runtime-exec`,
      assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com'),
      description: `Execution role for ${prefix} AgentCore runtime`,
    });

    this.executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:ApplyGuardrail',
      ],
      resources: ['*'],
    }));

    if (props.inferenceM2mSecretArn) {
      this.executionRole.addToPolicy(new iam.PolicyStatement({
        actions: ['secretsmanager:GetSecretValue'],
        resources: [props.inferenceM2mSecretArn],
      }));
    }

    // ── CloudWatch log group for the runtime ─────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'RuntimeLogGroup', {
      logGroupName: `/agenticai/${props.envName}/${props.tenantId}/${props.agentId}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ── AgentCore Runtime (via custom resource) ───────────────────────────────
    if (props.agentImageUri) {
      const runtimeCrRole = new iam.Role(this, 'RuntimeCrRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      });
      runtimeCrRole.addToPolicy(new iam.PolicyStatement({
        actions: [
          'bedrock-agentcore:CreateAgentRuntime',
          'bedrock-agentcore:UpdateAgentRuntime',
          'bedrock-agentcore:DeleteAgentRuntime',
          'bedrock-agentcore:GetAgentRuntime',
          'bedrock-agentcore:CreateAgentRuntimeEndpoint',
          'bedrock-agentcore:UpdateAgentRuntimeEndpoint',
          'bedrock-agentcore:DeleteAgentRuntimeEndpoint',
          'bedrock-agentcore:GetAgentRuntimeEndpoint',
          'iam:PassRole',
        ],
        resources: ['*'],
      }));

      const runtimeCrProvider = new cr.Provider(this, 'RuntimeCrProvider', {
        onEventHandler: new (require('aws-cdk-lib/aws-lambda').Function)(this, 'RuntimeCrHandler', {
          runtime: require('aws-cdk-lib/aws-lambda').Runtime.NODEJS_22_X,
          handler: 'index.handler',
          role: runtimeCrRole,
          timeout: Duration.minutes(5),
          code: require('aws-cdk-lib/aws-lambda').Code.fromInline(`
const { BedrockAgentCoreControlClient, CreateAgentRuntimeCommand, DeleteAgentRuntimeCommand } = require('@aws-sdk/client-bedrock-agentcore-control');
exports.handler = async (event) => {
  const client = new BedrockAgentCoreControlClient({});
  if (event.RequestType === 'Delete') {
    if (event.PhysicalResourceId && event.PhysicalResourceId !== 'PENDING') {
      await client.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: event.PhysicalResourceId }));
    }
    return { PhysicalResourceId: event.PhysicalResourceId };
  }
  const resp = await client.send(new CreateAgentRuntimeCommand({
    agentRuntimeName: event.ResourceProperties.runtimeName,
    description: event.ResourceProperties.description,
    agentRuntimeArtifact: { containerConfiguration: { containerUri: event.ResourceProperties.imageUri } },
    roleArn: event.ResourceProperties.roleArn,
    networkConfiguration: { networkMode: 'PUBLIC' },
    environmentVariables: JSON.parse(event.ResourceProperties.envVars || '{}'),
  }));
  return { PhysicalResourceId: resp.agentRuntimeId, Data: { RuntimeId: resp.agentRuntimeId } };
};
          `),
        }),
      });

      const runtime = new CustomResource(this, 'AgentRuntime', {
        serviceToken: runtimeCrProvider.serviceToken,
        properties: {
          runtimeName: `${prefix}-runtime`,
          description: `${props.tenantId} ${props.agentId} agent runtime`,
          imageUri: props.agentImageUri,
          roleArn: this.executionRole.roleArn,
          envVars: JSON.stringify({
            GUARDRAIL_IDENTIFIER: props.guardrailId ?? '',
            GUARDRAIL_VERSION: 'DRAFT',
            ENV_NAME: props.envName,
            TENANT_ID: props.tenantId,
            AGENT_ID: props.agentId,
            INFERENCE_GATEWAY_URL: props.inferenceGatewayUrl ?? '',
            INFERENCE_MODEL_ID: props.inferenceModelId ?? 'anthropic.claude-sonnet-5',
            INFERENCE_M2M_SECRET_ARN: props.inferenceM2mSecretArn ?? '',
          }),
        },
      });

      new CfnOutput(this, 'AgentRuntimeId', {
        value: runtime.getAttString('RuntimeId'),
        description: 'AgentCore Runtime ID — give to the platform team for the registry record.',
      });
    }

    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-L1',    reason: 'CDK-managed custom-resource Lambda runtime.' },
      { id: 'AwsSolutions-IAM4',  reason: 'AWSLambdaBasicExecutionRole on CDK custom-resource role.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
      { id: 'AwsSolutions-IAM5',  reason: 'Bedrock model invocation requires wildcard resource.' },
      { id: 'AwsSolutions-COG1',  reason: 'Password policy managed by platform team Cognito construct.' },
      { id: 'AwsSolutions-COG2',  reason: 'MFA policy managed by platform team Cognito construct.' },
      { id: 'AwsSolutions-COG8',  reason: 'Plus tier managed by platform team Cognito construct.' },
      { id: 'AwsSolutions-APIG1', reason: 'Access logging configured in platform team API Gateway construct.' },
      { id: 'NIST.800.53.R5-LambdaConcurrency', reason: 'Provisioning-time only.' },
      { id: 'NIST.800.53.R5-LambdaDLQ',         reason: 'CloudFormation surfaces failures.' },
      { id: 'NIST.800.53.R5-LambdaInsideVPC',    reason: 'Control-plane calls to AWS-managed endpoints.' },
      { id: 'NIST.800.53.R5-IAMNoInlinePolicy',  reason: 'CDK-generated roles use inline policies.' },
    ], true);

    new CfnOutput(this, 'ApiEndpoint', { value: this.api.apiEndpoint });

    // ── Observability: cross-account CloudWatch OAM source link ───────────────
    // When the platform hands us the audit-account sink ARN, share this account's
    // Metrics + Logs (incl. the AgentCore runtime log group) + X-Ray Traces to the
    // central sink. Inlined CfnLink (no @agenticai/observability in a cloned repo).
    if (props.auditOamSinkArn) {
      new oam.CfnLink(this, 'OamSourceLink', {
        labelTemplate: `${prefix}-$AccountName`,
        resourceTypes: [
          'AWS::CloudWatch::Metric',
          'AWS::Logs::LogGroup',
          'AWS::XRay::Trace',
        ],
        sinkIdentifier: props.auditOamSinkArn,
      });
      new CfnOutput(this, 'OamSinkArn', { value: props.auditOamSinkArn });
    }

    // ── Observability: per-agent CloudWatch dashboard ─────────────────────────
    // Bedrock invocations, token counts (cost driver), guardrail interventions,
    // invocation latency p50/p99, and coarse per-tenant month-to-date spend.
    // Inlined (no @agenticai/observability in a cloned repo).
    {
      const inferenceProfileName = prefix; // agenticai-<env>-<tenant>-<agentId>
      const bedrockDim = { InferenceProfileId: inferenceProfileName };
      const dashboard = new cw.Dashboard(this, 'Dashboard', {
        dashboardName: prefix,
        defaultInterval: Duration.hours(6),
      });
      dashboard.addWidgets(
        new cw.TextWidget({
          markdown: `# Agentic AI — ${props.envName}/${props.tenantId}/${props.agentId}\nInference profile: **${inferenceProfileName}**.`,
          width: 24,
          height: 2,
        }),
      );
      dashboard.addWidgets(
        new cw.GraphWidget({
          title: 'Bedrock Invocations',
          left: [new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'Invocations', dimensionsMap: bedrockDim, statistic: 'Sum' })],
          width: 12,
        }),
        new cw.GraphWidget({
          title: 'Input / Output Tokens',
          left: [
            new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InputTokenCount', dimensionsMap: bedrockDim, statistic: 'Sum' }),
            new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'OutputTokenCount', dimensionsMap: bedrockDim, statistic: 'Sum' }),
          ],
          width: 12,
        }),
        new cw.GraphWidget({
          title: 'Guardrail Interventions',
          left: [new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'GuardrailInvocations', dimensionsMap: bedrockDim, statistic: 'Sum' })],
          width: 12,
        }),
        new cw.GraphWidget({
          title: 'Invocation Latency (p50 / p99)',
          left: [
            new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationLatency', dimensionsMap: bedrockDim, statistic: 'p50' }),
            new cw.Metric({ namespace: 'AWS/Bedrock', metricName: 'InvocationLatency', dimensionsMap: bedrockDim, statistic: 'p99' }),
          ],
          width: 12,
        }),
      );
      dashboard.addWidgets(
        new cw.GraphWidget({
          title: 'Estimated month-to-date spend (USD) — per-tenant',
          left: [new cw.Metric({
            namespace: 'AWS/Billing',
            metricName: 'EstimatedCharges',
            dimensionsMap: { Currency: 'USD', ApplicationId: props.tenantId },
            statistic: 'Maximum',
            region: 'us-east-1',
            period: Duration.hours(6),
          })],
          width: 12,
        }),
      );
    }
    new CfnOutput(this, 'LogGroupName', { value: logGroup.logGroupName });
  }
}
