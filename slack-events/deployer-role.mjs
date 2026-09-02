export const prefix = "alder-provibot-slack-events";
export const deployerRoleName = `${prefix}-deployer`;

export function deployerRoleArn(account) {
  return `arn:aws:iam::${account}:role/${deployerRoleName}`;
}

export function deployerTrust(account) {
  return {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: `arn:aws:iam::${account}:root` },
      Action: "sts:AssumeRole",
    }],
  };
}

export function deployerPolicy({ account, region }) {
  const roleArn = (name) => `arn:aws:iam::${account}:role/${name}`;
  const lambdaArn = (name) => `arn:aws:lambda:${region}:${account}:function:${name}`;
  const queueArn = (name) => `arn:aws:sqs:${region}:${account}:${name}`;
  const receiverSecretArn = `arn:aws:secretsmanager:${region}:${account}:secret:alder/pay/provibot/slack-events-receiver-*`;
  const tableArn = `arn:aws:dynamodb:${region}:${account}:table/${prefix}-state`;
  const runtimeRoles = [roleArn(`${prefix}-ingress-role`), roleArn(`${prefix}-worker-role`)];

  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ManageNamedExecutionRoles",
        Effect: "Allow",
        Action: ["iam:CreateRole", "iam:GetRole", "iam:PutRolePolicy"],
        Resource: runtimeRoles,
      },
      {
        Sid: "AttachOnlyLambdaRuntimePolicies",
        Effect: "Allow",
        Action: "iam:AttachRolePolicy",
        Resource: runtimeRoles,
        Condition: {
          ArnEquals: {
            "iam:PolicyARN": [
              "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
              "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole",
            ],
          },
        },
      },
      {
        Sid: "PassOnlyNamedRolesToLambda",
        Effect: "Allow",
        Action: "iam:PassRole",
        Resource: runtimeRoles,
        Condition: { StringEquals: { "iam:PassedToService": "lambda.amazonaws.com" } },
      },
      {
        Sid: "ManageNamedFunctions",
        Effect: "Allow",
        Action: [
          "lambda:AddPermission",
          "lambda:CreateFunction",
          "lambda:CreateFunctionUrlConfig",
          "lambda:GetFunction",
          "lambda:GetFunctionUrlConfig",
          "lambda:PutFunctionConcurrency",
          "lambda:UpdateFunctionCode",
          "lambda:UpdateFunctionConfiguration",
        ],
        Resource: [lambdaArn(`${prefix}-ingress`), lambdaArn(`${prefix}-worker`)],
      },
      {
        Sid: "CreateNamedQueueMappings",
        Effect: "Allow",
        Action: ["lambda:CreateEventSourceMapping"],
        Resource: "*",
        Condition: { ArnEquals: { "lambda:FunctionArn": lambdaArn(`${prefix}-worker`) } },
      },
      {
        // AWS evaluates ListEventSourceMappings without a function ARN in the
        // authorization context. It is read-only and required to find the
        // one existing mapping before deciding whether to create it.
        Sid: "ListQueueMappings",
        Effect: "Allow",
        Action: ["lambda:ListEventSourceMappings"],
        Resource: "*",
      },
      {
        Sid: "ManageNamedQueues",
        Effect: "Allow",
        Action: ["sqs:CreateQueue", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:SetQueueAttributes"],
        Resource: [queueArn(`${prefix}.fifo`)],
      },
      {
        Sid: "ManageReceiverConfiguration",
        Effect: "Allow",
        Action: ["secretsmanager:CreateSecret", "secretsmanager:DescribeSecret", "secretsmanager:PutSecretValue"],
        Resource: [receiverSecretArn],
      },
      {
        Sid: "ManageReceiverStateTable",
        Effect: "Allow",
        Action: ["dynamodb:CreateTable", "dynamodb:DescribeTable", "dynamodb:UpdateTimeToLive"],
        Resource: tableArn,
      },
    ],
  };
}
