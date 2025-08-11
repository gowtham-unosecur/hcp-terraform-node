import {
    IAMClient,
    CreateRoleCommand,
    PutRolePolicyCommand
} from "@aws-sdk/client-iam";
import {
    CloudWatchLogsClient,
    CreateLogGroupCommand
} from "@aws-sdk/client-cloudwatch-logs";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

// Load region from env
const REGION = process.env.UNOSECUR_AWS_REGION;
if (!REGION) {
    throw new Error("UNOSECUR_AWS_REGION is not set in .env file");
}

// Create AWS SDK clients
const iamClient = new IAMClient({
    region: REGION,
    credentials: {
        accessKeyId: process.env.UNOSECUR_ACCOUNT_KEY,
        secretAccessKey: process.env.UNOSECUR_ACCOUNT_SECRET
    }
});

const logsClient = new CloudWatchLogsClient({
    region: REGION,
    credentials: {
        accessKeyId: process.env.UNOSECUR_ACCOUNT_KEY,
        secretAccessKey: process.env.UNOSECUR_ACCOUNT_SECRET
    }
});

// Function to create resources for one customer
async function setupCustomerHcpStream(customerName, hcpAwsId, hcpExternalId) {
    const logGroupName = `hcp_log_${customerName}`;

    // 1. Create log group
    console.log(`\n[Step 1] Creating log group: ${logGroupName}`);
    await logsClient.send(new CreateLogGroupCommand({ logGroupName }));
    console.log(`✅ Log group created: ${logGroupName}`);

    // 2. Create IAM role trust policy
    const trustPolicy = {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${hcpAwsId}:root` },
                Action: "sts:AssumeRole",
                Condition: { StringEquals: { "sts:ExternalId": hcpExternalId } }
            }
        ]
    };

    const roleName = `${customerName}-hcp-cloudwatch-audit-role`;
    console.log(`[Step 2] Creating IAM Role: ${roleName}`);
    const roleResp = await iamClient.send(
        new CreateRoleCommand({
            RoleName: roleName,
            AssumeRolePolicyDocument: JSON.stringify(trustPolicy),
            Description: `Role for HCP audit log streaming from ${customerName}`
        })
    );
    console.log(`✅ IAM role created: ${roleResp.Role.Arn}`);

    // 3. Attach inline policy (⚠️ still broad — scope down in production)
    const logGroupPolicy = {
        Version: "2012-10-17",
        Statement: [
            {
                Effect: "Allow",
                Action: ["logs:*"],
                Resource: `*`
            }
        ]
    };

    await iamClient.send(
        new PutRolePolicyCommand({
            RoleName: roleName,
            PolicyName: `HCPCloudWatchWrite-${customerName}`,
            PolicyDocument: JSON.stringify(logGroupPolicy)
        })
    );
    console.log(`✅ Attached log group write policy to ${roleName}`);

    // Return details
    return {
        customerName,
        roleArn: roleResp.Role.Arn,
        logGroupName,
        region: REGION
    };
}

// Function to generate Terraform file
function generateMainTf({ customerName, roleArn, logGroupName, region }) {
    const roleName = roleArn.split("/")[1];

    const tfContent = `
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "${region}"
}

resource "aws_cloudwatch_log_group" "hcp_log" {
  name              = "${logGroupName}"
  retention_in_days = 30
}

resource "aws_iam_role" "hcp_audit_role" {
  name = "${roleName}"
}

output "destination_name" {
  value = "hcp-${customerName}"
}

output "role_arn" {
  value = "${roleArn}"
}

output "region" {
  value = "${region}"
}
`;

    const fileName = `main_${customerName}.tf`;
    fs.writeFileSync(fileName, tfContent.trim());
    console.log(`\n📄 Created Terraform file: ${fileName}`);

    console.log(`\nNext steps for the customer:`);
    console.log(`1. terraform init`);
    console.log(`2. terraform import aws_cloudwatch_log_group.hcp_log ${logGroupName}`);
    console.log(`3. terraform import aws_iam_role.hcp_audit_role ${roleArn}`);
}

// Main script execution
(async () => {
    const customers = [
        {
            name: "unosecur",
            hcpAwsId: "711430482607",
            hcpExternalId: "bc32915c9df94069a0d00e415eb9a7f4"
        }
    ];

    for (const c of customers) {
        try {
            const result = await setupCustomerHcpStream(c.name, c.hcpAwsId, c.hcpExternalId);
            generateMainTf(result);
        } catch (err) {
            console.error(`❌ Error processing ${c.name}:`, err);
        }
    }
})();