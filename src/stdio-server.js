#!/usr/bin/env node

/**
 * Demo Env ServiceNow MCP - Stdio Transport
 *
 * Copyright (c) 2025 Vinay Kumar Biyani
 * Licensed under the MIT License - see LICENSE file for details
 */

import dotenv from 'dotenv';
import { pathToFileURL } from 'url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ServiceNowClient } from './servicenow-client.js';
import { createMcpServer } from './mcp-server-consolidated.js';
import { configManager } from './config-manager.js';

// Load environment variables
dotenv.config();

function booleanEnv(value) {
  return ['true', '1', 'yes'].includes(String(value || '').toLowerCase());
}

function hasServiceNowEnvCredentials(env = process.env) {
  return Boolean(env.SERVICENOW_INSTANCE_URL && env.SERVICENOW_USERNAME && env.SERVICENOW_PASSWORD);
}

export function shouldUseDocsOnlyMode(env = process.env) {
  return booleanEnv(env.HAPPY_MCP_DOCS_ONLY);
}

function docsOnlyExplicitlyDisabled(env = process.env) {
  return String(env.HAPPY_MCP_DOCS_ONLY || '').toLowerCase() === 'false';
}

function shouldFallbackToDocsOnly(error, env = process.env) {
  return !docsOnlyExplicitlyDisabled(env) &&
    !hasServiceNowEnvCredentials(env) &&
    /Missing ServiceNow credentials|servicenow-instances\.json not found/i.test(error.message);
}

export async function createConfiguredMcpServer({
  env = process.env,
  manager = configManager,
  ServiceNowClientClass = ServiceNowClient,
  createServer = createMcpServer
} = {}) {
  const startDocsOnly = async () => {
    console.error('📚 Starting Demo Env ServiceNow MCP in docs-only mode');
    return {
      server: await createServer(null, { docsOnly: true }),
      docsOnly: true,
      instance: null
    };
  };

  if (shouldUseDocsOnlyMode(env)) {
    return startDocsOnly();
  }

  // Get instance configuration (from SERVICENOW_INSTANCE env var or default)
  let instance;
  try {
    instance = manager.getInstanceOrDefault(env.SERVICENOW_INSTANCE);
  } catch (error) {
    if (shouldFallbackToDocsOnly(error, env)) {
      return startDocsOnly();
    }
    throw error;
  }

  console.error(`🔗 Default ServiceNow instance: ${instance.name} (${instance.url})`);
  console.error(`💡 Use SN-Set-Instance tool to switch instances during session`);

  // Create ServiceNow client
  const serviceNowClient = new ServiceNowClientClass(
    instance.url,
    instance.username,
    instance.password,
    {
      authType: instance.authType || 'basic',
      clientId: instance.clientId,
      clientSecret: instance.clientSecret,
      grantType: instance.grantType,
      scope: instance.scope
    }
  );
  serviceNowClient.currentInstanceName = instance.name;

  return {
    server: await createServer(serviceNowClient),
    docsOnly: false,
    instance
  };
}

export async function main() {
  try {
    const { server, docsOnly, instance } = await createConfiguredMcpServer();

    // Create stdio transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    console.error('Demo Env ServiceNow MCP (stdio) started successfully');
    if (docsOnly) {
      console.error('Mode: docs-only');
    } else {
      console.error(`Instance: ${instance.name} - ${instance.url}`);
    }
  } catch (error) {
    console.error('Failed to start Demo Env ServiceNow MCP:', error);
    process.exit(1);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main();
}
