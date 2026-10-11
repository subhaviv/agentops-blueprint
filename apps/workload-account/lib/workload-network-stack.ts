/**
 * WorkloadNetworkStack — VPC with private subnets and Bedrock VPC endpoints.
 * No IGW/NAT — all AWS API calls go through VPCEs.
 */
import {
  Stack,
  StackProps,
  CfnOutput,
  aws_ec2 as ec2,
  aws_logs as logs,
  aws_iam as iam,
  RemovalPolicy,
} from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface WorkloadNetworkStackProps extends StackProps {
  readonly vpcCidr?: string;
  readonly availabilityZones?: readonly string[];
}

export class WorkloadNetworkStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly vpceSecurityGroup: ec2.SecurityGroup;
  readonly bedrockRuntimeEndpoint: ec2.InterfaceVpcEndpoint;

  constructor(scope: Construct, id: string, props: WorkloadNetworkStackProps = {}) {
    super(scope, id, props);

    const cidr = props.vpcCidr ?? '10.0.0.0/16';
    const azs = props.availabilityZones
      ? [...props.availabilityZones]
      : undefined;

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(cidr),
      maxAzs: azs?.length ?? 2,
      availabilityZones: azs,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'workload',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    // Flow logs
    const flowLogGroup = new logs.LogGroup(this, 'VpcFlowLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const flowLogRole = new iam.Role(this, 'FlowLogRole', {
      assumedBy: new iam.ServicePrincipal('vpc-flow-logs.amazonaws.com'),
    });
    new ec2.FlowLog(this, 'FlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(flowLogGroup, flowLogRole),
    });

    // Security group for VPC endpoints
    this.vpceSecurityGroup = new ec2.SecurityGroup(this, 'VpceSecurityGroup', {
      vpc: this.vpc,
      description: 'Allow HTTPS from within the VPC to VPC endpoints',
      allowAllOutbound: false,
    });
    this.vpceSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(cidr),
      ec2.Port.tcp(443),
      'HTTPS from VPC',
    );

    // VPC Endpoints
    const endpointServices: { id: string; service: ec2.InterfaceVpcEndpointAwsService }[] = [
      { id: 'BedrockRuntime',      service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME },
      { id: 'BedrockAgent',        service: ec2.InterfaceVpcEndpointAwsService.BEDROCK_AGENT_RUNTIME },
      { id: 'SecretsManager',      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER },
      { id: 'CloudWatchLogs',      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS },
      { id: 'Ssm',                 service: ec2.InterfaceVpcEndpointAwsService.SSM },
    ];

    for (const { id, service } of endpointServices) {
      new ec2.InterfaceVpcEndpoint(this, `Vpce${id}`, {
        vpc: this.vpc,
        service,
        securityGroups: [this.vpceSecurityGroup],
        privateDnsEnabled: true,
      });
    }

    // S3 gateway endpoint (free, no SG needed)
    this.vpc.addGatewayEndpoint('S3GatewayEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // ECR endpoints (needed to pull images in isolated subnets)
    new ec2.InterfaceVpcEndpoint(this, 'VpceEcrApi', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      securityGroups: [this.vpceSecurityGroup],
      privateDnsEnabled: true,
    });
    this.bedrockRuntimeEndpoint = new ec2.InterfaceVpcEndpoint(this, 'VpceEcrDocker', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      securityGroups: [this.vpceSecurityGroup],
      privateDnsEnabled: true,
    });

    NagSuppressions.addStackSuppressions(this, [
      { id: 'AwsSolutions-L1',    reason: 'CDK-managed custom-resource Lambda runtime.' },
      { id: 'AwsSolutions-IAM4',  reason: 'AWSLambdaBasicExecutionRole on CDK custom-resource role.', appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'] },
      { id: 'NIST.800.53.R5-LambdaConcurrency', reason: 'Provisioning-time only.' },
      { id: 'NIST.800.53.R5-LambdaDLQ',         reason: 'CloudFormation surfaces failures.' },
      { id: 'NIST.800.53.R5-LambdaInsideVPC',    reason: 'Control-plane calls to AWS-managed endpoints.' },
      { id: 'NIST.800.53.R5-IAMNoInlinePolicy',  reason: 'CDK-generated roles use inline policies.' },
      { id: 'AwsSolutions-VPC7',  reason: 'Flow logs enabled above.' },
    ], true);

    new CfnOutput(this, 'VpcId',              { value: this.vpc.vpcId });
    new CfnOutput(this, 'VpceSecurityGroupId', { value: this.vpceSecurityGroup.securityGroupId });
  }
}
