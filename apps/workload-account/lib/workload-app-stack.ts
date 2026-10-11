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
          'bedrock:CreateAgentRuntime',
          'bedrock:UpdateAgentRuntime',
          'bedrock:DeleteAgentRuntime',
          'bedrock:GetAgentRuntime',
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
const { BedrockClient, CreateAgentRuntimeCommand, DeleteAgentRuntimeCommand } = require('@aws-sdk/client-bedrock');
exports.handler = async (event) => {
  const client = new BedrockClient({});
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
      { id: 'NIST.800.53.R5-LambdaConcurrency', reason: 'Provisioning-time only.' },
      { id: 'NIST.800.53.R5-LambdaDLQ',         reason: 'CloudFormation surfaces failures.' },
      { id: 'NIST.800.53.R5-LambdaInsideVPC',    reason: 'Control-plane calls to AWS-managed endpoints.' },
      { id: 'NIST.800.53.R5-IAMNoInlinePolicy',  reason: 'CDK-generated roles use inline policies.' },
    ], true);

    new CfnOutput(this, 'ApiEndpoint', { value: this.api.apiEndpoint });
    new CfnOutput(this, 'LogGroupName', { value: logGroup.logGroupName });
  }
}
